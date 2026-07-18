// ENG-14 (SessionRepository.countSince) + ENG-11 (markProcessedForPrs is a
// best-effort no-op once the DB has been closed).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type DbHandle } from '../db.js'
import {
  ProjectRepository,
  SessionRepository,
  PrFeedbackRepository,
} from '../repositories.js'
import { DEFAULT_AUTONOMY_CONFIG } from '@maestro/shared'

let h: { db: DbHandle; root: string } | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-repo-'))
  h = { db: openDatabase({ dataDir: root }), root }
})

afterEach(async () => {
  if (h) {
    try {
      h.db.close()
    } catch {
      /* a test may have closed it already */
    }
    await rm(h.root, { recursive: true, force: true })
    h = null
  }
})

function seedProject(): { projectId: string; sessions: SessionRepository } {
  if (!h) throw new Error('harness missing')
  const projects = new ProjectRepository(h.db.db)
  const sessions = new SessionRepository(h.db.db)
  const projectId = randomUUID()
  projects.insert({
    id: projectId,
    slug: 'p1',
    repoUrl: 'https://github.com/example/p1',
    autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG },
  })
  return { projectId, sessions }
}

describe('SessionRepository.countSince (ENG-14)', () => {
  it('counts sessions started at/after the cutoff', () => {
    const { projectId, sessions } = seedProject()
    for (let i = 0; i < 3; i++) {
      sessions.insert({ id: randomUUID(), projectId, promptVersion: '1.1.0' })
    }
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    expect(sessions.countSince(projectId, todayStart.toISOString())).toBe(3)

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    expect(sessions.countSince(projectId, tomorrow.toISOString())).toBe(0)
  })
})

describe('PrFeedbackRepository.markProcessedForPrs (ENG-11)', () => {
  it('no-ops without throwing when the DB is already closed', () => {
    if (!h) throw new Error('harness missing')
    const feedback = new PrFeedbackRepository(h.db.db)
    h.db.close()
    expect(() =>
      feedback.markProcessedForPrs({ projectId: 'p', prNumbers: [1], sessionId: 's' }),
    ).not.toThrow()
    expect(
      feedback.markProcessedForPrs({ projectId: 'p', prNumbers: [1], sessionId: 's' }),
    ).toBe(0)
  })
})
