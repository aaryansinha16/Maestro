// PROD-04 (readiness probe) + PROD-05 (security headers).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DbHandle } from '../db.js'
import { buildServer } from '../server.js'

let h: { db: DbHandle; root: string } | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-health-'))
  h = { db: openDatabase({ dataDir: root }), root }
})

afterEach(async () => {
  if (h) {
    h.db.close()
    await rm(h.root, { recursive: true, force: true })
    h = null
  }
})

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

describe('health + hardening', () => {
  it('GET /api/health/ready returns 200 with db ok (PROD-04)', async () => {
    const res = await server().request('/api/health/ready')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ready', db: true })
  })

  it('sets security headers on responses (PROD-05)', async () => {
    const res = await server().request('/api/health')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('GET /api/settings returns non-secret config (UI-01)', async () => {
    const res = await server().request('/api/settings')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ version: 'test', authEnabled: false, githubConfigured: false })
    // Never leak secret values.
    expect(body).not.toHaveProperty('authPassword')
    expect(body).not.toHaveProperty('githubToken')
  })
})
