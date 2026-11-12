/**
 * The session owner's own switch for the auto reviewer, read from the session
 * log.
 *
 * Auto-review stands in for a human who is not answering an approval prompt.
 * It must never overrule a human who IS answering, so the owner settles a call
 * in one of two ways. They open a message with YOLO, which turns the reviewer
 * off for the work that message covers: they have said, in their own words,
 * that they do not want this reviewed. Or they say something approving, and
 * the reviewer reads it as a person would and allows it, because judging what
 * counts as personal approval is a question about intent, and a phrase list
 * answers a question about vocabulary instead (see ./review.ts).
 *
 * Attribution is by message source. A `user/message` event counts only when it
 * came through the harness's own input path, which stamps the `user` kind plus
 * the prompt request id it was admitted under. Scheduled prompts declare
 * `schedule`; a plugin that calls followup can pass the bare `user` kind
 * (`dsh-client-auto-continue` does), and the missing request id is what keeps
 * that continuation from reading as the owner's own words.
 *
 * The window is the open turn alone: the message that opens with YOLO is the
 * one the calls in flight answer, and carrying it into a later turn would
 * authorise work it never mentioned.
 * @module dsh-auto-review/authorization
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** How much of the owner's message the audit record keeps. */
const QUOTE_MAX_CHARS = 200

/**
 * The one phrasing this module still matches itself: a message that opens with
 * YOLO, which the owner uses to mean "do not review this". Case does not
 * matter, and leading whitespace is ignored because a pasted prompt carries it.
 *
 * A message that opens with the word while talking about the word is not that
 * instruction: "YOLO is the branch name" describes a string, and a linking
 * verb after it marks the sentence as prose rather than a request. Conjunctions
 * are deliberately absent from that list: "YOLO and ship the release" is an
 * instruction, and refusing it would deny the owner his own switch.
 */
const REVIEWER_OFF = /^\s*yolo\b(?!\s+(?:is|are|was|were|means?|stood|stands?|sounds?|looks?|just|only|refers?|as)\b)/iu

/** One recorded reviewer-off message. */
export interface ReviewerOff {
  /** The owner's words, bounded for the audit log. */
  readonly quote: string
  /** Seq of the message that carried them. */
  readonly seq: number
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
 * Find the newest message in which the session owner turned the reviewer off.
 * @param events - the session's events, in log order.
 * @param delegationDepth - the session's delegation depth; anything above 0 is
 *   a delegated session, whose "user" is another agent, and yields nothing.
 * @returns the message, or undefined when the owner did not say YOLO.
 */
export function findReviewerOff(events: readonly SessionEvent[], delegationDepth = 0): ReviewerOff | undefined {
  if (delegationDepth > 0) return undefined
  const window: SessionEvent[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/end') break
    window.push(event)
  }
  let found: ReviewerOff | undefined
  for (const event of window.reverse()) {
    if (event.type !== 'user/message') continue
    // The owner's typed input carries the prompt request id the interactive
    // client stamped on it. A plugin that calls followup with a bare `user`
    // source (dsh-client-auto-continue does exactly that) is indistinguishable
    // from a typed message by kind alone, so the id is what separates them.
    const source = event.data.source as { kind?: string; rpcId?: unknown } | undefined
    if (source?.kind !== 'user' || typeof source.rpcId !== 'string') continue
    const text = textOf(event.data.content).trim()
    if (!REVIEWER_OFF.test(text)) continue
    const quote = text.length <= QUOTE_MAX_CHARS ? text : `${text.slice(0, QUOTE_MAX_CHARS)}…`
    found = { quote, seq: event.seq }
  }
  return found
}
