// Phase 5 / Sub 5.3 — backups + session-log GC.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, mkdir, rm, utimes, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type DbHandle } from '../db.js'
import { ProjectRepository } from '../repositories.js'
import { gcSessionLogs, runBackupNow, BACKUPS_SUBDIR } from '../backup.js'
import { DEFAULT_AUTONOMY_CONFIG } from '@maestro/shared'

interface Harness {
  db: DbHandle
  root: string
}
let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-backup-'))
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

describe('runBackupNow', () => {
  it('produces a backup that opens and contains the data', async () => {
    if (!h) throw new Error('harness missing')
    new ProjectRepository(h.db.db).insert({
      id: randomUUID(),
      slug: 'backed-up',
      repoUrl: 'https://github.com/example/backed-up',
      autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG },
    })

    const result = await runBackupNow({ db: h.db.db, dataDir: h.root })
    expect(result.path).toContain(BACKUPS_SUBDIR)
    expect(result.prunedCount).toBe(0)

    const restored = new Database(result.path, { readonly: true })
    try {
      const row = restored
        .prepare<[], { slug: string }>('SELECT slug FROM projects')
        .get()
      expect(row?.slug).toBe('backed-up')
    } finally {
      restored.close()
    }
  })

  it('prunes beyond the keep limit, oldest first', async () => {
    if (!h) throw new Error('harness missing')
    const dir = join(h.root, BACKUPS_SUBDIR)
    await mkdir(dir, { recursive: true })
    // Pre-seed three stale "backups" with lexicographically old names.
    for (const name of ['maestro-2026-01-01-00-00-00.db', 'maestro-2026-01-02-00-00-00.db', 'maestro-2026-01-03-00-00-00.db']) {
      await writeFile(join(dir, name), 'stale')
    }
    const result = await runBackupNow({
      db: h.db.db,
      dataDir: h.root,
      keep: 2,
      now: () => new Date('2026-05-18T04:00:00.000Z'),
    })
    expect(result.prunedCount).toBe(2)
    const remaining = (await readdir(dir)).sort()
    expect(remaining).toEqual([
      'maestro-2026-01-03-00-00-00.db',
      'maestro-2026-05-18-04-00-00.db',
    ])
  })
})

describe('gcSessionLogs', () => {
  it('removes logs older than retention, keeps fresh ones', async () => {
    if (!h) throw new Error('harness missing')
    const dir = join(h.root, 'logs', 'sessions')
    await mkdir(dir, { recursive: true })
    const oldLog = join(dir, 'old-session.log')
    const newLog = join(dir, 'new-session.log')
    await writeFile(oldLog, 'old')
    await writeFile(newLog, 'new')
    // Age the old one to 40 days.
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await utimes(oldLog, fortyDaysAgo, fortyDaysAgo)

    const removed = await gcSessionLogs({ dataDir: h.root, retentionDays: 30 })
    expect(removed).toBe(1)
    const remaining = await readdir(dir)
    expect(remaining).toEqual(['new-session.log'])
  })

  it('returns 0 when the sessions dir does not exist', async () => {
    if (!h) throw new Error('harness missing')
    const removed = await gcSessionLogs({ dataDir: join(h.root, 'nope') })
    expect(removed).toBe(0)
  })
})
