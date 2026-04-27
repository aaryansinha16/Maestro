// SQLite layer. Opens the database file under MAESTRO_DATA_DIR, runs every
// pending migration in lexicographic order, and exposes the prepared `Database`
// handle to the rest of the conductor.
//
// See ADR-003 for why SQLite. Schema lives in src/db/migrations/.

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MaestroError } from '@maestro/shared'
import { logger } from './logger.js'

const here = dirname(fileURLToPath(import.meta.url))

export interface DbHandle {
  db: Database.Database
  close: () => void
}

export interface OpenDbOptions {
  /** Directory in which to store maestro.db. Created if missing. */
  dataDir: string
  /** Override the migrations directory. Defaults to <here>/db/migrations. */
  migrationsDir?: string
  /** When true, opens an in-memory db. Used in tests. */
  memory?: boolean
}

export function openDatabase(options: OpenDbOptions): DbHandle {
  const dbPath = options.memory ? ':memory:' : resolveDbPath(options.dataDir)
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')

  ensureMigrationsTable(db)
  applyPendingMigrations(db, options.migrationsDir ?? defaultMigrationsDir())

  logger.info({ dbPath }, 'database opened')

  return {
    db,
    close: () => db.close(),
  }
}

function resolveDbPath(dataDir: string): string {
  const dir = resolve(dataDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'maestro.db')
}

function defaultMigrationsDir(): string {
  return join(here, 'db', 'migrations')
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `)
}

function applyPendingMigrations(db: Database.Database, migrationsDir: string): void {
  if (!existsSync(migrationsDir)) {
    throw new MaestroError('DB_MIGRATION_FAILED', {
      message: `Migrations directory not found: ${migrationsDir}`,
      context: { migrationsDir },
    })
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const appliedRows = db
    .prepare<[], { id: string }>('SELECT id FROM schema_migrations')
    .all()
  const applied = new Set(appliedRows.map((r) => r.id))

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(join(migrationsDir, file), 'utf-8')
    const tx = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file)
    })
    try {
      tx()
      logger.info({ migration: file }, 'applied migration')
    } catch (err) {
      throw new MaestroError('DB_MIGRATION_FAILED', {
        message: `Failed to apply migration ${file}`,
        cause: err,
        context: { migration: file },
      })
    }
  }
}
