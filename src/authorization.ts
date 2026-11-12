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
 * Attribution is by message source. A `user/message` event counts only when
 * its source carries the `user` kind, the source the harness's own input path
 * stamps on typed input. Scheduled prompts declare `schedule`, and every other
 * plugin declares its own kind, so an agent-authored prompt never reads as the
 * owner's voice.
 *
 * The window is the open turn plus the turn before it, the same span the
 * reviewer's own transcript window documents.
 * @module dsh-auto-review/authorization
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** How many turns back a reviewer-off message is still read. */
export const REVIEWER_OFF_TURNS = 2

/** How much of the owner's message the audit record keeps. */
const QUOTE_MAX_CHARS = 200

/**
 * The one phrasing this module still matches itself: a message that opens with
 * YOLO, which the owner uses to mean "do not review this". Case does not
 * matter, and leading whitespace is ignored because a pasted prompt carries it.
 */
const REVIEWER_OFF = /^\s*yolo\b/iu

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
  let closed = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/end') {
      closed += 1
      if (closed >= REVIEWER_OFF_TURNS) break
    }
    window.push(event)
  }
  let found: ReviewerOff | undefined
  for (const event of window.reverse()) {
    if (event.type !== 'user/message') continue
    if (event.data.source?.kind !== 'user') continue
    const text = textOf(event.data.content).trim()
    if (!REVIEWER_OFF.test(text)) continue
    const quote = text.length <= QUOTE_MAX_CHARS ? text : `${text.slice(0, QUOTE_MAX_CHARS)}…`
    found = { quote, seq: event.seq }
  }
  return found
}
