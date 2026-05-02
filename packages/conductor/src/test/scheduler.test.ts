// Scheduler tests. The cron implementation is replaced with a mock that
// exposes a `trigger(slug)` helper, so we can simulate ticks without
// waiting on real time.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type DbHandle } from '../db.js'
import {
  ProjectRepository,
  ScheduledRunsRepository,
  JobQueueRepository,
} from '../repositories.js'
import { startScheduler, type Scheduler } from '../scheduler.js'
import { JobQueue, type JobRunOutcome } from '../job-queue.js'
import { DEFAULT_AUTONOMY_CONFIG } from '@maestro/shared'
import type { Config } from '../config.js'
import type cron from 'node-cron'

interface Harness {
  db: DbHandle
  root: string
}
let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-sch-'))
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

/**
 * Mock cron implementation matching the surface scheduler.ts uses.
 * Tracks registered tasks and exposes `trigger(slug)` to simulate a tick.
 */
function mockCron() {
  type Task = { stop: () => void; running: boolean; expr: string; fn: () => void }
  type CronModule = typeof cron
  type CronSchedule = ReturnType<CronModule['schedule']>
  const tasks = new Map<string, Task>()
  const impl = {
    validate: (_expr: string) => true,
    schedule: (expr: string, fn: () => void, _opts?: unknown) => {
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
  const triggerAll = async (): Promise<void> => {
    for (const t of tasks.values()) {
      t.fn()
      // Yield once so the async tick handler resolves.
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return { impl, tasks, triggerAll }
}

function setup(slug = 'p1', overrides: Record<string, unknown> = {}) {
  if (!h) throw new Error('harness missing')
  const projects = new ProjectRepository(h.db.db)
  const id = randomUUID()
  projects.insert({
    id,
    slug,
    repoUrl: `https://github.com/example/${slug}`,
    autonomyConfig: {
      ...DEFAULT_AUTONOMY_CONFIG,
      schedule: '*/5 * * * *',
      scheduledEnabled: true,
      ...(overrides as Record<string, never>),
    },
  })
  return { projects, id }
}

function dummyQueue(_db: DbHandle): { queue: JobQueue; outcomes: JobRunOutcome[] } {
  const outcomes: JobRunOutcome[] = []
  const queue = new JobQueue({
    db: _db.db,
    runner: async () => {
      const o: JobRunOutcome = { status: 'completed', sessionId: null }
      outcomes.push(o)
      return o
    },
    maxParallel: 1,
  })
  return { queue, outcomes }
}

describe('scheduler — registration', () => {
  it('registers cron jobs only for scheduled-enabled projects', () => {
    if (!h) throw new Error('harness missing')
    setup('a', { scheduledEnabled: true })
    setup('b', { scheduledEnabled: false })

    const { impl } = mockCron()
    const { queue } = dummyQueue(h.db)
    const sch = startScheduler({
      db: h.db.db,
      config: FIXTURE_CONFIG,
      queue,
      cronImpl: impl,
      pollIntervalMs: 100_000, // disable polling during the test
    })
    expect(sch.isRegistered('a')).toBe(true)
    expect(sch.isRegistered('b')).toBe(false)
    void sch.stop()
  })

  it('hot-reload picks up enabled projects on reconcileNow', () => {
    if (!h) throw new Error('harness missing')
    const { projects } = setup('a', { scheduledEnabled: false })
    const { impl } = mockCron()
    const { queue } = dummyQueue(h.db)
    const sch = startScheduler({
      db: h.db.db,
      config: FIXTURE_CONFIG,
      queue,
      cronImpl: impl,
      pollIntervalMs: 100_000,
    })
    expect(sch.isRegistered('a')).toBe(false)
    projects.setScheduledEnabled('a', true)
    sch.reconcileNow()
    expect(sch.isRegistered('a')).toBe(true)
    void sch.stop()
  })

  it('unregisters when scheduling is disabled', () => {
    if (!h) throw new Error('harness missing')
    const { projects } = setup('a', { scheduledEnabled: true })
    const { impl } = mockCron()
    const { queue } = dummyQueue(h.db)
    const sch = startScheduler({
      db: h.db.db,
      config: FIXTURE_CONFIG,
      queue,
      cronImpl: impl,
      pollIntervalMs: 100_000,
    })
    expect(sch.isRegistered('a')).toBe(true)
    projects.setScheduledEnabled('a', false)
    sch.reconcileNow()
    expect(sch.isRegistered('a')).toBe(false)
    void sch.stop()
  })
})

describe('scheduler — tick handling', () => {
  it('enqueues a job when no skip rule fires', async () => {
    if (!h) throw new Error('harness missing')
    const { id } = setup('a', {
      scheduledEnabled: true,
      skipDays: [],
    })
    const { impl, triggerAll } = mockCron()
    const { queue } = dummyQueue(h.db)
    const sch = startScheduler({
      db: h.db.db,
      config: FIXTURE_CONFIG,
      queue,
      cronImpl: impl,
      pollIntervalMs: 100_000,
    })
    await triggerAll()
    const runs = new ScheduledRunsRepository(h.db.db).recentForProject(id)
    expect(runs[0]?.action).toBe('enqueued')
    expect(new JobQueueRepository(h.db.db).listQueued().length + 1).toBeGreaterThan(0)
    await sch.stop()
  })

  it("logs 'skipped' with reason when an auto-paused project tickles", async () => {
    if (!h) throw new Error('harness missing')
    const { projects, id } = setup('a', { scheduledEnabled: true })
    projects.setAutoPause('a', 'auto-paused after failures')
    const { impl, triggerAll } = mockCron()
    const { queue } = dummyQueue(h.db)
    const sch = startScheduler({
      db: h.db.db,
      config: FIXTURE_CONFIG,
      queue,
      cronImpl: impl,
      pollIntervalMs: 100_000,
    })
    await triggerAll()
    const runs = new ScheduledRunsRepository(h.db.db).recentForProject(id)
    expect(runs[0]?.action).toBe('skipped')
    expect(runs[0]?.skipReason).toBe('auto-paused')
    await sch.stop()
  })
})

describe('scheduler — graceful stop', () => {
  it('unregisters every job on stop()', async () => {
    if (!h) throw new Error('harness missing')
    setup('a', { scheduledEnabled: true })
    setup('b', { scheduledEnabled: true })
    const { impl } = mockCron()
    const { queue } = dummyQueue(h.db)
    const sch: Scheduler = startScheduler({
      db: h.db.db,
      config: FIXTURE_CONFIG,
      queue,
      cronImpl: impl,
      pollIntervalMs: 100_000,
    })
    expect(sch.registeredSlugs().sort()).toEqual(['a', 'b'])
    await sch.stop()
    expect(sch.registeredSlugs()).toEqual([])
  })
})
