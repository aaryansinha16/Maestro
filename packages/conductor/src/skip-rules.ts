// Skip rules — the deterministic gate between a cron tick and a queued
// job. Each rule is a pure function that takes the current state and
// returns either `null` (no skip) or `{ reason, notes? }` (skip).
//
// Order matters: rules are layered cheapest first so we don't pay for
// a git fetch when the project is already auto-paused. The scheduler
// runs them in this order:
//
//   D (auto-paused)             — DB lookup, free
//   C (skip-day)                — date math, free
//   B (max-sessions-per-day)    — single SQL count, cheap
//   F (failure-backoff)         — single SQL select, cheap
//   E (cost throttling)         — runs CostRepository.aggregate(), cheap
//   A (developer-recently-active) — git log on the working clone, slowest
//
// All rules emit a typed `ScheduleSkipReason`; the scheduler logs them
// to `scheduled_runs` with action='skipped' so "why didn't Maestro fire
// this morning?" has a single audit log to consult.

import { execa } from 'execa'
import {
  COST_THROTTLE_ALL_FRACTION,
  COST_THROTTLE_LOW_FRACTION,
  DEFAULT_DEVELOPER_ACTIVITY_WINDOW_HOURS,
  DEFAULT_MONTHLY_BUDGET_USD,
  FAILURE_BACKOFF_THRESHOLD,
  WEEKDAYS,
  type Project,
  type ScheduleSkipReason,
  type Session,
  type Weekday,
} from '@maestro/shared'
import type { CostAggregations } from './repositories.js'

// ─── Public surface ──────────────────────────────────────────────────

export interface SkipDecision {
  reason: ScheduleSkipReason
  /** Optional human-readable note logged alongside the reason. */
  notes?: string
}

/**
 * Inputs the scheduler hands to {@link evaluateSkipRules}. Keeping it
 * a plain object (no class) makes mocking trivial in tests.
 */
export interface SkipRuleContext {
  project: Project
  /** UTC instant when this evaluation runs. Injected for test determinism. */
  now: Date
  /** Sessions for this project today (UTC). Used by rule B. */
  sessionsToday: number
  /**
   * The most recent N sessions for this project (newest first), used by
   * rule F (failure backoff). The scheduler should pass at least
   * FAILURE_BACKOFF_THRESHOLD + a generous margin.
   */
  recentSessions: Session[]
  /** Pre-aggregated costs (Phase 1.5 `CostRepository.aggregate()`). */
  costs: CostAggregations
  /**
   * Absolute path to this project's working clone. Used by rule A to
   * shell out to `git log`. When null, rule A is skipped (no clone yet).
   */
  workingDir: string | null
  /** Git committer name to filter "developer activity" by. */
  developerName: string
  /** Optional override for the activity window in hours. */
  developerActivityWindowHours?: number
  /** Monthly budget in USD; falls back to DEFAULT_MONTHLY_BUDGET_USD. */
  monthlyBudgetUsd?: number
}

/**
 * Run every skip rule in the layered order described above. Returns the
 * first rule that fires, or `null` when the tick should proceed to
 * enqueue a job.
 */
export async function evaluateSkipRules(ctx: SkipRuleContext): Promise<SkipDecision | null> {
  // Rule D: auto-paused. Cheapest; if set, nothing else matters.
  const autoPaused = ruleAutoPaused(ctx)
  if (autoPaused) return autoPaused

  // The autonomy 'paused' level is a manual pause that should also block
  // scheduled runs. Treat as its own reason so the dashboard can label it.
  const manualPaused = ruleManualPaused(ctx)
  if (manualPaused) return manualPaused

  // Rule C: skip-day.
  const skipDay = ruleSkipDay(ctx)
  if (skipDay) return skipDay

  // Rule B: max sessions per day cap.
  const maxPerDay = ruleMaxSessionsPerDay(ctx)
  if (maxPerDay) return maxPerDay

  // Rule F: failure backoff.
  const backoff = ruleFailureBackoff(ctx)
  if (backoff) return backoff

  // Rule E: cost throttling.
  const cost = ruleCostThrottle(ctx)
  if (cost) return cost

  // Rule A: developer recently active. Slowest; runs last.
  const recentDev = await ruleDeveloperRecentlyActive(ctx)
  if (recentDev) return recentDev

  return null
}

// ─── Rules ───────────────────────────────────────────────────────────

export function ruleAutoPaused(ctx: SkipRuleContext): SkipDecision | null {
  if (!ctx.project.autoPausedAt) return null
  return {
    reason: 'auto-paused',
    notes: ctx.project.autoPauseReason ?? 'auto-paused (no reason recorded)',
  }
}

export function ruleManualPaused(ctx: SkipRuleContext): SkipDecision | null {
  if (ctx.project.autonomyConfig.level !== 'paused') return null
  return { reason: 'manual-paused', notes: 'autonomy.json level=paused' }
}

export function ruleSkipDay(ctx: SkipRuleContext): SkipDecision | null {
  const days = ctx.project.autonomyConfig.skipDays
  if (!days || days.length === 0) return null
  const today = weekdayUtc(ctx.now)
  if (days.includes(today)) {
    return { reason: 'skip-day', notes: `today is ${today}` }
  }
  return null
}

export function ruleMaxSessionsPerDay(ctx: SkipRuleContext): SkipDecision | null {
  const cap = ctx.project.autonomyConfig.maxSessionsPerDay
  if (!cap || cap <= 0) return null
  if (ctx.sessionsToday >= cap) {
    return {
      reason: 'max-sessions-per-day',
      notes: `${ctx.sessionsToday}/${cap} sessions already today`,
    }
  }
  return null
}

/**
 * Rule F: exponential backoff after 3+ consecutive failed sessions.
 * Counts only **scheduled** runs (manual triggers reset the counter
 * even when they fail — the developer is iterating intentionally).
 *
 * The "skip-N-runs" semantics: if the run count is C >= threshold,
 * skip until we've skipped (C - threshold + 1) ticks, then try again.
 * Implemented by counting consecutive failures *and* the number of
 * 'skipped' rows since the last 'enqueued' — but for simplicity in
 * this PR we apply a stateless heuristic: if the last C sessions
 * (newest first) are all failures, skip the next tick. The integration
 * test in #24 exercises a more thorough multi-tick scenario.
 */
export function ruleFailureBackoff(ctx: SkipRuleContext): SkipDecision | null {
  const consecutive = consecutiveFailures(ctx.recentSessions)
  if (consecutive < FAILURE_BACKOFF_THRESHOLD) return null
  return {
    reason: 'failure-backoff',
    notes: `${consecutive} consecutive failures — backing off`,
  }
}

export function ruleCostThrottle(ctx: SkipRuleContext): SkipDecision | null {
  const monthlyBudgetCents =
    Math.round(((ctx.monthlyBudgetUsd ?? DEFAULT_MONTHLY_BUDGET_USD) as number) * 100)
  if (monthlyBudgetCents <= 0) return null
  const used = ctx.costs.monthCents / monthlyBudgetCents
  if (used >= COST_THROTTLE_ALL_FRACTION) {
    return {
      reason: 'cost-throttle-budget-exceeded',
      notes: `monthly spend at ${(used * 100).toFixed(1)}% of budget`,
    }
  }
  if (used >= COST_THROTTLE_LOW_FRACTION && ctx.project.autonomyConfig.priority === 'low') {
    return {
      reason: 'cost-throttle-low-priority',
      notes: `monthly spend at ${(used * 100).toFixed(1)}%; low-priority project skipped first`,
    }
  }
  return null
}

export async function ruleDeveloperRecentlyActive(
  ctx: SkipRuleContext,
): Promise<SkipDecision | null> {
  if (!ctx.workingDir) return null
  const windowHours =
    ctx.developerActivityWindowHours ?? readDeveloperWindowFromEnv() ?? DEFAULT_DEVELOPER_ACTIVITY_WINDOW_HOURS
  if (windowHours <= 0) return null
  try {
    const result = await execa(
      'git',
      [
        'log',
        '--since',
        `${windowHours} hours ago`,
        `--author=${ctx.developerName}`,
        '--pretty=%H',
      ],
      { cwd: ctx.workingDir, reject: false, timeout: 5000 },
    )
    if (result.exitCode === 0 && result.stdout.toString().trim().length > 0) {
      const count = result.stdout.toString().trim().split('\n').filter(Boolean).length
      return {
        reason: 'developer-recently-active',
        notes: `${count} developer commit(s) in last ${windowHours}h`,
      }
    }
    return null
  } catch {
    // Failing to probe git is not a reason to skip — let the run go and
    // the worker will surface any real problem. We deliberately don't
    // treat a transient failure here as a confidence-reducing signal.
    return null
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

const WEEKDAY_LOOKUP: Record<number, Weekday> = {
  0: 'sunday',
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
  6: 'saturday',
}

export function weekdayUtc(d: Date): Weekday {
  const w = WEEKDAY_LOOKUP[d.getUTCDay()]
  if (!w) throw new Error(`unreachable weekday: ${d.getUTCDay()}`)
  return w
}

void WEEKDAYS // re-exported elsewhere — pin import.

/**
 * Count consecutive failed sessions starting from the most recent.
 * "Failed" means status !== 'completed' OR pr_number IS NULL after a
 * non-orientation session. Stops at the first successful session.
 */
export function consecutiveFailures(sessions: Session[]): number {
  let count = 0
  for (const s of sessions) {
    // Fixup turns are sub-turns of their parent's attempt, not independent
    // outcomes — skip them so a `completed` fixup can't mask its failed
    // parent (nor a failed fixup double-count the same attempt). ENG-02.
    if (s.isFixupTurn) continue
    if (sessionFailedForBackoff(s)) count++
    else break
  }
  return count
}

export function sessionFailedForBackoff(session: Session): boolean {
  // Orientation sessions intentionally don't open a PR; don't penalise.
  if (session.status === 'completed' && session.prNumber === null) {
    // Without journal/output context, we can't perfectly classify
    // orientation vs "completed but no changes". Treat as not-failed.
    return false
  }
  if (session.status === 'completed' || session.status === 'completed-no-changes') {
    return false
  }
  return true
}

function readDeveloperWindowFromEnv(): number | null {
  const raw = process.env['MAESTRO_DEVELOPER_ACTIVITY_WINDOW_HOURS']
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}
