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
 * The grant forms that address the agent directly: a permission phrase, or an
 * imperative that names the object it acts on. A description of a problem ("the
 * login page is broken") matches none of them, so it authorizes nothing.
 *
 * These may sit anywhere in a clause because each one carries an addressee of
 * its own — "you", "my", or a verb in the imperative — so its presence is the
 * act. The assent words below do not, which is why they are separated.
 */
const EXPLICIT: readonly RegExp[] = [
  // "I give you permission", "you have my approval", "permission granted".
  /\b(?:i|we|you)\s+(?:hereby\s+)?(?:give|gave|grant|granted|have|has|get|got)\b[^.!?\n]{0,40}\b(?:permission|approval|consent|authori[sz]ation)\b/iu,
  /\b(?:permission|approval|authori[sz]ation)\s+(?:is\s+|was\s+)?(?:granted|given)\b/iu,
  /\bmy\s+(?:(?:full|explicit|prior|written)\s+)?(?:permission|approval|consent|authori[sz]ation)\b/iu,
  // "you're authorized", "I'm authorized", "I authorize it", "I approve".
  /\b(?:you(?:'re| are)|i(?:'m| am))\s+(?:fully\s+)?(?:authori[sz]ed|approved)\b/iu,
  /\bi\s+(?:hereby\s+)?(?:authori[sz]e|approve)\b/iu,
  /\bgreen\s?light\b/iu,
  /\bfull\s+speed\b/iu,
  // An imperative that names its object: "make the PR", "push it", "delete them".
  /\b(?:make|create|open|push|merge|send|publish|deploy|post|upload|delete|remove|drop|kill|restart|run|execute|install|commit|reset|force|write|edit|move|copy|rename|chmod|fix|apply|update|revert)\s+(?:the|a|an|this|that|these|those|it|its|it'?s|them|all|my|your)\b/iu,
]

/**
 * Assent words: the owner's go-ahead in its shortest form.
 *
 * Each of these is also an ordinary English word, so its presence is not the
 * act of permitting: "the approved build is on main", "I will do it tomorrow",
 * "the tests will proceed automatically", "legal approved the change" all
 * mention assent while granting nothing. One counts only when the clause reads
 * as the owner speaking to the agent — terse, with no statement of fact and no
 * third-party subject in front of it — or when the phrase itself opens the
 * clause ("go ahead and push the branch").
 */
const ASSENT: readonly RegExp[] = [
  // "approved" as a one-word answer, never "pre-approved", "unapproved", or
  // "approved the change" where something else did the approving.
  /(?<![\w-])approved\b(?!\s+(?:it|them|him|her|us|the|this|that|these|those|a|an|by|for|in|on)\b)/iu,
  /\byes\b(?:(?!\bi['’](?:ll|m)\b|\bi will\b|\bi am\b)[^.!?\n]){0,40}\bgive\s+(?:it|them|you)\b(?!\s+(?:a|another)\s+(?:try|shot))/iu,
  /\bgo\s+ahead\b/iu,
  /\bgo\s+for\s+it\b/iu,
  /\bproceed\b/iu,
  /\bdo\s+(?:it|that|this)\b/iu,
  /\bship\s+it\b/iu,
]

/**
 * A clause that opens with anything but the owner addressing the agent: a
 * third party ("the team approved", "we ship it on fridays"), a thing ("the tests
 * proceed"), or a determiner. An assent word after one of these describes the world instead of
 * answering the agent.
 */
const NOT_ADDRESSED = /^(?:he|she|it|they|we|one|someone|somebody|nobody|everyone|everything|the|a|an|this|that|these|those|my|our|his|her|their|its|there)\b/iu

/** Whether an assent word in this clause is the owner speaking, not a mention. */
function isAssent(clause: string): boolean {
  if (NOT_ADDRESSED.test(clause)) return false
  const match = ASSENT.map(pattern => pattern.exec(clause)).find(found => found !== null)
  if (match === undefined) return false
  if (isBareAnswer(clause)) return true
  // A phrase that opens the clause addresses the agent however long the clause
  // runs: "go ahead and push the branch once the tests pass".
  return match.index === clause.search(/\S/u) && !DECLARATIVE.test(clause)
}

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

/**
 * A copula or auxiliary marks a statement of fact rather than an answer, and so
 * does a first-person intention: "yes, I'm going to give it a go" describes what
 * the owner will do, it does not hand the work to the agent.
 */
const DECLARATIVE = /\b(?:is|are|was|were|am|has|have|had|will|would|can|could|should|may|might|must)\b|['’](?:s|re|ll|ve|d)\b|['’]m\s+(?:going|gonna)\b/iu

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

/** One matched grant: its words, and the question a bare answer was answering. */
interface GrantMatch {
  /** The granting clause, trimmed and truncated for the audit log. */
  readonly quote: string
  /**
   * For a bare affirmative, the agent's question it answered. The grant covers
   * only calls that question named; an explicit grant names its own action.
   */
  readonly subject?: string
}

/**
 * Match the owner's granting words in one message.
 * @param text - one human message.
 * @param question - the agent's nearest earlier message; `''` when the window
 *   holds none, which disqualifies a bare affirmative. `undefined` means the
 *   caller has no transcript at all (the standalone parser contract).
 * @returns the match, or undefined.
 */
function matchGrant(text: string, question?: string): GrantMatch | undefined {
  if (LEADING_NO.test(text)) return undefined
  // Split on sentence and line ends, not commas: an imperative naming its
  // object ("make the PR") is often prefixed by an aside ("after lunch, ").
  for (const clause of text.split(/[.!?\n]+/u)) {
    const trimmed = clause.trim()
    if (trimmed === '' || REFUSAL.test(trimmed) || NEGATED.test(trimmed)) continue
    const quote = trimmed.length <= QUOTE_MAX_CHARS ? trimmed : `${trimmed.slice(0, QUOTE_MAX_CHARS)}…`
    if (EXPLICIT.some(pattern => pattern.test(trimmed))) return { quote }
    if (isAssent(trimmed)) return { quote }
    if (!AFFIRMATIVES.some(pattern => pattern.test(trimmed)) || !isBareAnswer(trimmed)) continue
    if (!answersDecision(question)) continue
    return question === undefined ? { quote } : { quote, subject: question }
  }
  return undefined
}

/**
 * The owner's own words that grant permission, when the text carries one.
 * @param text - one human message.
 * @param question - the agent's nearest earlier message, when the session has
 *   one; a bare affirmative only answers it.
 * @returns the granting clause, trimmed and truncated, or undefined.
 */
export function authorizationQuote(text: string, question?: string): string | undefined {
  return matchGrant(text, question)?.quote
}

/**
 * Work verbs grouped by the action they perform. A withdrawal has to name the
 * same action as the grant: "don't create the PR" withdraws "make the PR",
 * while "don't close the PR" is a different operation on the same object.
 */
const ACTION_CLASSES: readonly (readonly string[])[] = [
  ['make', 'create', 'open', 'build', 'produce', 'generate', 'draft'],
  ['push', 'merge', 'send', 'publish', 'deploy', 'upload', 'post', 'release', 'tag', 'share'],
  ['delete', 'remove', 'drop', 'kill', 'close', 'destroy', 'discard', 'rm'],
  ['write', 'edit', 'update', 'fix', 'apply', 'patch', 'change', 'rewrite'],
  ['run', 'execute', 'install', 'commit', 'reset', 'force', 'revert', 'restart', 'test'],
]

/** Words that point back at an earlier noun instead of naming one. */
const ANAPHORS = new Set<string>(['it', 'them', 'those', 'these', 'that', 'this'])
const PLURAL_ANAPHORS = new Set<string>(['them', 'those', 'these'])

/** Words that start an object phrase or a new clause rather than name the object. */
const PREPOSITION = new Set<string>(['of', 'for', 'about', 'on', 'in', 'at', 'to', 'with', 'from', 'by', 'and', 'or', 'but'])

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

/** The index of the action class a word belongs to, or -1. */
function actionClass(word: string): number {
  return ACTION_CLASSES.findIndex(group => group.includes(word))
}

/** Whether a word reads as a plural noun: "logs" is, "pr" and "address" are not. */
function isPlural(word: string): boolean {
  return word.endsWith('s') && !word.endsWith('ss')
}

/** Verbs that deliver a created thing; a creation grant covers them too. */
const DELIVERY = new Set<string>(['push', 'merge', 'send', 'publish', 'deploy', 'upload', 'post', 'release', 'tag', 'share'])

/** The creation class, whose grants extend to {@link DELIVERY}. */
const CREATE_CLASS = 0

/** A parsed action: what is done, and to what. */
interface ParsedAction {
  /** The work verb itself. */
  readonly verb: string
  /** Index into {@link ACTION_CLASSES}. */
  readonly classIndex: number
  /** The object's head noun when the clause names one. */
  readonly object?: string
  /** The pronoun's number when the object is a pronoun instead of a noun. */
  readonly anaphor?: 'singular' | 'plural'
}

/**
 * Read the action a clause performs: its work verb, then the object it names
 * or the pronoun standing in for it.
 * @param clause - one sentence of a message.
 * @returns the parsed action, or undefined when the clause names no work.
 */
function parseAction(clause: string): ParsedAction | undefined {
  const words = clause
    .toLowerCase()
    .replace(/[^a-z0-9'\u2019\s-]/gu, ' ')
    .split(/\s+/u)
    .filter(word => word !== '')
  const verbIndex = words.findIndex(word => actionClass(word) >= 0)
  if (verbIndex < 0) return undefined
  const tail = words.slice(verbIndex + 1)
  const anaphorWord = tail.find(word => ANAPHORS.has(word))
  const object = tail.find(word => !FILLER.has(word) && !PREPOSITION.has(word) && !ANAPHORS.has(word) && !word.startsWith('-'))
  return {
    verb: words[verbIndex]!,
    classIndex: actionClass(words[verbIndex]!),
    ...object === undefined ? {} : { object },
    ...anaphorWord === undefined ? {} : { anaphor: PLURAL_ANAPHORS.has(anaphorWord) ? 'plural' : 'singular' },
  }
}

/**
 * Whether two actions are the same work: the same class, or a creation grant
 * being carried out by delivering what was created.
 * @param granted - the action the grant authorizes.
 * @param other - the action being compared to it.
 * @returns true when they are the same job.
 */
function sameWork(granted: ParsedAction, other: ParsedAction): boolean {
  if (other.classIndex === granted.classIndex) return true
  return granted.classIndex === CREATE_CLASS && DELIVERY.has(other.verb)
}

/**
 * Resolve a pronoun to the noun it points at, searching the owner's own words
 * backwards. Number agreement is what keeps "them" on the logs the owner
 * mentioned instead of the singular PR they later mentioned.
 * @param history - earlier human messages, oldest first, the grant included.
 * @param number - the pronoun's number.
 * @returns the head noun, or undefined when nothing agrees.
 */
function resolveAntecedent(history: readonly string[], number: 'singular' | 'plural'): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const words = contentWords(history[index]!)
    for (let wordIndex = words.length - 1; wordIndex >= 0; wordIndex -= 1) {
      const word = words[wordIndex]!
      if (actionClass(word) >= 0) continue
      if ((number === 'plural') === isPlural(word)) return word
    }
  }
  return undefined
}

/**
 * Whether the owner's message withdraws the action an earlier grant authorized.
 *
 * A refusal only revokes when it names the same operation: the same action class
 * and the same object ("don't create the PR"), or a pronoun that resolves to the
 * grant's object ("don't push it"). A refusal of other work ("don't delete the
 * logs", "don't run the tests"), a refusal of the same object through another
 * action ("don't close the PR"), a worried aside ("don't worry about it"), and a
 * leading "No" about something else ("No, the tests are flaky") all leave the
 * grant standing. A message that carries nothing but a refusal ("no", "not yet")
 * is the owner stopping the work in flight, so it does revoke.
 * @param text - one later human message.
 * @param grant - the granting clause it might withdraw.
 * @param history - the owner's earlier messages in the window, oldest first,
 *   the granting message included; pronouns resolve against it.
 * @returns true when the message withdraws that grant.
 */
export function revokesGrant(text: string, grant: string, history: readonly string[] = [grant]): boolean {
  if (contentWords(text).length === 0 && (LEADING_NO.test(text) || REFUSAL.test(text))) return true
  const granted = parseAction(grant)
  if (granted === undefined) return false
  return text.split(/[.!?\n]+/u).some(clause => {
    if (!REFUSAL.test(clause) && !LEADING_NO.test(clause)) return false
    const refusal = parseAction(clause)
    if (refusal === undefined) return false
    if (!sameWork(granted, refusal)) return false
    if (refusal.anaphor !== undefined) {
      return resolveAntecedent(history, refusal.anaphor) === granted.object
    }
    if (refusal.object === undefined || granted.object === undefined) return false
    return refusal.object === granted.object
  })
}

/**
 * Whether a bare answer's grant covers the pending call: the question that was
 * answered has to name something this call is about. "May I delete the logs
 * now?" answers for a call that mentions logs, not for `gh pr create`.
 * @param subject - the agent's question the owner answered.
 * @param requestText - the pending tool name, reason, and arguments.
 * @returns true when the question names part of the request.
 */
export function grantCoversRequest(subject: string, requestText: string): boolean {
  const asked = parseAction(subject)
  if (asked === undefined) return false
  const request = parseAction(requestText)
  if (request === undefined) return false
  // The same verb is the same act on whatever it is applied to. Otherwise the
  // objects have to agree too: "delete the logs" answers an rm of the logs,
  // not an rm of the secrets, and never a merge of another branch.
  if (asked.verb === request.verb) return true
  if (asked.classIndex !== request.classIndex) return false
  return asked.object !== undefined && asked.object === request.object
}

/** One recorded human authorization. */
export interface UserAuthorization {
  /** The owner's granting words, bounded for the audit log. */
  readonly quote: string
  /** Seq of the message that carried them. */
  readonly seq: number
  /** The question a bare affirmative answered; the grant is scoped to it. */
  readonly subject?: string
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
  // No agent message yet reads as the empty question: a bare affirmative with
  // nothing to answer grants nothing.
  let question = ''
  let granted: UserAuthorization | undefined
  let spoken: string[] = []
  let atGrant: string[] = []
  let later: string[] = []
  for (const event of window) {
    if (event.type === 'assistant/message') {
      question = textOf((event.data as { message: { content: readonly ContentBlock[] } }).message.content)
      continue
    }
    if (event.type !== 'user/message') continue
    if (event.data.source?.kind !== 'user') continue
    const text = textOf(event.data.content)
    spoken.push(text)
    const match = matchGrant(text, question)
    if (match !== undefined) {
      granted = { quote: match.quote, seq: event.seq, ...match.subject === undefined ? {} : { subject: match.subject } }
      atGrant = [...spoken]
      later = []
      continue
    }
    if (granted !== undefined) later.push(text)
  }
  if (granted === undefined) return undefined
  // A later message that withdraws this action revokes it: the owner changed
  // their mind, and continuing past it would settle on words they took back. A
  // later message that refuses something else leaves the grant standing.
  const withdrawn = later.some((message, index) => revokesGrant(message, granted!.quote, [...atGrant, ...later.slice(0, index)]))
  return withdrawn ? undefined : granted
}
