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
 * Three readings keep that rule honest. A later message that refuses without
 * granting revokes an earlier grant ("make the PR" then "don't create the
 * PR"). A negated permission statement is never a grant ("you have no
 * permission to push it"), because it contains the same words in the opposite
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
const DECLARATIVE = /\b(?:is|are|was|were|has|have|had|will|would|can|could|should|may|might|must)\b/iu

/** An affirmative answer is at most this many words; longer text carries content. */
const AFFIRMATIVE_MAX_WORDS = 8

/** Whether a clause reads as a bare answer rather than a statement of fact. */
function isBareAnswer(clause: string): boolean {
  return clause.split(/\s+/u).length <= AFFIRMATIVE_MAX_WORDS && !DECLARATIVE.test(clause)
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
 * @returns the granting clause, trimmed and truncated, or undefined.
 */
export function authorizationQuote(text: string): string | undefined {
  if (LEADING_NO.test(text)) return undefined
  // Split on sentence and line ends, not commas: an imperative naming its
  // object ("make the PR") is often prefixed by an aside ("after lunch, ").
  for (const clause of text.split(/[.!?\n]+/u)) {
    const trimmed = clause.trim()
    if (trimmed === '' || REFUSAL.test(trimmed) || NEGATED.test(trimmed)) continue
    if (!EXPLICIT.some(pattern => pattern.test(trimmed)) && !(AFFIRMATIVES.some(pattern => pattern.test(trimmed)) && isBareAnswer(trimmed))) continue
    return trimmed.length <= QUOTE_MAX_CHARS ? trimmed : `${trimmed.slice(0, QUOTE_MAX_CHARS)}…`
  }
  return undefined
}

/**
 * Whether the owner's message withdraws or refuses something. A message that
 * grants nothing but states a refusal revokes any earlier grant in the window:
 * "make the PR" followed by "don't create the PR" is not still a grant.
 * @param text - one human message.
 * @returns true when the message refuses, postpones, or denies.
 */
export function statesRefusal(text: string): boolean {
  if (LEADING_NO.test(text)) return true
  return text.split(/[.!?\n]+/u).some(clause => REFUSAL.test(clause))
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
  let closed = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/end') {
      closed += 1
      if (closed >= AUTHORIZATION_TURNS) return undefined
      continue
    }
    if (event.type !== 'user/message') continue
    if (event.data.source?.kind !== 'user') continue
    const text = textOf(event.data.content)
    const quote = authorizationQuote(text)
    if (quote !== undefined) return { quote, seq: event.seq }
    // A later refusal revokes an earlier grant: the owner changed their mind,
    // and continuing past this message would settle on words they withdrew.
    if (statesRefusal(text)) return undefined
  }
  return undefined
}
