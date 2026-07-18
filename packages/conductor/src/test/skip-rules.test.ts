// Skip-rules tests. Each rule is a pure function that takes context in
// and returns either null (no skip) or a SkipDecision. We construct
// minimal fixture context objects rather than wiring up the full DB —
// keeps the tests fast and the cause/effect crystal-clear.

import { describe, expect, it } from 'vitest'
import {
  consecutiveFailures,
  evaluateSkipRules,
  ruleAutoPaused,
  ruleCostThrottle,
  ruleFailureBackoff,
  ruleManualPaused,
  ruleMaxSessionsPerDay,
  ruleSkipDay,
  weekdayUtc,
  type SkipRuleContext,
} from '../skip-rules.js'
import {
  DEFAULT_AUTONOMY_CONFIG,
  type Project,
  type Session,
} from '@maestro/shared'
import type { CostAggregations } from '../repositories.js'

const ZERO_COSTS: CostAggregations = {
  monthCents: 0,
  todayCents: 0,
  perProject: [],
  dailySeries: [],
}

function fixtureProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    slug: 'p1',
    repoUrl: 'https://github.com/example/p1',
    autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG, scheduledEnabled: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    scheduledEnabled: true,
    autoPausedAt: null,
    autoPauseReason: null,
    ...overrides,
  }
}

function fixtureSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-' + Math.random().toString(36).slice(2),
    projectId: 'p1',
    status: 'completed',
    startedAt: '2026-05-01T08:00:00.000Z',
    endedAt: '2026-05-01T08:05:00.000Z',
    costCents: 5,
    promptVersion: '1.1.0',
    modelUsed: 'claude-opus',
    branchName: 'maestro/p1/x',
    prNumber: 1,
    prUrl: 'https://example.test/pr/1',
    journalPath: '.maestro/journal/2026-05-01-08-00-00.md',
    logPath: '/tmp/log',
    terminationCause: 'exit-clean',
    isFixupTurn: false,
    parentSessionId: null,
    ...overrides,
  }
}

function fixtureCtx(overrides: Partial<SkipRuleContext> = {}): SkipRuleContext {
  return {
    project: fixtureProject(),
    now: new Date('2026-05-04T12:00:00.000Z'), // a Monday
    sessionsToday: 0,
    recentSessions: [],
    costs: ZERO_COSTS,
    workingDir: null,
    developerName: 'Tester',
    monthlyBudgetUsd: 50,
    ...overrides,
  }
}

describe('weekdayUtc', () => {
  it('returns the right name for a known date', () => {
    expect(weekdayUtc(new Date('2026-05-04T12:00:00.000Z'))).toBe('monday')
    expect(weekdayUtc(new Date('2026-05-09T12:00:00.000Z'))).toBe('saturday')
    expect(weekdayUtc(new Date('2026-05-10T12:00:00.000Z'))).toBe('sunday')
  })
})

describe('rule D — auto-paused', () => {
  it('skips when auto_paused_at is set', () => {
    const ctx = fixtureCtx({
      project: fixtureProject({
        autoPausedAt: '2026-05-01T00:00:00.000Z',
        autoPauseReason: '5 consecutive failures',
      }),
    })
    const r = ruleAutoPaused(ctx)
    expect(r?.reason).toBe('auto-paused')
    expect(r?.notes).toContain('5 consecutive')
  })
  it('passes when no auto-pause', () => {
    expect(ruleAutoPaused(fixtureCtx())).toBeNull()
  })
})

describe('rule manual-paused (autonomy.level=paused)', () => {
  it('skips paused projects', () => {
    const ctx = fixtureCtx({
      project: fixtureProject({
        autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG, level: 'paused' },
      }),
    })
    expect(ruleManualPaused(ctx)?.reason).toBe('manual-paused')
  })
})

describe('rule C — skip-day', () => {
  it('skips on a weekday in skipDays', () => {
    const ctx = fixtureCtx({
      project: fixtureProject({
        autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG, skipDays: ['monday', 'sunday'] },
      }),
      now: new Date('2026-05-04T12:00:00.000Z'), // Monday
    })
    const r = ruleSkipDay(ctx)
    expect(r?.reason).toBe('skip-day')
    expect(r?.notes).toContain('monday')
  })
  it('passes on non-skip weekdays', () => {
    const ctx = fixtureCtx({
      project: fixtureProject({
        autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG, skipDays: ['saturday', 'sunday'] },
      }),
      now: new Date('2026-05-04T12:00:00.000Z'), // Monday
    })
    expect(ruleSkipDay(ctx)).toBeNull()
  })
})

describe('rule B — max sessions per day', () => {
  it('skips when at the cap', () => {
    const ctx = fixtureCtx({ sessionsToday: 6 })
    const r = ruleMaxSessionsPerDay(ctx)
    expect(r?.reason).toBe('max-sessions-per-day')
  })
  it('passes when below the cap', () => {
    expect(ruleMaxSessionsPerDay(fixtureCtx({ sessionsToday: 5 }))).toBeNull()
  })
})

describe('rule F — failure backoff', () => {
  it('skips after 3 consecutive failures', () => {
    const ctx = fixtureCtx({
      recentSessions: [
        fixtureSession({ status: 'failed', prNumber: null, journalPath: null }),
        fixtureSession({ status: 'failed', prNumber: null, journalPath: null }),
        fixtureSession({ status: 'quality-gate-failed', prNumber: null }),
      ],
    })
    expect(ruleFailureBackoff(ctx)?.reason).toBe('failure-backoff')
  })
  it('passes when 2 failures + 1 success', () => {
    const ctx = fixtureCtx({
      recentSessions: [
        fixtureSession({ status: 'failed', prNumber: null }),
        fixtureSession({ status: 'failed', prNumber: null }),
        fixtureSession({ status: 'completed', prNumber: 1 }),
      ],
    })
    expect(ruleFailureBackoff(ctx)).toBeNull()
  })
  it('completed-no-changes does NOT count as failure', () => {
    const ctx = fixtureCtx({
      recentSessions: [
        fixtureSession({ status: 'completed-no-changes', prNumber: null }),
        fixtureSession({ status: 'completed-no-changes', prNumber: null }),
        fixtureSession({ status: 'completed-no-changes', prNumber: null }),
      ],
    })
    expect(ruleFailureBackoff(ctx)).toBeNull()
  })
})

describe('rule E — cost throttle', () => {
  it('skips priority=low at >=80%', () => {
    const ctx = fixtureCtx({
      project: fixtureProject({
        autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG, priority: 'low' },
      }),
      monthlyBudgetUsd: 50,
      costs: { ...ZERO_COSTS, monthCents: 4100 }, // $41 / $50 = 82%
    })
    expect(ruleCostThrottle(ctx)?.reason).toBe('cost-throttle-low-priority')
  })
  it('does NOT skip priority=normal at 82%', () => {
    const ctx = fixtureCtx({
      monthlyBudgetUsd: 50,
      costs: { ...ZERO_COSTS, monthCents: 4100 },
    })
    expect(ruleCostThrottle(ctx)).toBeNull()
  })
  it('skips ALL priorities at >=95%', () => {
    const ctx = fixtureCtx({
      monthlyBudgetUsd: 50,
      costs: { ...ZERO_COSTS, monthCents: 4750 }, // 95%
    })
    expect(ruleCostThrottle(ctx)?.reason).toBe('cost-throttle-budget-exceeded')
  })
})

describe('consecutiveFailures', () => {
  it('counts failures starting from newest, stops at first success', () => {
    const sessions = [
      fixtureSession({ status: 'failed', prNumber: null }),
      fixtureSession({ status: 'failed', prNumber: null }),
      fixtureSession({ status: 'completed', prNumber: 1 }),
      fixtureSession({ status: 'failed', prNumber: null }),
    ]
    expect(consecutiveFailures(sessions)).toBe(2)
  })
  it('returns 0 when most recent is a success', () => {
    expect(
      consecutiveFailures([fixtureSession({ status: 'completed', prNumber: 1 })]),
    ).toBe(0)
  })
  it('skips fixup turns so a completed fixup cannot mask a failed parent (ENG-02)', () => {
    const sessions = [
      fixtureSession({ status: 'completed', prNumber: 2, isFixupTurn: true }),
      fixtureSession({ status: 'failed', prNumber: null }),
      fixtureSession({ status: 'failed', prNumber: null }),
      fixtureSession({ status: 'failed', prNumber: null }),
    ]
    // The leading completed *fixup* must be skipped, not treated as a success
    // that breaks the streak — the three failed parents still count.
    expect(consecutiveFailures(sessions)).toBe(3)
  })
})

describe('evaluateSkipRules — composition', () => {
  it('auto-paused short-circuits before cost throttle', async () => {
    const ctx = fixtureCtx({
      project: fixtureProject({
        autoPausedAt: '2026-05-01T00:00:00.000Z',
        autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG, priority: 'low' },
      }),
      costs: { ...ZERO_COSTS, monthCents: 4900 },
      monthlyBudgetUsd: 50,
    })
    const r = await evaluateSkipRules(ctx)
    expect(r?.reason).toBe('auto-paused')
  })
  it('returns null when nothing fires', async () => {
    const r = await evaluateSkipRules(fixtureCtx())
    expect(r).toBeNull()
  })
  it('skip-day fires before max-per-day even when both true', async () => {
    const ctx = fixtureCtx({
      project: fixtureProject({
        autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG, skipDays: ['monday'] },
      }),
      sessionsToday: 100,
    })
    const r = await evaluateSkipRules(ctx)
    expect(r?.reason).toBe('skip-day')
  })
})
