// In-memory job queue with SQLite persistence + crash recovery.
//
// The scheduler enqueues a job per cron tick (after the skip rules
// approve it). This module dequeues and runs them up to a global
// concurrency limit, while never running two sessions for the same
// project concurrently (ADR-008 — also enforced by `project_locks` at
// the data layer).
//
// State machine for a job:
//
//   queued ─┬─▶ running ─┬─▶ completed
//           │            ├─▶ failed
//           │            └─▶ cancelled (manual cancel or conductor restart)
//           └─▶ cancelled (cancelled before pickup, e.g. project deleted)
//
// Persistence: every transition writes the row in the `job_queue` table,
// so a restart can resume queued jobs and the dashboard can render the
// queue without holding the in-memory state.
//
// Starvation guard: the picker scans `listQueued()` (which is ordered by
// priority DESC then enqueued_at ASC) and picks the FIRST job whose
// project isn't already running. This means project A with 5 queued
// jobs cannot starve project B's 1 queued job — when a slot opens, the
// picker walks the queue and finds B.

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_MAX_PARALLEL,
  JOB_PRIORITY_MANUAL,
  JOB_PRIORITY_RETRY,
  JOB_PRIORITY_SCHEDULED,
  type Job,
  type JobSource,
} from '@maestro/shared'
import { JobQueueRepository } from './repositories.js'
import { logger } from './logger.js'

// ─── Public types ────────────────────────────────────────────────────

export interface EnqueueInput {
  projectId: string
  source: JobSource
  /** Optional priority override; otherwise derived from source. */
  priority?: number
}

/**
 * The runner is the bridge between this queue and `runSession` from
 * worker.ts. We accept it as a callback so this file stays decoupled
 * from the worker's full surface area (tests inject a mock).
 */
export type JobRunner = (job: Job) => Promise<JobRunOutcome>

export interface JobRunOutcome {
  status: 'completed' | 'failed' | 'cancelled'
  /** The session row id, when one was created. Null on early failures. */
  sessionId: string | null
  /** Reason — recorded if status is `cancelled` or `failed`. */
  reason?: string
}

export interface JobQueueOptions {
  db: Database.Database
  runner: JobRunner
  /**
   * Override the global parallel-session ceiling. Reads
   * MAESTRO_MAX_PARALLEL env var by default.
   */
  maxParallel?: number
}

export interface QueueSnapshot {
  running: Job[]
  queued: Job[]
  recentlyCompleted: Job[]
}

// ─── Implementation ──────────────────────────────────────────────────

export class JobQueue {
  private readonly repo: JobQueueRepository
  private readonly runner: JobRunner
  private readonly maxParallel: number
  /** Project ids currently executing in this conductor process. */
  private readonly inFlight = new Set<string>()
  /** True when {@link stop} has been called. New work is rejected. */
  private stopped = false
  /**
   * Resolves once every in-flight job has settled. Used by graceful
   * shutdown to drain before closing the DB.
   */
  private drained = Promise.resolve<void>(undefined)
  private resolveDrained: (() => void) | null = null

  constructor(options: JobQueueOptions) {
    this.repo = new JobQueueRepository(options.db)
    this.runner = options.runner
    this.maxParallel = options.maxParallel ?? readMaxParallelFromEnv()

    // Crash recovery — see ADR-022 in the umbrella PR.
    const reclaimed = this.repo.cancelStaleOnBoot()
    if (reclaimed > 0) {
      logger.warn({ reclaimed }, 'job-queue: cancelled stale running rows on boot')
    }
  }

  /** True when at least one job is in-flight in this process. */
  hasInFlight(): boolean {
    return this.inFlight.size > 0
  }

  /**
   * Enqueue a new job. Returns the persisted Job row. Triggers a
   * pump() on the next tick so callers don't have to await it.
   */
  enqueue(input: EnqueueInput): Job {
    if (this.stopped) {
      throw new Error('JobQueue: refusing enqueue after stop()')
    }
    const job = this.repo.insert({
      id: randomUUID(),
      projectId: input.projectId,
      source: input.source,
      priority: input.priority ?? defaultPriorityFor(input.source),
    })
    logger.debug({ jobId: job.id, projectId: job.projectId, source: job.source }, 'job enqueued')
    queueMicrotask(() => void this.pump())
    return job
  }

  /**
   * Cancel a queued job. No-op for jobs already running or finished.
   * Manual stop-the-line for the developer when something looks wrong.
   */
  cancel(jobId: string, reason: string): Job | null {
    const job = this.repo.findById(jobId)
    if (!job) return null
    if (job.status !== 'queued') return job
    return this.repo.update(jobId, {
      status: 'cancelled',
      endedAt: new Date().toISOString(),
      cancelReason: reason,
    })
  }

  /**
   * Run the picker. Idempotent — safe to call after enqueue, after a
   * job finishes, or periodically. Picks until either the queue is
   * empty, every queued project has an in-flight sibling, or the
   * concurrency limit is hit.
   */
  pump(): void {
    if (this.stopped) return
    while (this.inFlight.size < this.maxParallel) {
      const next = this.pickNext()
      if (!next) return
      void this.run(next)
    }
  }

  /**
   * Snapshot for the dashboard `/api/queue` endpoint. Cheap — three
   * indexed selects. Includes `recentlyCompleted` from the last 24h.
   */
  snapshot(): QueueSnapshot {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    return {
      running: this.repo.listRunning(),
      queued: this.repo.listQueued(),
      recentlyCompleted: this.repo.listRecent(since),
    }
  }

  /**
   * Stop accepting new work and wait for in-flight jobs to finish.
   * The conductor calls this on SIGINT/SIGTERM.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.inFlight.size === 0) return
    if (!this.resolveDrained) {
      this.drained = new Promise<void>((resolve) => {
        this.resolveDrained = resolve
      })
    }
    await this.drained
  }

  // ─── Internals ─────────────────────────────────────────────────────

  /**
   * Walk the queue (priority DESC, FIFO within priority) and return the
   * first job whose project isn't already running. This is the
   * starvation guard — even if project A has 10 queued jobs, the picker
   * won't return a second A job until A finishes, leaving slots for B.
   */
  private pickNext(): Job | null {
    const queued = this.repo.listQueued()
    for (const job of queued) {
      if (this.inFlight.has(job.projectId)) continue
      if (this.repo.hasRunningForProject(job.projectId)) continue
      return job
    }
    return null
  }

  private async run(job: Job): Promise<void> {
    this.inFlight.add(job.projectId)
    const startedAt = new Date().toISOString()
    this.repo.update(job.id, { status: 'running', startedAt })
    let outcome: JobRunOutcome
    try {
      outcome = await this.runner({ ...job, status: 'running', startedAt })
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'job-queue: runner threw — marking failed')
      outcome = {
        status: 'failed',
        sessionId: null,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
    const endedAt = new Date().toISOString()
    this.repo.update(job.id, {
      status: outcome.status,
      endedAt,
      sessionId: outcome.sessionId,
      cancelReason: outcome.status === 'cancelled' ? outcome.reason ?? null : null,
    })
    this.inFlight.delete(job.projectId)
    logger.info(
      { jobId: job.id, projectId: job.projectId, status: outcome.status },
      'job finished',
    )
    if (this.stopped && this.inFlight.size === 0 && this.resolveDrained) {
      this.resolveDrained()
      this.resolveDrained = null
      return
    }
    // Another slot is now free — try to pick up another job.
    queueMicrotask(() => this.pump())
  }
}

function defaultPriorityFor(source: JobSource): number {
  switch (source) {
    case 'manual':
      return JOB_PRIORITY_MANUAL
    case 'retry':
      return JOB_PRIORITY_RETRY
    case 'schedule':
      return JOB_PRIORITY_SCHEDULED
  }
}

function readMaxParallelFromEnv(): number {
  const raw = process.env['MAESTRO_MAX_PARALLEL']
  if (!raw) return DEFAULT_MAX_PARALLEL
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) {
    logger.warn(
      { raw, fallback: DEFAULT_MAX_PARALLEL },
      'job-queue: ignoring invalid MAESTRO_MAX_PARALLEL — using default',
    )
    return DEFAULT_MAX_PARALLEL
  }
  return Math.floor(n)
}
