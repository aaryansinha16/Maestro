// Phase 5 / Sub 5.5 — GET /api/health/claude.
//
// The probe is made deterministic by pointing MAESTRO_CLAUDE_BIN at
// binaries with known behavior: /bin/echo exits 0 for any args
// (installed=true), a nonexistent path fails (installed=false).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DbHandle } from '../db.js'
import { buildServer } from '../server.js'

interface Harness {
  db: DbHandle
  root: string
}
let h: Harness | null = null
let savedBin: string | undefined

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-claude-health-'))
  const db = openDatabase({ dataDir: root })
  h = { db, root }
  savedBin = process.env['MAESTRO_CLAUDE_BIN']
})

afterEach(async () => {
  if (savedBin === undefined) delete process.env['MAESTRO_CLAUDE_BIN']
  else process.env['MAESTRO_CLAUDE_BIN'] = savedBin
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

interface ClaudeHealthBody {
  installed: boolean
  version: string | null
  authenticated: boolean | null
  credentialsAt: string | null
  configDir: string
}

describe('GET /api/health/claude', () => {
  it('reports installed=true with a version when the probe binary exits 0', async () => {
    process.env['MAESTRO_CLAUDE_BIN'] = '/bin/echo'
    const res = await server().request('/api/health/claude')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ClaudeHealthBody
    expect(body.installed).toBe(true)
    expect(body.version).toBeTruthy() // echo prints "--version"
    expect(typeof body.configDir).toBe('string')
  })

  it('reports installed=false when the binary does not exist', async () => {
    process.env['MAESTRO_CLAUDE_BIN'] = '/definitely/not/a/real/binary'
    const res = await server().request('/api/health/claude')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ClaudeHealthBody
    expect(body.installed).toBe(false)
    expect(body.version).toBeNull()
  })

  it('authenticated is boolean or null, never undefined', async () => {
    process.env['MAESTRO_CLAUDE_BIN'] = '/bin/echo'
    const res = await server().request('/api/health/claude')
    const body = (await res.json()) as ClaudeHealthBody
    expect([true, false, null]).toContain(body.authenticated)
  })
})
