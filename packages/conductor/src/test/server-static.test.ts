// Phase 5 / Sub 5.1 — static dashboard serving.
//
// Asserts: exact assets serve with the right content-type + cache headers,
// SPA routes fall back to index.html, /api keeps JSON 404 semantics, and
// path traversal cannot escape the dashboard root.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DbHandle } from '../db.js'
import { buildServer } from '../server.js'

interface Harness {
  db: DbHandle
  root: string
  dashboardDir: string
}
let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-static-'))
  const db = openDatabase({ dataDir: root })
  const dashboardDir = join(root, 'dashboard')
  await mkdir(join(dashboardDir, 'assets'), { recursive: true })
  await writeFile(join(dashboardDir, 'index.html'), '<!doctype html><div id="app">maestro</div>')
  await writeFile(join(dashboardDir, 'assets', 'index-abc123.js'), 'console.log("app")')
  await writeFile(join(root, 'secret.txt'), 'do-not-serve')
  h = { db, root, dashboardDir }
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
    dashboardDir: h.dashboardDir,
  })
}

describe('static dashboard serving', () => {
  it('serves index.html at /', async () => {
    const res = await server().request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('maestro')
  })

  it('serves hashed assets with immutable caching', async () => {
    const res = await server().request('/assets/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toContain('console.log')
  })

  it('falls back to index.html for SPA routes', async () => {
    const res = await server().request('/projects/some-slug/feedback')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('keeps JSON 404 semantics for unmatched /api paths', async () => {
    const res = await server().request('/api/definitely-not-a-route')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('still serves real API routes first', async () => {
    const res = await server().request('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  it('does not serve files outside the dashboard root', async () => {
    // ../secret.txt sits next to the dashboard dir; traversal must not
    // reach it. Either 404 or SPA fallback is fine — never the secret.
    const res = await server().request('/..%2Fsecret.txt')
    const text = await res.text()
    expect(text).not.toContain('do-not-serve')
  })

  it('omitting dashboardDir keeps the API-only behavior', async () => {
    if (!h) throw new Error('harness missing')
    const app = buildServer({
      startedAt: Date.now(),
      version: 'test',
      db: h.db.db,
      dataDir: h.root,
      developerName: 'Tester',
    })
    const res = await app.request('/')
    expect(res.status).toBe(404)
  })
})
