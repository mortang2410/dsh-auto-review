/**
 * The session owner's own authorization, read from the session log.
 *
 * Auto-review stands in for a human who is not answering an approval prompt.
 * It must never overrule a human who IS answering. When the owner states
 * permission in their own message, the pending call settles as granted with no
 * reviewer and no risk-policy clamp: the human's words are the decision, so a
 * verdict that could disagree with them is not consulted at all.
 *
 * Attribution is by message source. A `user/message` event counts only when
 * its source carries the `user` kind — the source the harness's own input path
 * stamps on typed input. Scheduled prompts declare `schedule`, and every other
 * plugin declares its own kind, so an agent-authored prompt never reads as the
 * owner's voice. Known limit, pinned by a test: `dsh-client-auto-continue`
 * delivers its continuation text under the `user` kind too, so a host that
 * configures a continuation template containing a grant phrase ("go ahead")
 * would grant for the rest of that window; its shipped defaults do not.
 *
 * The window is the open turn plus the turn before it — the same span the
 * reviewer's own transcript window documents, because a grant a moment ago is
 * how the owner answers a call that was just blocked. A grant is turn-wide:
 * once the owner has said "make the PR", the calls that carry that out are the
 * calls they asked for, and singling out one of them for a second opinion would
 * reproduce the bug this module exists to remove.
 *
 * Three readings keep that rule honest. A later message that withdraws the
 * authorized action revokes an earlier grant ("make the PR" then "don't create
 * the PR"), while a refusal about something else ("don't worry about the tests")
 * leaves it standing. A negated permission statement is never a grant ("you have
 * no permission to push it"), because it contains the same words in the opposite
 * sense. And a bare "yes" counts only as a terse answer, not as part of a
 * statement about the code ("yes, the branch is main"), because the owner is
 * answering a question there, not authorizing work.
 * @module dsh-auto-review/authorization
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** How many turns back a grant is still read: the open turn and the one before it. */
export const AUTHORIZATION_TURNS = 2

/** How much of the owner's message the audit record keeps. */
const QUOTE_MAX_CHARS = 200

/**
 * Words that refuse or postpone an action. A clause carrying one grants
 * nothing, so "don't push it" is not read as permission to push.
 */
const REFUSAL = /\b(?:don['’]?t|do not|not yet|not now|not sure|hold (?:on|off)|wait|nope|never ?mind|cancel|abort|on second thought)\b/iu

/** A message that opens with "no" answers the previous proposal negatively. */
const LEADING_NO = /^\s*no\b/iu

/**
 * A negated permission statement: "you have no permission", "I have no
 * approval", "not approved". These contain the words the grant patterns look
 * for, so they are skipped before any pattern runs.
 */
const NEGATED = /\b(?:no|not|never|without)\b[^.!?\n]{0,24}\b(?:permission|approval|consent|authori[sz](?:ation|ed|e)|approved|allowed)\b/iu

/**
 * The grant forms that are a deliberate statement about the work in flight: an
 * explicit permission phrase, or an imperative that names the object it acts
 * on. A description of a problem ("the login page is broken") matches none of
 * them, so it authorizes nothing.
 */
const EXPLICIT: readonly RegExp[] = [
  // "I give you permission", "you have my approval", "permission granted".
  /\b(?:i|we|you)\s+(?:hereby\s+)?(?:give|gave|grant|granted|have|has|get|got)\b[^.!?\n]{0,40}\b(?:permission|approval|consent|authori[sz]ation)\b/iu,
  /\b(?:permission|approval|authori[sz]ation)\s+(?:is\s+|was\s+)?(?:granted|given)\b/iu,
  /\bmy\s+(?:(?:full|explicit|prior|written)\s+)?(?:permission|approval|consent|authori[sz]ation)\b/iu,
  // "you're authorized", "I'm authorized", "I authorize it", "I approve".
  /\b(?:you(?:'re| are)|i(?:'m| am))\s+(?:fully\s+)?(?:authori[sz]ed|approved)\b/iu,
  /\bi\s+(?:hereby\s+)?(?:authori[sz]e|approve)\b/iu,
  /\bapproved\b/iu,
  /\bgo\s+ahead\b/iu,
  /\bgo\s+for\s+it\b/iu,
  /\bgreen\s?light\b/iu,
  /\bproceed\b/iu,
  /\bdo\s+(?:it|that|this)\b/iu,
  /\bship\s+it\b/iu,
  /\bfull\s+speed\b/iu,
  // An imperative that names its object: "make the PR", "push it", "delete them".
  /\b(?:make|create|open|push|merge|send|publish|deploy|post|upload|delete|remove|drop|kill|restart|run|execute|install|commit|reset|force|write|edit|move|copy|rename|chmod|fix|apply|update|revert)\s+(?:the|a|an|this|that|these|those|it|its|it'?s|them|all|my|your)\b/iu,
]

/**
 * Bare affirmative answers ("yes", "sure"). Unlike the explicit forms these
 * also appear in ordinary statements, so one counts only when the clause is
 * terse and carries no copula or auxiliary: "yes, go ahead" answers, while
 * "yes, the branch is main" describes the code and grants nothing.
 */
const AFFIRMATIVES: readonly RegExp[] = [
  /\byes\b/iu,
  /\byeah\b/iu,
  /\byep\b/iu,
  /\bsure\b/iu,
  /\babsolutely\b/iu,
  /\bdefinitely\b/iu,
]

/** A copula or auxiliary marks a statement of fact rather than an answer. */
const DECLARATIVE = /\b(?:is|are|was|were|has|have|had|will|would|can|could|should|may|might|must)\b|['’](?:s|re|ll|ve|d)\b/iu

/** An affirmative answer is at most this many words; longer text carries content. */
const AFFIRMATIVE_MAX_WORDS = 8

/** Whether a clause reads as a bare answer rather than a statement of fact. */
function isBareAnswer(clause: string): boolean {
  return clause.split(/\s+/u).length <= AFFIRMATIVE_MAX_WORDS && !DECLARATIVE.test(clause)
}

/**
 * What the agent's question must mention for a bare "yes" to answer a decision
 * rather than a question of fact. "Is the branch main?" makes "yes" a fact;
 * "May I push it?" makes it an answer the owner meant as permission.
 */
const DECISION_QUESTION = /\b(?:may|can|could|should|shall|would|want|ready|ok|okay|approve|approval|permission|proceed|allow|go ahead)\b/iu

/**
 * Whether an affirmative answers a decision the agent put to the owner. With no
 * question in the window there is nothing to answer, and the terse clause
 * stands on its own.
 * @param question - the nearest earlier agent message, when one exists.
 * @returns true when a bare affirmative may count as a grant.
 */
function answersDecision(question: string | undefined): boolean {
  if (question === undefined) return true
  return question.includes('?') && DECISION_QUESTION.test(question)
}

/**
 * Extract the text a message carries.
 * @param content - the message's model-facing blocks.
 * @returns the joined text blocks, empty when the message is not text.
 */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('\n')
}

/**
 * The owner's own words that grant permission, when the text carries one.
 * @param text - one human message.
 * @param question - the agent's nearest earlier message, when the session has
 *   one; a bare affirmative only answers it.
 * @returns the granting clause, trimmed and truncated, or undefined.
 */
export function authorizationQuote(text: string, question?: string): string | undefined {
  if (LEADING_NO.test(text)) return undefined
  // Split on sentence and line ends, not commas: an imperative naming its
  // object ("make the PR") is often prefixed by an aside ("after lunch, ").
  for (const clause of text.split(/[.!?\n]+/u)) {
    const trimmed = clause.trim()
    if (trimmed === '' || REFUSAL.test(trimmed) || NEGATED.test(trimmed)) continue
    const explicit = EXPLICIT.some(pattern => pattern.test(trimmed))
    const affirmative = AFFIRMATIVES.some(pattern => pattern.test(trimmed))
      && isBareAnswer(trimmed)
      && answersDecision(question)
    if (!explicit && !affirmative) continue
    return trimmed.length <= QUOTE_MAX_CHARS ? trimmed : `${trimmed.slice(0, QUOTE_MAX_CHARS)}…`
  }
  return undefined
}

/** Verbs that name work a grant can be about. */
const WORK = /\b(?:make|create|open|push|merge|send|publish|deploy|post|upload|delete|remove|drop|kill|restart|run|execute|install|commit|reset|force|write|edit|move|copy|rename|chmod|fix|apply|update|revert|release|tag|close)\b/iu

/** Words that point back at the action under discussion instead of naming a new one. */
const ANAPHORA = /\b(?:it|them|those|these|that one|this one)\b/iu

/**
 * Function words, refusal vocabulary, and bare affirmatives: what a clause has
 * left after this filter names an object or an action.
 */
const FILLER = new Set<string>([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'to', 'of', 'for', 'on', 'in', 'at', 'by',
  'from', 'with', 'about', 'as', 'i', 'you', 'we', 'me', 'my', 'your', 'our', 'us', 'it', 'its', 'this',
  'that', 'these', 'those', 'them', 'there', 'here', 'please', 'just', 'now', 'yet', 'still', 'again',
  'too', 'also', 'very', 'really', 'ok', 'okay', 'do', 'does', 'did', 'done', 'be', 'am', 'is', 'are',
  'was', 'were', 'been', 'being', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'may',
  'might', 'must', 'dont', "don't", 'don’t', 'not', 'no', 'nope', 'never', 'wait', 'hold', 'off', 'mind',
  'cancel', 'abort', 'second', 'thought', 'sure',
])

/**
 * The words a clause carries once filler and refusal vocabulary are removed.
 * @param text - one clause.
 * @returns the lowercased content words, in order.
 */
function contentWords(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\u2019\s-]/gu, ' ')
    .split(/\s+/u)
    .filter(word => word !== '' && !FILLER.has(word))
}

/**
 * Whether the owner's message withdraws the action an earlier grant authorized.
 *
 * A refusal only revokes when it names work that is the granted action: the
 * same object ("don't create the PR"), or a pronoun pointing at it ("don't push
 * it"). A refusal of other work ("don't delete the logs", "don't run the
 * tests"), a worried aside ("don't worry about it"), and a leading "No" about
 * something else ("No, the tests are flaky") all leave the grant standing. A
 * message that carries nothing but a refusal ("no", "not yet", "wait") is the
 * owner stopping the work in flight, so it does revoke.
 * @param text - one later human message.
 * @param grant - the granting clause it might withdraw.
 * @returns true when the message withdraws that grant.
 */
export function revokesGrant(text: string, grant: string): boolean {
  const granted = new Set(contentWords(grant))
  if (contentWords(text).length === 0 && (LEADING_NO.test(text) || REFUSAL.test(text))) return true
  return text.split(/[.!?\n]+/u).some(clause => {
    if (!REFUSAL.test(clause) && !LEADING_NO.test(clause)) return false
    // The withdrawal has to name work — a worried aside does not — and that
    // work has to be the granted action, not some other task in the session.
    if (!WORK.test(clause)) return false
    if (ANAPHORA.test(clause)) return true
    return contentWords(clause).some(word => granted.has(word))
  })
}

/** One recorded human authorization. */
export interface UserAuthorization {
  /** The owner's granting words, bounded for the audit log. */
  readonly quote: string
  /** Seq of the message that carried them. */
  readonly seq: number
}

/**
 * Find the newest authorization the session owner stated in their own message,
 * inside the {@link AUTHORIZATION_TURNS} window.
 *
 * Only a top-level session has a human behind it: a subagent's session receives
 * its prompt as a `user`-kind message, so its "user" is another agent. A
 * delegated session therefore grants nothing and every call keeps its review.
 * @param events - the session's events, in log order.
 * @param delegationDepth - the session's delegation depth; anything above 0 is a
 *   delegated session and yields no authorization.
 * @returns the newest authorization in the window, or undefined.
 */
export function findUserAuthorization(events: readonly SessionEvent[], delegationDepth = 0): UserAuthorization | undefined {
  if (delegationDepth > 0) return undefined
  // Collect the window first: a bare affirmative needs the agent's question,
  // which sits before it, so the scan runs forward.
  const window: SessionEvent[] = []
  let closed = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/end') {
      closed += 1
      if (closed >= AUTHORIZATION_TURNS) break
    }
    window.push(event)
  }
  window.reverse()
  let question: string | undefined
  let granted: UserAuthorization | undefined
  let later: string[] = []
  for (const event of window) {
    if (event.type === 'assistant/message') {
      question = textOf((event.data as { message: { content: readonly ContentBlock[] } }).message.content)
      continue
    }
    if (event.type !== 'user/message') continue
    if (event.data.source?.kind !== 'user') continue
    const text = textOf(event.data.content)
    const quote = authorizationQuote(text, question)
    if (quote !== undefined) {
      granted = { quote, seq: event.seq }
      later = []
      continue
    }
    if (granted !== undefined) later.push(text)
  }
  if (granted === undefined) return undefined
  // A later message that withdraws this action revokes it: the owner changed
  // their mind, and continuing past it would settle on words they took back. A
  // later message that refuses something else leaves the grant standing.
  const withdrawn = later.some(message => revokesGrant(message, granted.quote))
  return withdrawn ? undefined : granted
}
