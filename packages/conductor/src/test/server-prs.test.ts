// UI-02: merge a Maestro PR from the dashboard via
// POST /api/projects/:slug/prs/:number/merge.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type DbHandle } from '../db.js'
import { ProjectRepository } from '../repositories.js'
import { buildServer } from '../server.js'
import { DEFAULT_AUTONOMY_CONFIG } from '@maestro/shared'
import type { GitHubClient } from '../pr-manager.js'

let h: { db: DbHandle; root: string } | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-prs-'))
  h = { db: openDatabase({ dataDir: root }), root }
})

afterEach(async () => {
  if (h) {
    h.db.close()
    await rm(h.root, { recursive: true, force: true })
    h = null
  }
})

function addProject(slug: string): void {
  if (!h) throw new Error('harness missing')
  new ProjectRepository(h.db.db).insert({
    id: randomUUID(),
    slug,
    repoUrl: `https://github.com/example/${slug}`,
    autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG },
  })
}

function serverWith(merge: GitHubClient['mergePullRequest']) {
  if (!h) throw new Error('harness missing')
  const github = { mergePullRequest: merge } as unknown as GitHubClient
  return buildServer({
    startedAt: Date.now(),
    version: 'test',
    db: h.db.db,
    dataDir: h.root,
    developerName: 'Tester',
    githubClient: github,
  })
}

describe('POST /api/projects/:slug/prs/:number/merge (UI-02)', () => {
  it('merges via the GitHub client', async () => {
    addProject('p')
    const app = serverWith(async () => ({ status: 'merged', sha: 'abc123' }))
    const res = await app.request('/api/projects/p/prs/42/merge', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ merged: true, sha: 'abc123' })
  })

  it('surfaces a blocked merge as { merged:false, reason }', async () => {
    addProject('p')
    const app = serverWith(async () => ({ status: 'blocked', reason: 'branch protection' }))
    const res = await app.request('/api/projects/p/prs/42/merge', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ merged: false, reason: 'branch protection' })
  })

  it('400s on an invalid PR number', async () => {
    addProject('p')
    const app = serverWith(async () => ({ status: 'merged', sha: 'x' }))
    const res = await app.request('/api/projects/p/prs/0/merge', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('404s for an unknown project', async () => {
    const app = serverWith(async () => ({ status: 'merged', sha: 'x' }))
    const res = await app.request('/api/projects/nope/prs/1/merge', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
