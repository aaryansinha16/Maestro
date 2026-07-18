// Phase 2 scheduler. Reads `projects` from SQLite, registers a node-cron
// job for each one with `scheduledEnabled = true`, and on every tick
// evaluates skip rules before enqueueing a job (or recording a skip
// row in `scheduled_runs`).
//
// Hot reload: a setInterval re-reads the projects table every
// SCHEDULER_POLL_INTERVAL_MS and reconciles registered cron jobs with
// the current desired state. This avoids requiring a conductor restart
// when the developer toggles scheduling or edits a schedule string.
// Polling (rather than a SQLite WAL/triggers approach) is the pragmatic
// v1 choice — see ADR.

import cron, { type ScheduledTask } from 'node-cron'
import type Database from 'better-sqlite3'
import { join } from 'node:path'
import {
  DEFAULT_MONTHLY_BUDGET_USD,
  SCHEDULER_POLL_INTERVAL_MS,
  WORK_SUBDIR,
  type Project,
  type ScheduleSkipReason,
} from '@maestro/shared'
import type { Config } from './config.js'
import { logger } from './logger.js'
import {
  CostRepository,
  ProjectRepository,
  ScheduledRunsRepository,
  SessionRepository,
} from './repositories.js'
import { evaluateSkipRules, type SkipRuleContext } from './skip-rules.js'
import type { JobQueue } from './job-queue.js'

// ─── Public API ──────────────────────────────────────────────────────

export interface SchedulerOptions {
  db: Database.Database
  config: Config
  /** The shared queue every scheduled enqueue lands in. */
  queue: JobQueue
  /** Override for tests — replaces SCHEDULER_POLL_INTERVAL_MS. */
  pollIntervalMs?: number
  /**
   * Override the cron timezone. Phase 2 default: env MAESTRO_TZ or 'UTC'.
   */
  timezone?: string
  /**
   * Test seam: replace the cron implementation. Production passes
   * undefined → uses the real `node-cron`. The minimal contract is
   * `schedule(expr, fn, opts) → ScheduledTask`.
   */
  cronImpl?: typeof cron
}

export interface Scheduler {
  /** Force a reconciliation now (used by tests). */
  reconcileNow(): void
  /** Stop polling, unregister every cron job, drain in-flight ticks. */
  stop(): Promise<void>
  /** True if a project's cron job is currently registered. */
  isRegistered(slug: string): boolean
  /** All registered slugs, for tests. */
  registeredSlugs(): string[]
}

/**
 * Construct and start the scheduler. Returns a controller for shutdown.
 */
export function startScheduler(options: SchedulerOptions): Scheduler {
  return new SchedulerImpl(options)
}

// ─── Implementation ──────────────────────────────────────────────────

interface RegisteredJob {
  task: ScheduledTask
  schedule: string
  timezone: string
  scheduledEnabled: boolean
}

class SchedulerImpl implements Scheduler {
  private readonly projects: ProjectRepository
  private readonly sessions: SessionRepository
  private readonly costs: CostRepository
  private readonly scheduledRuns: ScheduledRunsRepository
  private readonly queue: JobQueue
  private readonly config: Config
  private readonly cron: typeof cron
  private readonly timezone: string
  private readonly registered = new Map<string, RegisteredJob>()
  private pollHandle: NodeJS.Timeout | null = null
  private stopped = false
  private inFlightTicks = 0

  constructor(opts: SchedulerOptions) {
    this.projects = new ProjectRepository(opts.db)
    this.sessions = new SessionRepository(opts.db)
    this.costs = new CostRepository(opts.db)
    this.scheduledRuns = new ScheduledRunsRepository(opts.db)
    this.queue = opts.queue
    this.config = opts.config
    this.cron = opts.cronImpl ?? cron
    this.timezone =
      opts.timezone ?? process.env['MAESTRO_TZ'] ?? 'UTC'

    const pollMs = opts.pollIntervalMs ?? SCHEDULER_POLL_INTERVAL_MS
    this.reconcileNow()
    this.pollHandle = setInterval(() => this.reconcileNow(), pollMs)
    if (typeof this.pollHandle.unref === 'function') this.pollHandle.unref()
    logger.info(
      { timezone: this.timezone, pollMs },
      'scheduler started',
    )
  }

  reconcileNow(): void {
    if (this.stopped) return
    let projects: Project[]
    try {
      projects = this.projects.list()
    } catch (err) {
      logger.error({ err }, 'scheduler: failed to read projects table')
      return
    }
    const desired = new Map(projects.map((p) => [p.slug, p]))

    // Unregister jobs whose project disappeared, was disabled, or whose
    // schedule string changed (we always re-register on edit so the new
    // cron expression takes effect on the next tick).
    for (const [slug, reg] of this.registered) {
      const p = desired.get(slug)
      if (
        !p ||
        !p.scheduledEnabled ||
        p.autonomyConfig.schedule !== reg.schedule ||
        this.timezone !== reg.timezone
      ) {
        reg.task.stop()
        this.registered.delete(slug)
        logger.info({ slug }, 'scheduler: unregistered cron job')
      }
    }

    // Register jobs for newly-enabled or changed-schedule projects.
    for (const project of projects) {
      if (!project.scheduledEnabled) continue
      if (this.registered.has(project.slug)) continue
      this.register(project)
    }
  }

  isRegistered(slug: string): boolean {
    return this.registered.has(slug)
  }

  registeredSlugs(): string[] {
    return [...this.registered.keys()]
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollHandle) clearInterval(this.pollHandle)
    this.pollHandle = null
    for (const [slug, reg] of this.registered) {
      reg.task.stop()
      this.registered.delete(slug)
    }
    // Spin until all in-flight cron ticks complete.
    while (this.inFlightTicks > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    logger.info('scheduler stopped')
  }

  private register(project: Project): void {
    const expr = project.autonomyConfig.schedule
    if (!this.cron.validate(expr)) {
      logger.warn(
        { slug: project.slug, expr },
        'scheduler: invalid cron expression — refusing to register',
      )
      return
    }
    const task = this.cron.schedule(
      expr,
      () => {
        // Each tick is independent — failures shouldn't poison the cron
        // task. Wrap in try/catch to keep the handler from throwing into
        // node-cron, which would otherwise mark the task unhealthy.
        this.inFlightTicks += 1
        this.handleTick(project.slug)
          .catch((err) => {
            logger.error(
              { err, slug: project.slug },
              'scheduler: tick handler threw',
            )
          })
          .finally(() => {
            this.inFlightTicks -= 1
          })
      },
      { timezone: this.timezone },
    )
    this.registered.set(project.slug, {
      task,
      schedule: expr,
      timezone: this.timezone,
      scheduledEnabled: true,
    })
    logger.info(
      { slug: project.slug, schedule: expr, timezone: this.timezone },
      'scheduler: registered cron job',
    )
  }

  /**
   * One cron tick: re-load the project (its state may have changed
   * since registration), build skip-rule context, evaluate, then either
   * enqueue a job or write a 'skipped' row.
   */
  private async handleTick(slug: string): Promise<void> {
    const scheduledAt = new Date().toISOString()
    const project = this.projects.findBySlug(slug)
    if (!project) {
      logger.warn({ slug }, 'scheduler: project disappeared between register and tick')
      return
    }
    if (!project.scheduledEnabled) {
      this.scheduledRuns.insert({
        projectId: project.id,
        scheduledAt,
        action: 'skipped',
        skipReason: 'project-disabled',
      })
      return
    }
    const ctx = await this.buildContext(project)
    const decision = await evaluateSkipRules(ctx)
    if (decision) {
      this.scheduledRuns.insert({
        projectId: project.id,
        scheduledAt,
        action: 'skipped',
        skipReason: decision.reason,
        notes: decision.notes ?? null,
      })
      logger.info(
        { slug: project.slug, reason: decision.reason, notes: decision.notes },
        'scheduler: skipped tick',
      )
      return
    }
    try {
      const job = this.queue.enqueue({
        projectId: project.id,
        source: 'schedule',
      })
      this.scheduledRuns.insert({
        projectId: project.id,
        scheduledAt,
        action: 'enqueued',
        jobId: job.id,
      })
      logger.info(
        { slug: project.slug, jobId: job.id },
        'scheduler: enqueued job',
      )
    } catch (err) {
      this.scheduledRuns.insert({
        projectId: project.id,
        scheduledAt,
        action: 'failed-to-fire',
        skipReason: 'unknown' as ScheduleSkipReason,
        notes: err instanceof Error ? err.message : String(err),
      })
      logger.error({ err, slug: project.slug }, 'scheduler: failed to enqueue')
    }
  }

  private async buildContext(project: Project): Promise<SkipRuleContext> {
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const todayCount = this.sessions.countSince(project.id, todayStart.toISOString())
    const recent = this.sessions.list({ projectId: project.id, limit: 10 }).sessions
    const costs = this.costs.aggregate()
    const monthlyBudgetUsd = Number(
      process.env['MAESTRO_BUDGET_USD'] ?? DEFAULT_MONTHLY_BUDGET_USD,
    )
    const workingDir = join(this.config.dataDir, WORK_SUBDIR, project.slug)
    return {
      project,
      now: new Date(),
      sessionsToday: todayCount,
      recentSessions: recent,
      costs,
      workingDir,
      developerName: this.config.developerName,
      monthlyBudgetUsd: Number.isFinite(monthlyBudgetUsd)
        ? monthlyBudgetUsd
        : DEFAULT_MONTHLY_BUDGET_USD,
    }
  }
}
