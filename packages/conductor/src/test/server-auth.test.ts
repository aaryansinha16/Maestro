// Phase 5 / Sub 5.2 — HTTP Basic Auth.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DbHandle } from '../db.js'
import { buildServer, type ServerDeps } from '../server.js'

interface Harness {
  db: DbHandle
  root: string
}
let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-auth-'))
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

function server(extra: Partial<ServerDeps> = {}) {
  if (!h) throw new Error('harness missing')
  return buildServer({
    startedAt: Date.now(),
    version: 'test',
    db: h.db.db,
    dataDir: h.root,
    developerName: 'Tester',
    ...extra,
  })
}

const CREDS = { authUser: 'dev', authPassword: 'hunter22hunter22' }
const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

describe('basic auth', () => {
  it('401s API requests without credentials when auth is configured', async () => {
    const res = await server(CREDS).request('/api/projects')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Basic')
  })

  it('200s with correct credentials', async () => {
    const res = await server(CREDS).request('/api/projects', {
      headers: { authorization: basic('dev', 'hunter22hunter22') },
    })
    expect(res.status).toBe(200)
  })

  it('401s with wrong credentials', async () => {
    const res = await server(CREDS).request('/api/projects', {
      headers: { authorization: basic('dev', 'wrong-password') },
    })
    expect(res.status).toBe(401)
  })

  it('keeps /api/health open for platform healthchecks', async () => {
    const res = await server(CREDS).request('/api/health')
    expect(res.status).toBe(200)
  })

  it('auth disabled when credentials are not configured', async () => {
    const res = await server().request('/api/projects')
    expect(res.status).toBe(200)
  })

  it('auth disabled (with warning) when only one of the pair is set', async () => {
    const res = await server({ authUser: 'dev' }).request('/api/projects')
    expect(res.status).toBe(200)
  })
})
