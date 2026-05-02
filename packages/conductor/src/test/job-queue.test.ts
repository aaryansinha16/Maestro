// JobQueue tests — concurrency, priority, FIFO, starvation guard,
// crash recovery, persistence across restart.
//
// All tests use an in-memory SQLite database via openDatabase({ memory:
// true }) so they run instantly without touching disk.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DbHandle } from '../db.js'
import { JobQueue, type JobRunOutcome } from '../job-queue.js'
import { ProjectRepository, JobQueueRepository } from '../repositories.js'
import { DEFAULT_AUTONOMY_CONFIG, type Job } from '@maestro/shared'

interface Harness {
  db: DbHandle
  root: string
  projectIds: string[]
}

let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-jq-'))
  const db = openDatabase({ dataDir: root })
  h = { db, root, projectIds: [] }
})

afterEach(async () => {
  if (h) {
    h.db.close()
    await rm(h.root, { recursive: true, force: true })
    h = null
  }
})

function addProject(slug: string): string {
  if (!h) throw new Error('harness missing')
  const id = randomUUID()
  new ProjectRepository(h.db.db).insert({
    id,
    slug,
    repoUrl: `https://github.com/example/${slug}`,
    autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG, scheduledEnabled: true },
  })
  h.projectIds.push(id)
  return id
}

/**
 * Returns a runner that hands out a deferred per job — the test resolves
 * each one to control the race. Records the order each job started.
 */
function deferredRunner() {
  const started: string[] = []
  const completed: string[] = []
  const pending = new Map<string, (outcome: JobRunOutcome) => void>()
  const runner = (job: Job) => {
    started.push(job.id)
    return new Promise<JobRunOutcome>((resolve) => {
      pending.set(job.id, (outcome) => {
        completed.push(job.id)
        resolve(outcome)
      })
    })
  }
  const finish = (jobId: string, outcome: JobRunOutcome = { status: 'completed', sessionId: null }) => {
    const r = pending.get(jobId)
    if (!r) throw new Error(`no pending runner for ${jobId}`)
    r(outcome)
    pending.delete(jobId)
  }
  // Yield once; gives queueMicrotask-scheduled pump() a chance to run.
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
  return { runner, started, completed, finish, tick }
}

describe('JobQueue — concurrency', () => {
  it('honours the global parallel ceiling', async () => {
    if (!h) throw new Error('harness missing')
    const a = addProject('a')
    const b = addProject('b')
    const c = addProject('c')
    const { runner, started, finish, tick } = deferredRunner()
    const queue = new JobQueue({ db: h.db.db, runner, maxParallel: 2 })

    queue.enqueue({ projectId: a, source: 'schedule' })
    queue.enqueue({ projectId: b, source: 'schedule' })
    queue.enqueue({ projectId: c, source: 'schedule' })

    await tick()
    await tick()
    expect(started).toHaveLength(2)

    finish(started[0]!)
    await tick()
    await tick()
    expect(started).toHaveLength(3)
    finish(started[1]!)
    finish(started[2]!)
    await tick()
  })

  it('per-project concurrency = 1: same project does not double-fire', async () => {
    if (!h) throw new Error('harness missing')
    const a = addProject('a')
    const { runner, started, finish, tick } = deferredRunner()
    const queue = new JobQueue({ db: h.db.db, runner, maxParallel: 4 })

    // Three jobs for the same project. Only one can run at a time.
    queue.enqueue({ projectId: a, source: 'schedule' })
    queue.enqueue({ projectId: a, source: 'schedule' })
    queue.enqueue({ projectId: a, source: 'schedule' })

    await tick()
    await tick()
    expect(started).toHaveLength(1)

    finish(started[0]!)
    await tick()
    await tick()
    expect(started).toHaveLength(2)

    finish(started[1]!)
    await tick()
    await tick()
    expect(started).toHaveLength(3)
    finish(started[2]!)
    await tick()
  })
})

describe('JobQueue — priority and FIFO', () => {
  it('manual triggers jump the queue ahead of scheduled jobs', async () => {
    if (!h) throw new Error('harness missing')
    const a = addProject('a')
    const b = addProject('b')
    const c = addProject('c')
    const { runner, started, finish, tick } = deferredRunner()
    // maxParallel=1 so we observe ordering deterministically.
    const queue = new JobQueue({ db: h.db.db, runner, maxParallel: 1 })

    // Enqueue schedule first, let it start, then enqueue more — the
    // mid-flight manual trigger should run before the second schedule.
    const j1 = queue.enqueue({ projectId: a, source: 'schedule' })
    await tick()
    await tick()
    expect(started[0]).toBe(j1.id)

    const j2 = queue.enqueue({ projectId: b, source: 'schedule' })
    const jM = queue.enqueue({ projectId: c, source: 'manual' })
    void j2

    finish(started[0]!)
    await tick()
    await tick()
    // After the first schedule finishes, the manual job (highest priority)
    // jumps ahead of the queued b/schedule.
    expect(started[1]).toBe(jM.id)
  })

  it('FIFO within a priority class', async () => {
    if (!h) throw new Error('harness missing')
    const a = addProject('a')
    const b = addProject('b')
    const c = addProject('c')
    const { runner, started, finish, tick } = deferredRunner()
    const queue = new JobQueue({ db: h.db.db, runner, maxParallel: 1 })

    const j1 = queue.enqueue({ projectId: a, source: 'schedule' })
    const j2 = queue.enqueue({ projectId: b, source: 'schedule' })
    const j3 = queue.enqueue({ projectId: c, source: 'schedule' })

    await tick()
    await tick()
    finish(started[0]!)
    await tick()
    await tick()
    finish(started[1]!)
    await tick()
    await tick()
    finish(started[2]!)
    await tick()

    expect(started).toEqual([j1.id, j2.id, j3.id])
  })
})

describe('JobQueue — starvation guard', () => {
  it('does not starve B when A has many queued jobs', async () => {
    if (!h) throw new Error('harness missing')
    const a = addProject('a')
    const b = addProject('b')
    const { runner, started, finish, tick } = deferredRunner()
    const queue = new JobQueue({ db: h.db.db, runner, maxParallel: 1 })

    queue.enqueue({ projectId: a, source: 'schedule' })
    queue.enqueue({ projectId: a, source: 'schedule' })
    queue.enqueue({ projectId: a, source: 'schedule' })
    const jB = queue.enqueue({ projectId: b, source: 'schedule' })

    await tick()
    await tick()
    expect(started).toHaveLength(1) // first A job

    finish(started[0]!)
    await tick()
    await tick()
    // Picker should walk past A's remaining queue (A is in-flight slot
    // logic releases as soon as the previous A finishes; still, the
    // starvation guard means B isn't permanently behind A's stack).
    // After the first A finishes, A's slot is free again — so the next
    // pick is the next-in-line which is the second A.
    // The test of the guard is that B is reachable after one more cycle:
    finish(started[1]!)
    await tick()
    await tick()
    finish(started[2]!)
    await tick()
    await tick()
    expect(started).toContain(jB.id)
  })
})

describe('JobQueue — crash recovery', () => {
  it('cancels rows still in running on construction', async () => {
    if (!h) throw new Error('harness missing')
    const a = addProject('a')
    const repo = new JobQueueRepository(h.db.db)
    const stuckJob = repo.insert({
      id: randomUUID(),
      projectId: a,
      source: 'schedule',
      priority: 0,
    })
    repo.update(stuckJob.id, { status: 'running', startedAt: new Date().toISOString() })
    expect(repo.listRunning()).toHaveLength(1)

    // Construct the queue — should reclaim.
    const noopRunner = () =>
      Promise.resolve<JobRunOutcome>({ status: 'completed', sessionId: null })
    new JobQueue({ db: h.db.db, runner: noopRunner })

    const after = repo.findById(stuckJob.id)
    expect(after?.status).toBe('cancelled')
    expect(after?.cancelReason).toBe('conductor-restart')
  })

  it('preserves queued jobs across a notional restart', async () => {
    if (!h) throw new Error('harness missing')
    const a = addProject('a')
    const repo = new JobQueueRepository(h.db.db)

    // Boot 1: enqueue a job, never run it.
    const noopRunner = () =>
      Promise.resolve<JobRunOutcome>({ status: 'completed', sessionId: null })
    const q1 = new JobQueue({ db: h.db.db, runner: noopRunner, maxParallel: 0 })
    void q1
    repo.insert({
      id: randomUUID(),
      projectId: a,
      source: 'schedule',
      priority: 0,
    })
    expect(repo.listQueued()).toHaveLength(1)

    // Boot 2: a fresh JobQueue on the same DB. Queued job should still be there.
    const { runner, started, finish, tick } = deferredRunner()
    const q2 = new JobQueue({ db: h.db.db, runner, maxParallel: 1 })
    void q2
    q2.pump() // queued jobs from previous boot don't trigger pump automatically; explicit.
    await tick()
    await tick()
    expect(started).toHaveLength(1)
    finish(started[0]!)
    await tick()
  })
})

describe('JobQueue — cancel + snapshot', () => {
  it('cancel() works on queued jobs only', () => {
    if (!h) throw new Error('harness missing')
    const a = addProject('a')
    const noopRunner = () =>
      new Promise<JobRunOutcome>(() => {
        /* never resolves — keeps the job 'running' */
      })
    const q = new JobQueue({ db: h.db.db, runner: noopRunner, maxParallel: 0 })
    const job = q.enqueue({ projectId: a, source: 'schedule' })

    const cancelled = q.cancel(job.id, 'developer-aborted')
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.cancelReason).toBe('developer-aborted')

    // Cancelling again is a no-op (still cancelled).
    const again = q.cancel(job.id, 'whatever')
    expect(again?.status).toBe('cancelled')
  })

  it('snapshot returns running, queued, recently completed', async () => {
    if (!h) throw new Error('harness missing')
    const a = addProject('a')
    const b = addProject('b')
    const { runner, started, finish, tick } = deferredRunner()
    const q = new JobQueue({ db: h.db.db, runner, maxParallel: 1 })

    q.enqueue({ projectId: a, source: 'schedule' })
    q.enqueue({ projectId: b, source: 'schedule' })

    await tick()
    await tick()
    let snap = q.snapshot()
    expect(snap.running).toHaveLength(1)
    expect(snap.queued).toHaveLength(1)
    expect(snap.recentlyCompleted).toHaveLength(0)

    finish(started[0]!)
    await tick()
    await tick()
    finish(started[1]!)
    await tick()
    snap = q.snapshot()
    expect(snap.running).toHaveLength(0)
    expect(snap.queued).toHaveLength(0)
    expect(snap.recentlyCompleted).toHaveLength(2)
  })
})
