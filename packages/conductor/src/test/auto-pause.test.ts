// Auto-pause tests using a real (in-memory-via-tmpdir) DB so we
// exercise the SQL paths in ProjectRepository / SessionRepository.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type DbHandle } from '../db.js'
import { ProjectRepository, SessionRepository } from '../repositories.js'
import {
  evaluateAutoPause,
  maybeClearAutoPauseOnManualSuccess,
  reconcileAutoPauseAfterSession,
} from '../auto-pause.js'
import { DEFAULT_AUTONOMY_CONFIG } from '@maestro/shared'

interface Harness {
  db: DbHandle
  root: string
}

let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-ap-'))
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

function setup() {
  if (!h) throw new Error('harness missing')
  const projects = new ProjectRepository(h.db.db)
  const sessions = new SessionRepository(h.db.db)
  const projectId = randomUUID()
  projects.insert({
    id: projectId,
    slug: 'p1',
    repoUrl: 'https://github.com/example/p1',
    autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG, scheduledEnabled: true },
  })
  return { projects, sessions, projectId }
}

function failedSession(sessions: SessionRepository, projectId: string): void {
  const id = randomUUID()
  sessions.insert({ id, projectId, promptVersion: '1.1.0' })
  sessions.update(id, {
    status: 'failed',
    endedAt: new Date().toISOString(),
    prNumber: null,
  })
}

function successSession(sessions: SessionRepository, projectId: string): void {
  const id = randomUUID()
  sessions.insert({ id, projectId, promptVersion: '1.1.0' })
  sessions.update(id, {
    status: 'completed',
    endedAt: new Date().toISOString(),
    prNumber: 42,
    branchName: 'maestro/p1/x',
  })
}

function fixupCompletedSession(sessions: SessionRepository, projectId: string): void {
  const id = randomUUID()
  sessions.insert({ id, projectId, promptVersion: '1.1.0', isFixupTurn: true })
  sessions.update(id, {
    status: 'completed',
    endedAt: new Date().toISOString(),
    prNumber: 77,
    branchName: 'maestro/p1/fixup',
  })
}

describe('evaluateAutoPause', () => {
  it('triggers pause at the threshold of consecutive failures', () => {
    const { projects, sessions, projectId } = setup()
    for (let i = 0; i < 5; i++) failedSession(sessions, projectId)
    const project = projects.findById(projectId)!
    const r = evaluateAutoPause({ projects, sessions }, project)
    expect(r.transitioned).toBe('paused')
    const after = projects.findById(projectId)!
    expect(after.autoPausedAt).not.toBeNull()
    expect(after.autoPauseReason).toContain('consecutive failed sessions')
  })

  it('does NOT pause below the threshold', () => {
    const { projects, sessions, projectId } = setup()
    for (let i = 0; i < 4; i++) failedSession(sessions, projectId)
    const project = projects.findById(projectId)!
    const r = evaluateAutoPause({ projects, sessions }, project)
    expect(r.transitioned).toBeNull()
    expect(projects.findById(projectId)!.autoPausedAt).toBeNull()
  })

  it('a success in the recent window resets the counter', () => {
    const { projects, sessions, projectId } = setup()
    for (let i = 0; i < 3; i++) failedSession(sessions, projectId)
    successSession(sessions, projectId)
    for (let i = 0; i < 2; i++) failedSession(sessions, projectId)
    const r = evaluateAutoPause({ projects, sessions }, projects.findById(projectId)!)
    // 2 consecutive failures since the success — below threshold.
    expect(r.transitioned).toBeNull()
  })

  it('threshold is configurable for tests', () => {
    const { projects, sessions, projectId } = setup()
    for (let i = 0; i < 3; i++) failedSession(sessions, projectId)
    const project = projects.findById(projectId)!
    const r = evaluateAutoPause({ projects, sessions, threshold: 3 }, project)
    expect(r.transitioned).toBe('paused')
  })

  it('a completed fixup turn does not mask the failed-parent streak (ENG-02)', () => {
    const { projects, sessions, projectId } = setup()
    for (let i = 0; i < 5; i++) failedSession(sessions, projectId)
    // A fixup turn that COMPLETED is the newest row; it must not break the
    // streak of five failed parents underneath it.
    fixupCompletedSession(sessions, projectId)
    const r = evaluateAutoPause({ projects, sessions }, projects.findById(projectId)!)
    expect(r.transitioned).toBe('paused')
  })
})

describe('maybeClearAutoPauseOnManualSuccess', () => {
  it('clears auto-pause on a successful manual session', () => {
    const { projects, sessions, projectId } = setup()
    projects.setAutoPause('p1', 'auto-paused')
    expect(projects.findById(projectId)!.autoPausedAt).not.toBeNull()

    // A successful session.
    const id = randomUUID()
    sessions.insert({ id, projectId, promptVersion: '1.1.0' })
    const session = sessions.update(id, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      prNumber: 99,
      branchName: 'maestro/p1/y',
    })
    const cleared = maybeClearAutoPauseOnManualSuccess(
      { projects, sessions },
      projects.findById(projectId)!,
      session,
    )
    expect(cleared).toBe(true)
    expect(projects.findById(projectId)!.autoPausedAt).toBeNull()
  })

  it('does not clear when the session itself failed', () => {
    const { projects, sessions, projectId } = setup()
    projects.setAutoPause('p1', 'auto-paused')
    const id = randomUUID()
    sessions.insert({ id, projectId, promptVersion: '1.1.0' })
    const session = sessions.update(id, {
      status: 'failed',
      endedAt: new Date().toISOString(),
      prNumber: null,
    })
    const cleared = maybeClearAutoPauseOnManualSuccess(
      { projects, sessions },
      projects.findById(projectId)!,
      session,
    )
    expect(cleared).toBe(false)
    expect(projects.findById(projectId)!.autoPausedAt).not.toBeNull()
  })

  it('returns false when not paused', () => {
    const { projects, sessions, projectId } = setup()
    const id = randomUUID()
    sessions.insert({ id, projectId, promptVersion: '1.1.0' })
    const session = sessions.update(id, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      prNumber: 1,
      branchName: 'x',
    })
    const cleared = maybeClearAutoPauseOnManualSuccess(
      { projects, sessions },
      projects.findById(projectId)!,
      session,
    )
    expect(cleared).toBe(false)
  })
})

describe('reconcileAutoPauseAfterSession', () => {
  it('clears auto-pause after a successful MANUAL run (ENG-01)', () => {
    const { projects, sessions, projectId } = setup()
    projects.setAutoPause('p1', 'auto-paused')
    const id = randomUUID()
    sessions.insert({ id, projectId, promptVersion: '1.1.0' })
    const session = sessions.update(id, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      prNumber: 5,
      branchName: 'maestro/p1/z',
    })
    const r = reconcileAutoPauseAfterSession(
      { projects, sessions },
      projects.findById(projectId)!,
      session,
      { manual: true },
    )
    expect(r.transitioned).toBe('resumed')
    expect(projects.findById(projectId)!.autoPausedAt).toBeNull()
  })

  it('does NOT clear on a successful SCHEDULED run', () => {
    const { projects, sessions, projectId } = setup()
    projects.setAutoPause('p1', 'auto-paused')
    const id = randomUUID()
    sessions.insert({ id, projectId, promptVersion: '1.1.0' })
    const session = sessions.update(id, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      prNumber: 6,
      branchName: 'maestro/p1/z',
    })
    const r = reconcileAutoPauseAfterSession(
      { projects, sessions },
      projects.findById(projectId)!,
      session,
      { manual: false },
    )
    expect(r.transitioned).toBeNull()
    expect(projects.findById(projectId)!.autoPausedAt).not.toBeNull()
  })

  it('a failing manual run does not clear and can pause at threshold', () => {
    const { projects, sessions, projectId } = setup()
    for (let i = 0; i < 4; i++) failedSession(sessions, projectId)
    const id = randomUUID()
    sessions.insert({ id, projectId, promptVersion: '1.1.0' })
    const session = sessions.update(id, {
      status: 'failed',
      endedAt: new Date().toISOString(),
      prNumber: null,
    })
    const r = reconcileAutoPauseAfterSession(
      { projects, sessions },
      projects.findById(projectId)!,
      session,
      { manual: true },
    )
    expect(r.transitioned).toBe('paused')
    expect(projects.findById(projectId)!.autoPausedAt).not.toBeNull()
  })
})
