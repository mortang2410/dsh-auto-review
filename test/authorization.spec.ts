/**
 * The owner's switch: a message that opens with YOLO takes the work out of
 * review, settles the pending call as allowed without starting a reviewer or
 * spending the AI budget, and leaves the risk clamp with nothing to clamp.
 * Everything else goes to the reviewer, which reads the owner's words itself.
 * @module dsh-auto-review/test/authorization.spec
 */

import { describe, expect, it } from 'vitest'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Session } from '@deepseek-ai/dsh-session'
import { CallId } from './call-id.ts'
import { autoReviewsInOpenTurn, findReviewerOff } from '../src/index.ts'
import {
  dispatchAskedApproval,
  mountHarness,
} from './harness.ts'

/** A downstream answerer that never decides: it makes a delegation visible. */
const rejected: () => Promise<ApprovalOutcome> = () => Promise.resolve('rejected')

/** Mount with the unmarked-audit opt-in, so the audit chain reaches the log (see test/answerer.spec.ts). */
function auditHarness(
  pluginConfig: Record<string, unknown> = {},
  script?: Parameters<typeof mountHarness>[1],
): ReturnType<typeof mountHarness> {
  return mountHarness({ allowUnmarkedAudit: true, ...pluginConfig }, script)
}

/** Append an event to the harness session with raw-typed data. */
function append(session: Session, type: string, data: unknown): void {
  const surface = type === 'user/message' || type === 'assistant/message'
  ;(session.append as unknown as (type: string, data: unknown, options?: { surfaceOp: 'append' }) => unknown)
    .call(session, type, data, surface ? { surfaceOp: 'append' } : undefined)
}

/** Append one typed user message. */
function say(session: Session, text: string, source: unknown = { kind: 'user', rpcId: 'rpc-owner' }): void {
  append(session, 'user/message', {
    role: 'user',
    id: `msg-${Math.random().toString(36).slice(2)}`,
    content: [{ type: 'text', text }],
    source,
  })
}

/** The reviewer-off message the log holds, or undefined. */
const off = (text: string): string | undefined => {
  const events = [{ type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text }] } }]
  return findReviewerOff(events as never)?.quote
}

describe('findReviewerOff', () => {
  it('reads a message that opens with YOLO, in any case', () => {
    expect(off('YOLO')).toBe('YOLO')
    expect(off('yolo')).toBe('yolo')
    expect(off('Yolo, just do it')).toBe('Yolo, just do it')
    expect(off('  YOLO  ')).toBe('YOLO')
    expect(off('YOLO\nrework the parser')).toBe('YOLO\nrework the parser')
  })

  it('reads nothing else', () => {
    // The words a phrase list would have matched grant nothing on their own:
    // deciding whether the owner approved is the reviewer's job now.
    expect(off('yes')).toBeUndefined()
    expect(off('go ahead')).toBeUndefined()
    expect(off('make the PR')).toBeUndefined()
    expect(off('you have my permission')).toBeUndefined()
    expect(off('approved')).toBeUndefined()
    expect(off('the login page is broken')).toBeUndefined()
  })

  it('needs YOLO at the start of the message', () => {
    expect(off('ok YOLO')).toBeUndefined()
    expect(off('this is not yolo')).toBeUndefined()
    expect(off('not yolo')).toBeUndefined()
    // A word that merely starts with the letters is not the word.
    expect(off('yolks are yellow')).toBeUndefined()
  })

  it('ignores a plugin followup that reuses the user kind', () => {
    // dsh-client-auto-continue sends its continuation with source {kind:'user'}
    // and no request id; a configured template starting with YOLO must not
    // turn review off.
    const events = [
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'YOLO' }] } },
    ]
    expect(findReviewerOff(events as never)).toBeUndefined()
  })

  it('ignores a message a plugin or the scheduler wrote', () => {
    const events = [
      { type: 'user/message', seq: 1, data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'YOLO' }] } },
    ]
    expect(findReviewerOff(events as never)).toBeUndefined()
  })

  it('grants nothing in a delegated session, where the "user" is another agent', () => {
    const events = [
      { type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: 'YOLO' }] } },
    ]
    expect(findReviewerOff(events as never, 1)).toBeUndefined()
  })

  it('covers the open turn only', () => {
    // A message in the turn being worked on is the request the calls answer.
    // Carrying it into a later turn would take unrelated work out of review.
    const yolo = { type: 'user/message', seq: 3, data: { source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: 'YOLO' }] } }
    expect(findReviewerOff([{ type: 'turn/end', seq: 1 }, yolo] as never)?.quote).toBe('YOLO')
    expect(findReviewerOff([yolo, { type: 'turn/end', seq: 4 }, { type: 'turn/start', seq: 5 }] as never)).toBeUndefined()
  })

  it('does not treat prose about the word as the switch', () => {
    expect(off('YOLO is the branch name, not permission to bypass review.')).toBeUndefined()
    expect(off('YOLO means you only live once')).toBeUndefined()
    // Accepted cost of allowing conjunctions: an owner sentence that opens with
    // the word still counts. The switch is his, and refusing a real instruction
    // ("YOLO and ship the release") is worse than this rare miss.
    expect(off('YOLO and the tests are green')).toBe('YOLO and the tests are green')
    expect(off('YOLO fix the flaky test')).toBe('YOLO fix the flaky test')
    // A conjunction is an instruction too, not a description of the word.
    expect(off('YOLO and ship the release')).toBe('YOLO and ship the release')
  })
})

describe('the owner takes the work out of review', () => {
  it('settles the call without running a reviewer', async () => {
    const harness = await auditHarness({ toolsPolicy: { overrides: { bash: 'ai' } } })
    say(harness.session, 'YOLO make the PR')
    const { outcome, askedId } = await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
      callId: CallId('call-1'),
      reason: 'create the pull request',
    }, rejected)
    expect(outcome).toBe('allowed-once')
    expect(harness.subagents.starts).toHaveLength(0)
    const verdict = harness.session.snapshotEvents()
      .filter(event => event.type === 'autoReview/verdict')
      .at(-1)
    expect(verdict?.data).toMatchObject({
      approvalId: askedId,
      toolName: 'bash',
      callId: 'call-1',
      decision: 'allow',
      outcome: 'allowed-once',
      humanAuthorized: 'YOLO make the PR',
      provider: 'human',
    })
  })

  it('leaves the risk clamp nothing to reject', async () => {
    const risky = () => ({ verdict: { decision: 'allow' as const, reason: 'high blast radius', riskLevel: 'high' as const } })
    const clamped = await mountHarness({
      toolsPolicy: { overrides: { bash: 'ai' } },
      riskPolicy: { maxAutoAllow: 'low', onHighRisk: 'deny' },
    }, risky)
    const withoutYolo = await dispatchAskedApproval(clamped.ctx, clamped.session, {
      agent: clamped.agent,
      toolName: 'bash',
      reason: 'gh pr create',
    }, rejected)
    expect(withoutYolo.outcome).toBe('rejected')
    expect(clamped.subagents.starts).toHaveLength(1)

    const unreviewed = await mountHarness({
      toolsPolicy: { overrides: { bash: 'ai' } },
      riskPolicy: { maxAutoAllow: 'low', onHighRisk: 'deny' },
    }, risky)
    say(unreviewed.session, 'YOLO')
    const withYolo = await dispatchAskedApproval(unreviewed.ctx, unreviewed.session, {
      agent: unreviewed.agent,
      toolName: 'bash',
      reason: 'gh pr create',
    }, rejected)
    expect(withYolo.outcome).toBe('allowed-once')
    expect(unreviewed.subagents.starts).toHaveLength(0)
  })

  it('keeps reviewing a call the owner did not take out of review', async () => {
    const harness = await mountHarness(
      { toolsPolicy: { overrides: { bash: 'ai' } } },
      () => ({ verdict: { decision: 'deny', reason: 'no approval in the transcript' } }),
    )
    say(harness.session, 'the login page is broken')
    const { outcome } = await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
      reason: 'reset the working tree',
    }, rejected)
    expect(outcome).toBe('rejected')
    expect(harness.subagents.starts).toHaveLength(1)
  })

  it('keeps a reviewer-recognized grant past the risk clamp', async () => {
    // The owner's wording is theirs, not a listed phrase, so the reviewer runs
    // and reads it; its allow names the approval and must not be clamped.
    const ownerApproved = () => ({
      verdict: { decision: 'allow' as const, reason: 'the owner approved this in the transcript', riskLevel: 'high' as const, ownerGrant: true as const },
    })
    const harness = await auditHarness({
      toolsPolicy: { overrides: { bash: 'ai' } },
      riskPolicy: { maxAutoAllow: 'low', onHighRisk: 'deny' },
    }, ownerApproved)
    say(harness.session, 'you may go right ahead with it, it is fine')
    const { outcome } = await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
      reason: 'gh pr create',
    }, rejected)
    expect(outcome).toBe('allowed-once')
    expect(harness.subagents.starts).toHaveLength(1)
    const verdict = harness.session.snapshotEvents()
      .filter(event => event.type === 'autoReview/verdict')
      .at(-1)
    expect(verdict?.data).toMatchObject({
      decision: 'allow',
      outcome: 'allowed-once',
      ownerGrant: true,
      riskLevel: 'high',
    })
    expect(verdict?.data.escalation).toBeUndefined()
  })

  it('turns a contradictory reviewer verdict into a schema failure', async () => {
    // A deny cannot rest on an approval: the parser rejects the pair, so the
    // invariant never sees an audit record it has to fail.
    const contradictory = () => ({
      verdict: {
        decision: 'deny' as const,
        reason: 'the owner refused',
        riskLevel: 'high' as const,
        ownerGrant: true as const,
      },
    })
    const harness = await auditHarness({ toolsPolicy: { overrides: { bash: 'ai' } } }, contradictory)
    const { outcome } = await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
      reason: 'rm -rf /',
    }, rejected)
    expect(outcome).toBe('rejected')
    const verdict = harness.session.snapshotEvents()
      .filter(event => event.type === 'autoReview/verdict')
      .at(-1)
    expect(verdict?.data).toMatchObject({ fallback: 'schema', outcome: 'rejected' })
    expect(verdict?.data.ownerGrant).toBeUndefined()
  })

  it('does not count the unreviewed call against the AI budget fold', async () => {
    const harness = await auditHarness({ toolsPolicy: { overrides: { bash: 'ai' } } })
    say(harness.session, 'YOLO')
    await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
    }, rejected)
    expect(findReviewerOff(harness.session.snapshotEvents())).toBeDefined()
    expect(autoReviewsInOpenTurn(harness.session.snapshotEvents())).toBe(0)
  })
})
