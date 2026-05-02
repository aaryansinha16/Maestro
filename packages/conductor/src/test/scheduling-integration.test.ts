// End-to-end integration test for Phase 2: cron tick → skip rules →
// queue → runner → DB transitions. Uses a mock cron and a mock job
// runner so the test runs deterministically without spawning Claude or
// touching real time.
//
// Three projects are wired up to verify FIFO + per-project concurrency
// + global concurrency together — the load-bearing invariants of
// ADR-008.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type cron from 'node-cron'
import { openDatabase, type DbHandle } from '../db.js'
import {
  JobQueueRepository,
  ProjectRepository,
  ScheduledRunsRepository,
} from '../repositories.js'
import { JobQueue, type JobRunOutcome } from '../job-queue.js'
import { startScheduler } from '../scheduler.js'
import { DEFAULT_AUTONOMY_CONFIG, type Job } from '@maestro/shared'
import type { Config } from '../config.js'

interface Harness {
  db: DbHandle
  root: string
}
let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-int-'))
  const db = openDatabase({ dataDir: root })
  h = { db, root }
})

afterEach(async () => {
  if (h) {
    h.db.close()
    await rm(h.root, { recursive: true, force: true })
    h = null
  }
})

const FIXTURE_CONFIG: Config = {
  port: 0,
  dataDir: '/tmp/whatever',
  developerName: 'Tester',
  developerEmail: 'tester@example.com',
  developerGithubUsername: 'tester',
  nodeEnv: 'test',
}

interface MockCron {
  impl: typeof cron
  triggerAll: () => Promise<void>
}

function mockCron(): MockCron {
  type Task = { stop: () => void; running: boolean; expr: string; fn: () => void }
  type CronModule = typeof cron
  type CronSchedule = ReturnType<CronModule['schedule']>
  const tasks = new Map<string, Task>()
  const impl = {
    validate: () => true,
    schedule: (expr: string, fn: () => void) => {
      const id = randomUUID()
      const task: Task = {
        stop: () => {
          tasks.delete(id)
        },
        running: true,
        expr,
        fn,
      }
      tasks.set(id, task)
      return task as unknown as CronSchedule
    },
    getTasks: () => new Map(),
  } as unknown as CronModule
  return {
    impl,
    triggerAll: async () => {
      for (const t of tasks.values()) {
        t.fn()
        await new Promise((resolve) => setImmediate(resolve))
        await new Promise((resolve) => setImmediate(resolve))
      }
    },
  }
}

function addProject(slug: string): string {
  if (!h) throw new Error('harness missing')
  const id = randomUUID()
  new ProjectRepository(h.db.db).insert({
    id,
    slug,
    repoUrl: `https://github.com/example/${slug}`,
    autonomyConfig: {
      ...DEFAULT_AUTONOMY_CONFIG,
      schedule: '*/5 * * * *',
      scheduledEnabled: true,
    },
  })
  return id
}

describe('Phase 2 integration', () => {
  it('three scheduled projects flow through the queue with concurrency = 2', async () => {
    if (!h) throw new Error('harness missing')
    const ids = [addProject('a'), addProject('b'), addProject('c')]

    const startedJobs: Job[] = []
    const completed: string[] = []
    const finishers = new Map<string, () => void>()
    const runner = (job: Job) => {
      startedJobs.push(job)
      return new Promise<JobRunOutcome>((resolve) => {
        finishers.set(job.id, () => {
          completed.push(job.id)
          resolve({ status: 'completed', sessionId: null })
        })
      })
    }
    const queue = new JobQueue({ db: h.db.db, runner, maxParallel: 2 })
    const cron = mockCron()
    const sch = startScheduler({
      db: h.db.db,
      config: FIXTURE_CONFIG,
      queue,
      cronImpl: cron.impl,
      pollIntervalMs: 100_000,
    })
    expect(sch.registeredSlugs().sort()).toEqual(['a', 'b', 'c'])

    // Fire every cron job once.
    await cron.triggerAll()
    // Pump runs in a microtask after enqueue; let the queue settle.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    // Two projects should be running, one queued (concurrency = 2).
    const queueRepo = new JobQueueRepository(h.db.db)
    expect(queueRepo.listRunning()).toHaveLength(2)
    expect(queueRepo.listQueued()).toHaveLength(1)

    // Every cron tick wrote an 'enqueued' scheduled_runs row.
    const runs = new ScheduledRunsRepository(h.db.db)
    for (const id of ids) {
      const list = runs.recentForProject(id)
      expect(list[0]?.action).toBe('enqueued')
    }

    // Finish one running job; the queued one should pick up the slot.
    const firstId = startedJobs[0]!.id
    finishers.get(firstId)!()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(completed).toContain(firstId)
    expect(queueRepo.listRunning()).toHaveLength(2)
    expect(queueRepo.listQueued()).toHaveLength(0)

    // Finish the rest.
    for (const j of startedJobs.slice(1)) finishers.get(j.id)?.()
    // The third job (which started after the first finished) is in startedJobs already.
    // Wait for everything to drain.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve))
      if (queueRepo.listRunning().length === 0) break
    }

    expect(queueRepo.listRunning()).toHaveLength(0)
    expect(queueRepo.listQueued()).toHaveLength(0)
    expect(completed).toHaveLength(3)
    await sch.stop()
  }, 10_000)

  it('a tick on an auto-paused project records a skip without enqueueing', async () => {
    if (!h) throw new Error('harness missing')
    const id = addProject('p')
    new ProjectRepository(h.db.db).setAutoPause('p', '5 consecutive failures')

    const runner = () =>
      Promise.resolve<JobRunOutcome>({ status: 'completed', sessionId: null })
    const queue = new JobQueue({ db: h.db.db, runner, maxParallel: 2 })
    const cron = mockCron()
    const sch = startScheduler({
      db: h.db.db,
      config: FIXTURE_CONFIG,
      queue,
      cronImpl: cron.impl,
      pollIntervalMs: 100_000,
    })

    await cron.triggerAll()
    const runs = new ScheduledRunsRepository(h.db.db).recentForProject(id)
    expect(runs[0]?.action).toBe('skipped')
    expect(runs[0]?.skipReason).toBe('auto-paused')
    expect(new JobQueueRepository(h.db.db).listQueued()).toHaveLength(0)
    await sch.stop()
  })

  it('manual triggers bypass skip rules — Rule D auto-paused gets a manual trigger', () => {
    if (!h) throw new Error('harness missing')
    const id = addProject('p')
    new ProjectRepository(h.db.db).setAutoPause('p', 'paused')

    const runner = () =>
      Promise.resolve<JobRunOutcome>({ status: 'completed', sessionId: null })
    const queue = new JobQueue({ db: h.db.db, runner, maxParallel: 1 })

    // Direct enqueue with source='manual' (the API endpoint /trigger
    // does this). Skip rules don't apply because the scheduler isn't
    // involved.
    queue.enqueue({ projectId: id, source: 'manual' })
    expect(new JobQueueRepository(h.db.db).listQueued().length + new JobQueueRepository(h.db.db).listRunning().length).toBeGreaterThan(0)
  })
})
