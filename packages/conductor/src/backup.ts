// Phase 5 / Sub 5.3 — SQLite backups + session-log GC.
//
// Backups use better-sqlite3's online backup API (safe against a live WAL
// database) into MAESTRO_DATA_DIR/backups/, keeping the newest N files.
// Session logs under logs/sessions/ are GC'd after a retention window.
// Both run from one daily housekeeping cron; `maestro backup` and
// POST /api/admin/backup trigger the backup path manually.

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import cron from 'node-cron'
import { logger } from './logger.js'

export const BACKUPS_SUBDIR = 'backups'
export const DEFAULT_BACKUPS_TO_KEEP = 30
export const DEFAULT_SESSION_LOG_RETENTION_DAYS = 30
/** 04:00 UTC daily — after most scheduled sessions, before the briefing. */
export const DEFAULT_HOUSEKEEPING_CRON = '0 4 * * *'

// ─── Backup ──────────────────────────────────────────────────────────

export interface RunBackupInput {
  db: Database.Database
  dataDir: string
  /** Newest N backups to retain. Older ones are deleted. */
  keep?: number
  /** Injected clock for deterministic filenames in tests. */
  now?: () => Date
}

export interface BackupResult {
  path: string
  prunedCount: number
}

export async function runBackupNow(input: RunBackupInput): Promise<BackupResult> {
  const keep = input.keep ?? DEFAULT_BACKUPS_TO_KEEP
  const dir = join(input.dataDir, BACKUPS_SUBDIR)
  await mkdir(dir, { recursive: true })

  const ts = (input.now ?? (() => new Date()))()
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[T:]/g, '-')
  const dest = join(dir, `maestro-${ts}.db`)

  await input.db.backup(dest)

  // Prune: lexicographic sort of the timestamped names == chronological.
  const entries = (await readdir(dir))
    .filter((f) => /^maestro-.*\.db$/.test(f))
    .sort()
    .reverse()
  const stale = entries.slice(keep)
  for (const f of stale) {
    await rm(join(dir, f), { force: true })
  }

  logger.info({ dest, prunedCount: stale.length }, 'backup complete')
  return { path: dest, prunedCount: stale.length }
}

// ─── Session-log GC ──────────────────────────────────────────────────

export interface GcSessionLogsInput {
  dataDir: string
  retentionDays?: number
  now?: () => Date
}

export async function gcSessionLogs(input: GcSessionLogsInput): Promise<number> {
  const retentionDays = input.retentionDays ?? DEFAULT_SESSION_LOG_RETENTION_DAYS
  const dir = join(input.dataDir, 'logs', 'sessions')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0 // no session logs yet
  }
  const cutoff =
    (input.now ?? (() => new Date()))().getTime() - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of entries) {
    if (!name.endsWith('.log')) continue
    const full = join(dir, name)
    try {
      const info = await stat(full)
      if (info.mtimeMs < cutoff) {
        await rm(full, { force: true })
        removed += 1
      }
    } catch {
      /* raced with another deleter — ignore */
    }
  }
  if (removed > 0) logger.info({ removed, retentionDays }, 'session-log GC complete')
  return removed
}

// ─── Housekeeping cron ───────────────────────────────────────────────

export interface StartHousekeepingInput {
  db: Database.Database
  dataDir: string
  schedule?: string
  keep?: number
  retentionDays?: number
  /** Injectable for tests; defaults to node-cron. */
  cronImpl?: Pick<typeof cron, 'schedule'>
}

export interface Housekeeping {
  stop(): void
  /** Exposed so the API endpoint and CLI share the exact same path. */
  runNow(): Promise<BackupResult>
}

export function startHousekeeping(input: StartHousekeepingInput): Housekeeping {
  const impl = input.cronImpl ?? cron
  const task = impl.schedule(
    input.schedule ?? DEFAULT_HOUSEKEEPING_CRON,
    () => {
      void (async () => {
        try {
          await runBackupNow({
            db: input.db,
            dataDir: input.dataDir,
            ...(input.keep !== undefined ? { keep: input.keep } : {}),
          })
          await gcSessionLogs({
            dataDir: input.dataDir,
            ...(input.retentionDays !== undefined
              ? { retentionDays: input.retentionDays }
              : {}),
          })
        } catch (err) {
          logger.error({ err }, 'housekeeping tick failed')
        }
      })()
    },
    { timezone: 'UTC' },
  )
  logger.info(
    { schedule: input.schedule ?? DEFAULT_HOUSEKEEPING_CRON },
    'housekeeping scheduled',
  )
  return {
    stop: () => task.stop(),
    runNow: () =>
      runBackupNow({
        db: input.db,
        dataDir: input.dataDir,
        ...(input.keep !== undefined ? { keep: input.keep } : {}),
      }),
  }
}
