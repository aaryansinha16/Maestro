// Phase 4.5 / Sub 4.5.3 — POST /api/projects/:slug/autonomy.
//
// Validates: partial bodies round-trip through AutonomyFileSchema and
// persist to the SQLite row; nested fields (branches, github) deep-merge
// instead of replacing; invalid bodies return 400.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type DbHandle } from '../db.js'
import { ProjectRepository } from '../repositories.js'
import { buildServer } from '../server.js'
import { DEFAULT_AUTONOMY_CONFIG } from '@maestro/shared'

interface Harness {
  db: DbHandle
  root: string
}
let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-server-autonomy-'))
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

function addProject(slug: string) {
  if (!h) throw new Error('harness missing')
  const id = randomUUID()
  new ProjectRepository(h.db.db).insert({
    id,
    slug,
    repoUrl: `https://github.com/example/${slug}`,
    autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG },
  })
  return id
}

function server() {
  if (!h) throw new Error('harness missing')
  return buildServer({
    startedAt: Date.now(),
    version: 'test',
    db: h.db.db,
    dataDir: h.root,
    developerName: 'Tester',
  })
}

function postAutonomy(slug: string, body: unknown) {
  return server().request(`/api/projects/${slug}/autonomy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/projects/:slug/autonomy', () => {
  it('persists a partial body and leaves other fields alone', async () => {
    addProject('p')
    const res = await postAutonomy('p', {
      level: 'full',
      timeBudget: 3600,
      continueUntilBudget: true,
    })
    expect(res.status).toBe(200)
    if (!h) throw new Error('harness missing')
    const project = new ProjectRepository(h.db.db).findBySlug('p')
    expect(project?.autonomyConfig.level).toBe('full')
    expect(project?.autonomyConfig.timeBudget).toBe(3600)
    expect(project?.autonomyConfig.continueUntilBudget).toBe(true)
    // Untouched fields retain defaults.
    expect(project?.autonomyConfig.qualityGates).toEqual(
      DEFAULT_AUTONOMY_CONFIG.qualityGates,
    )
    expect(project?.autonomyConfig.schedule).toBe(DEFAULT_AUTONOMY_CONFIG.schedule)
  })

  it('deep-merges nested branches + github objects', async () => {
    addProject('p')
    const res = await postAutonomy('p', {
      branches: { base: 'develop' },
      github: { draftByDefault: true },
    })
    expect(res.status).toBe(200)
    if (!h) throw new Error('harness missing')
    const project = new ProjectRepository(h.db.db).findBySlug('p')
    // Patched fields take the new value:
    expect(project?.autonomyConfig.branches.base).toBe('develop')
    expect(project?.autonomyConfig.github.draftByDefault).toBe(true)
    // Sibling fields inside the nested objects survive:
    expect(project?.autonomyConfig.branches.prefix).toBe(
      DEFAULT_AUTONOMY_CONFIG.branches.prefix,
    )
    expect(project?.autonomyConfig.github.prLabels).toEqual(
      DEFAULT_AUTONOMY_CONFIG.github.prLabels,
    )
  })

  it('rejects an invalid level', async () => {
    addProject('p')
    const res = await postAutonomy('p', { level: 'not-a-real-level' })
    expect(res.status).toBe(400)
  })

  it('rejects negative timeBudget', async () => {
    addProject('p')
    const res = await postAutonomy('p', { timeBudget: -1 })
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown project', async () => {
    const res = await postAutonomy('does-not-exist', { level: 'full' })
    expect(res.status).toBe(404)
  })
})
