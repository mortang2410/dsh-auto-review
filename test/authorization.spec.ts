/**
 * Human authorization tests: which of the owner's own words grant permission,
 * which never do, and what the answerer does with a grant — settle the call as
 * allowed without running a reviewer, without spending the AI budget, and
 * without letting the risk policy downgrade it.
 * @module dsh-auto-review/test/authorization.spec
 */

import { describe, expect, it } from 'vitest'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Session } from '@deepseek-ai/dsh-session'
import { CallId } from './call-id.ts'
import { authorizationQuote, autoReviewsInOpenTurn, findUserAuthorization } from '../src/index.ts'
import {
  dispatchAskedApproval,
  mountHarness,
} from './harness.ts'

/** The grant the session owner typed, or undefined. */
const grant = (text: string): string | undefined => authorizationQuote(text)

/** A downstream answerer that never grants: it makes a delegation visible. */
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
  const surface = type === 'user/message'
  ;(session.append as unknown as (type: string, data: unknown, options?: { surfaceOp: 'append' }) => unknown)
    .call(session, type, data, surface ? { surfaceOp: 'append' } : undefined)
}

/** Append one typed user message. */
function say(session: Session, text: string, id = `msg-${Math.random().toString(36).slice(2)}`, source: unknown = { kind: 'user' }): void {
  append(session, 'user/message', {
    role: 'user',
    id,
    content: [{ type: 'text', text }],
    source,
  })
}

describe('authorizationQuote', () => {
  it('reads the grant the owner actually typed when the reviewer refused it', () => {
    // The two messages from the 2026-11-11 incident: a 'gh pr create' was
    // denied four times against both of them.
    expect(grant('YES I FUCKIGN GIVE IT / GO')).toBe('YES I FUCKIGN GIVE IT / GO')
    expect(grant('MAKE THE PR')).toBe('MAKE THE PR')
  })

  it('reads explicit permission phrases', () => {
    expect(grant('you have my permission')).toBeDefined()
    expect(grant('I give you permission to run it')).toBeDefined()
    expect(grant('permission granted')).toBeDefined()
    expect(grant("you're authorized")).toBeDefined()
    expect(grant('I approve')).toBeDefined()
    expect(grant('approved')).toBeDefined()
  })

  it('reads affirmative answers', () => {
    expect(grant('yes')).toBeDefined()
    expect(grant('yeah do it')).toBeDefined()
    expect(grant('go ahead')).toBeDefined()
    expect(grant('go for it')).toBeDefined()
    expect(grant('sure, proceed')).toBeDefined()
    expect(grant('green light')).toBeDefined()
    expect(grant('ship it')).toBeDefined()
  })

  it('reads an imperative that names what to act on', () => {
    expect(grant('push it')).toBeDefined()
    expect(grant('delete them')).toBeDefined()
    expect(grant('open the PR and merge it')).toBeDefined()
    expect(grant('run the full test suite')).toBeDefined()
  })

  it('refuses to read a description, a question, or a refusal as a grant', () => {
    expect(grant('the login page is broken')).toBeUndefined()
    expect(grant('why did the build fail?')).toBeUndefined()
    expect(grant('what is the current status')).toBeUndefined()
    expect(grant("don't push it")).toBeUndefined()
    expect(grant('no, do not run that')).toBeUndefined()
    expect(grant('not yet')).toBeUndefined()
    expect(grant('hold on')).toBeUndefined()
    expect(grant('wait for me')).toBeUndefined()
    expect(grant('never mind')).toBeUndefined()
    expect(grant('not sure about that')).toBeUndefined()
  })

  it('reads the granting clause of a mixed message, not the refusal beside it', () => {
    expect(grant("don't worry about the tests. make the PR")).toBe('make the PR')
    // A refusal in the same clause suppresses it.
    expect(grant('yes but not yet')).toBeUndefined()
  })

  it('refuses a negated permission statement', () => {
    // These carry the words a grant pattern looks for, in the opposite sense.
    expect(grant('you have no permission to push it')).toBeUndefined()
    expect(grant('I have no approval for that')).toBeUndefined()
    expect(grant('not approved')).toBeUndefined()
    expect(grant('you are not authorized to do that')).toBeUndefined()
  })

  it('reads a bare affirmative only as an answer, not inside a statement of fact', () => {
    expect(grant('yes')).toBeDefined()
    expect(grant('yes please')).toBeDefined()
    // The owner answered a factual question; that is not a grant.
    expect(grant('Yes, the branch is main')).toBeUndefined()
    expect(grant('sure, the build was green yesterday')).toBeUndefined()
  })

  it('bounds the recorded quote', () => {
    const quote = grant(`yes ${'x'.repeat(500)}`)
    expect(quote).toBeDefined()
    expect(quote!.length).toBeLessThanOrEqual(201)
    expect(quote!.endsWith('…')).toBe(true)
  })
})

describe('findUserAuthorization', () => {
  it('reads only the owner-worded messages, never a plugin injection', async () => {
    const harness = await mountHarness()
    append(harness.session, 'turn/start', { turn: 2 })
    say(harness.session, 'make the PR', 'scheduled', { kind: 'schedule' })
    expect(findUserAuthorization(harness.session.snapshotEvents())).toBeUndefined()
    say(harness.session, 'make the PR', 'typed')
    expect(findUserAuthorization(harness.session.snapshotEvents())).toMatchObject({ quote: 'make the PR' })
  })

  it('stops at the configured turn window', async () => {
    const harness = await mountHarness()
    say(harness.session, 'yes go ahead', 'old')
    append(harness.session, 'turn/end', { turn: 1 })
    append(harness.session, 'turn/start', { turn: 2 })
    append(harness.session, 'turn/end', { turn: 2 })
    append(harness.session, 'turn/start', { turn: 3 })
    // Two closed turns behind the open one: outside the window.
    expect(findUserAuthorization(harness.session.snapshotEvents())).toBeUndefined()
  })

  it('grants nothing in a delegated session, where the "user" is another agent', async () => {
    const harness = await mountHarness()
    say(harness.session, 'make the PR')
    expect(findUserAuthorization(harness.session.snapshotEvents(), 1)).toBeUndefined()
  })

  it('revokes an earlier grant when the owner later refuses', async () => {
    const harness = await mountHarness()
    append(harness.session, 'turn/start', { turn: 1 })
    say(harness.session, 'make the PR')
    append(harness.session, 'turn/end', { turn: 1 })
    append(harness.session, 'turn/start', { turn: 2 })
    say(harness.session, "don't create the PR")
    // The later message withdraws the grant; the older words do not survive it.
    expect(findUserAuthorization(harness.session.snapshotEvents())).toBeUndefined()
  })
})

describe('the answerer honours the owner', () => {
  it('grants an authorized call without running a reviewer', async () => {
    const harness = await auditHarness({ toolsPolicy: { overrides: { bash: 'ai' } } })
    say(harness.session, 'MAKE THE PR')
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
      humanAuthorized: 'MAKE THE PR',
      provider: 'human',
    })
  })

  it('lets the owner overrule the risk clamp that would otherwise reject the allow', async () => {
    const risky = () => ({ verdict: { decision: 'allow' as const, reason: 'high blast radius', riskLevel: 'high' as const } })
    const clamped = await mountHarness({
      toolsPolicy: { overrides: { bash: 'ai' } },
      riskPolicy: { maxAutoAllow: 'low', onHighRisk: 'deny' },
    }, risky)
    const withoutGrant = await dispatchAskedApproval(clamped.ctx, clamped.session, {
      agent: clamped.agent,
      toolName: 'bash',
      reason: 'gh pr create',
    }, rejected)
    expect(withoutGrant.outcome).toBe('rejected')
    expect(clamped.subagents.starts).toHaveLength(1)

    const granted = await mountHarness({
      toolsPolicy: { overrides: { bash: 'ai' } },
      riskPolicy: { maxAutoAllow: 'low', onHighRisk: 'deny' },
    }, risky)
    say(granted.session, 'YES I GIVE IT / GO')
    const withGrant = await dispatchAskedApproval(granted.ctx, granted.session, {
      agent: granted.agent,
      toolName: 'bash',
      reason: 'gh pr create',
    }, rejected)
    expect(withGrant.outcome).toBe('allowed-once')
    expect(granted.subagents.starts).toHaveLength(0)
  })

  it('keeps reviewing a call the owner did not authorize', async () => {
    const harness = await mountHarness(
      { toolsPolicy: { overrides: { bash: 'ai' } } },
      () => ({ verdict: { decision: 'deny', reason: 'no grant covers this' } }),
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

  it('sends a revoked grant back to the reviewer', async () => {
    const harness = await mountHarness(
      { toolsPolicy: { overrides: { bash: 'ai' } } },
      () => ({ verdict: { decision: 'deny', reason: 'the owner withdrew the grant' } }),
    )
    append(harness.session, 'turn/start', { turn: 1 })
    say(harness.session, 'make the PR')
    append(harness.session, 'turn/end', { turn: 1 })
    append(harness.session, 'turn/start', { turn: 2 })
    say(harness.session, "don't create the PR")
    const { outcome } = await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
      reason: 'gh pr create',
    }, rejected)
    expect(outcome).toBe('rejected')
    expect(harness.subagents.starts).toHaveLength(1)
  })

  it('keeps a reviewer-recognized grant past the risk clamp', async () => {
    // The owner's wording is not in the pattern list, so the reviewer runs and
    // sees it; its allow names the grant and must not be clamped.
    const riskyGrant = () => ({
      verdict: { decision: 'allow' as const, reason: 'the owner granted this in the transcript', riskLevel: 'high' as const, ownerGrant: true as const },
    })
    const harness = await auditHarness({
      toolsPolicy: { overrides: { bash: 'ai' } },
      riskPolicy: { maxAutoAllow: 'low', onHighRisk: 'deny' },
    }, riskyGrant)
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

  it('does not count a grant against the AI budget fold', async () => {
    const harness = await auditHarness({ toolsPolicy: { overrides: { bash: 'ai' } } })
    say(harness.session, 'go ahead')
    await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
    }, rejected)
    // No reviewer ran, so the one verdict in the open turn spends nothing.
    expect(findUserAuthorization(harness.session.snapshotEvents())).toBeDefined()
    expect(autoReviewsInOpenTurn(harness.session.snapshotEvents())).toBe(0)
  })

})
