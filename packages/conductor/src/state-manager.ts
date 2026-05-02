// .maestro/ file I/O for managed projects. Reads and writes state.md,
// context.md, autonomy.json, and the journal directory, with Zod validation
// at every boundary. File locks via proper-lockfile keep two writers out
// of the directory at once.
//
// IMPORTANT: the agent itself is responsible for editing .maestro/ during a
// session (per PROMPT_DESIGN.md). Maestro reads state for prompt
// construction and validates that the agent did its part on session exit;
// it does NOT mutate state.md or write journal entries on the agent's
// behalf except in `init`.

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import {
  AutonomyFileSchema,
  JOURNAL_FILENAME_LEGACY_RE,
  JOURNAL_FILENAME_RE,
  JournalEntrySchema,
  MAESTRO_DIR_NAME,
  MAESTRO_PATHS,
  MaestroError,
  ProjectStateSchema,
  type JournalEntry,
  type ProjectAutonomyConfig,
  type ProjectState,
} from '@maestro/shared'
import { logger } from './logger.js'

// ─── Paths ───────────────────────────────────────────────────────────

export interface ProjectPaths {
  root: string
  maestroDir: string
  state: string
  context: string
  decisions: string
  autonomy: string
  journalDir: string
}

export function projectPaths(projectRoot: string): ProjectPaths {
  const maestroDir = join(projectRoot, MAESTRO_DIR_NAME)
  return {
    root: projectRoot,
    maestroDir,
    state: join(maestroDir, MAESTRO_PATHS.state),
    context: join(maestroDir, MAESTRO_PATHS.context),
    decisions: join(maestroDir, MAESTRO_PATHS.decisions),
    autonomy: join(maestroDir, MAESTRO_PATHS.autonomy),
    journalDir: join(maestroDir, MAESTRO_PATHS.journal),
  }
}

// ─── Validators ──────────────────────────────────────────────────────

export interface ValidatedMaestroDir {
  state: ProjectState
  context: string
  autonomy: ProjectAutonomyConfig
}

/**
 * Read state.md, context.md, autonomy.json from disk and parse them
 * through their Zod schemas. Aborts with a structured MaestroError if any
 * file is missing or malformed — the developer must repair `.maestro/`
 * before sessions can run.
 */
export async function readMaestroDir(projectRoot: string): Promise<ValidatedMaestroDir> {
  const paths = projectPaths(projectRoot)

  if (!existsSync(paths.maestroDir)) {
    throw new MaestroError('CONTEXT_FILE_MISSING', {
      message: `${MAESTRO_DIR_NAME}/ does not exist in ${projectRoot}`,
      context: { projectRoot },
    })
  }

  const [stateBody, contextBody, autonomyBody] = await Promise.all([
    safeRead(paths.state, 'state.md'),
    safeRead(paths.context, 'context.md'),
    safeRead(paths.autonomy, 'autonomy.json'),
  ])

  const state = ProjectStateSchema.parse({
    raw: stateBody,
    path: relPath(paths.root, paths.state),
  })

  let autonomy: ProjectAutonomyConfig
  try {
    autonomy = AutonomyFileSchema.parse(JSON.parse(autonomyBody))
  } catch (err) {
    throw new MaestroError('AUTONOMY_CONFIG_INVALID', {
      message: 'autonomy.json failed validation',
      cause: err,
      context: { path: paths.autonomy },
    })
  }

  return { state, context: contextBody, autonomy }
}

async function safeRead(path: string, kind: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch (err) {
    throw new MaestroError('CONTEXT_FILE_MISSING', {
      message: `Failed to read ${kind} at ${path}`,
      cause: err,
      context: { path, kind },
    })
  }
}

function relPath(base: string, target: string): string {
  if (target.startsWith(base)) return target.slice(base.length).replace(/^\/+/, '')
  return target
}

// ─── Journal ─────────────────────────────────────────────────────────

function isJournalFilename(name: string): boolean {
  return JOURNAL_FILENAME_RE.test(name) || JOURNAL_FILENAME_LEGACY_RE.test(name)
}

/**
 * Migrate legacy minute-granularity journal filenames to seconds.
 *
 *   2026-04-15-08-00.md → 2026-04-15-08-00-00.md
 *
 * Idempotent: only renames files that match the legacy regex but not the
 * new one. Returns the number of files migrated. Safe to call on every
 * read because it's a no-op once journals are on the new format.
 */
export async function migrateJournalFilenames(projectRoot: string): Promise<number> {
  const paths = projectPaths(projectRoot)
  if (!existsSync(paths.journalDir)) return 0
  const entries = await readdir(paths.journalDir)
  let migrated = 0
  for (const name of entries) {
    if (JOURNAL_FILENAME_RE.test(name)) continue
    if (!JOURNAL_FILENAME_LEGACY_RE.test(name)) continue
    const newName = name.replace(/\.md$/, '-00.md')
    const fullOld = join(paths.journalDir, name)
    const fullNew = join(paths.journalDir, newName)
    if (existsSync(fullNew)) {
      logger.warn(
        { fullOld, fullNew },
        'journal migration target already exists — leaving legacy filename',
      )
      continue
    }
    await rename(fullOld, fullNew)
    migrated++
  }
  if (migrated > 0) {
    logger.info({ projectRoot, migrated }, 'migrated legacy journal filenames')
  }
  return migrated
}

export async function listJournalEntries(projectRoot: string): Promise<JournalEntry[]> {
  const paths = projectPaths(projectRoot)
  if (!existsSync(paths.journalDir)) return []

  await migrateJournalFilenames(projectRoot)

  const filenames = (await readdir(paths.journalDir))
    .filter(isJournalFilename)
    .sort() // lexicographic == chronological for ISO-ish names

  const entries: JournalEntry[] = []
  for (const filename of filenames) {
    const body = await readFile(join(paths.journalDir, filename), 'utf-8')
    const timestamp = filenameToIso(filename)
    entries.push(
      JournalEntrySchema.parse({
        filename,
        sessionId: null,
        timestamp,
        body,
      }),
    )
  }
  return entries
}

export async function listRecentJournal(
  projectRoot: string,
  limit: number,
): Promise<JournalEntry[]> {
  const all = await listJournalEntries(projectRoot)
  return all.slice(-limit)
}

function filenameToIso(filename: string): string {
  // 2026-04-15-08-00-00.md → 2026-04-15T08:00:00.000Z
  // 2026-04-15-08-00.md (legacy) → 2026-04-15T08:00:00.000Z
  const withSecs = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.md$/.exec(filename)
  if (withSecs) {
    const [, y, m, d, hh, mm, ss] = withSecs
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}.000Z`
  }
  const noSecs = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.md$/.exec(filename)
  if (noSecs) {
    const [, y, m, d, hh, mm] = noSecs
    return `${y}-${m}-${d}T${hh}:${mm}:00.000Z`
  }
  throw new MaestroError('STATE_PARSE_FAILED', {
    message: `Bad journal filename: ${filename}`,
    context: { filename },
  })
}

// ─── Init flow ───────────────────────────────────────────────────────

export interface InitMaestroDirInput {
  projectRoot: string
  state: string
  context: string
  autonomy: ProjectAutonomyConfig
  /** Optional decisions.md seed. */
  decisions?: string
}

/**
 * Create a fresh `.maestro/` skeleton. Used by `maestro init`. Refuses to
 * overwrite an existing directory.
 */
export async function initMaestroDir(input: InitMaestroDirInput): Promise<void> {
  const paths = projectPaths(input.projectRoot)
  if (existsSync(paths.maestroDir)) {
    throw new MaestroError('STATE_WRITE_FAILED', {
      message: `${MAESTRO_DIR_NAME}/ already exists in ${input.projectRoot}`,
      context: { path: paths.maestroDir },
    })
  }
  await mkdir(paths.maestroDir, { recursive: true })
  await mkdir(paths.journalDir, { recursive: true })
  await Promise.all([
    writeFile(paths.state, ensureTrailingNewline(input.state), 'utf-8'),
    writeFile(paths.context, ensureTrailingNewline(input.context), 'utf-8'),
    writeFile(
      paths.decisions,
      ensureTrailingNewline(input.decisions ?? defaultDecisions()),
      'utf-8',
    ),
    writeFile(paths.autonomy, JSON.stringify(input.autonomy, null, 2) + '\n', 'utf-8'),
    writeFile(join(paths.journalDir, '.gitkeep'), '', 'utf-8'),
  ])

  // Validate what we just wrote — same path the worker takes.
  await readMaestroDir(input.projectRoot)
}

function defaultDecisions(): string {
  return [
    '# Project Decisions',
    '',
    'Track significant choices and the reasoning behind them. The agent reads',
    'this every session and respects past decisions unless state.md',
    'explicitly overrides one.',
    '',
  ].join('\n')
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n'
}

// ─── Validation of agent output ──────────────────────────────────────

export interface MaestroDirAgentOutputCheck {
  stateUpdated: boolean
  journalAppended: boolean
  newJournalFile: string | null
}

/**
 * After a session, verify the agent updated state.md and dropped a new
 * journal entry. Compares against a snapshot taken at session start.
 */
export async function verifyAgentTouchedMaestroDir(
  projectRoot: string,
  before: { stateMTimeMs: number; journalFilenames: string[] },
): Promise<MaestroDirAgentOutputCheck> {
  const paths = projectPaths(projectRoot)
  const stateStat = await stat(paths.state)
  const stateUpdated = stateStat.mtimeMs > before.stateMTimeMs
  const after = (await readdir(paths.journalDir).catch(() => [])).filter(isJournalFilename)
  const newFiles = after.filter((f) => !before.journalFilenames.includes(f))
  return {
    stateUpdated,
    journalAppended: newFiles.length > 0,
    newJournalFile: newFiles[0] ?? null,
  }
}

export async function snapshotMaestroDir(projectRoot: string): Promise<{
  stateMTimeMs: number
  journalFilenames: string[]
}> {
  const paths = projectPaths(projectRoot)
  const stateStat = await stat(paths.state)
  const journal = (await readdir(paths.journalDir).catch(() => [])).filter(isJournalFilename)
  return { stateMTimeMs: stateStat.mtimeMs, journalFilenames: journal }
}

// ─── Locking ─────────────────────────────────────────────────────────

/**
 * Run `fn` while holding a filesystem lock on the project's `.maestro/`
 * directory. Uses proper-lockfile so two processes cannot stomp on the
 * directory at once.
 */
export async function withMaestroDirLock<T>(
  projectRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const paths = projectPaths(projectRoot)
  if (!existsSync(paths.maestroDir)) {
    throw new MaestroError('CONTEXT_FILE_MISSING', {
      message: `${MAESTRO_DIR_NAME}/ does not exist`,
      context: { path: paths.maestroDir },
    })
  }
  const release = await lockfile.lock(paths.maestroDir, {
    retries: { retries: 5, factor: 1.5, minTimeout: 100, maxTimeout: 2000 },
    stale: 5 * 60 * 1000,
  })
  try {
    return await fn()
  } finally {
    await release()
  }
}

// Walk up from cwd looking for a directory containing `.maestro/`. Used by
// the CLI when `<project-path>` isn't passed explicitly.
export async function findProjectRootFromCwd(start = process.cwd()): Promise<string | null> {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, MAESTRO_DIR_NAME))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}
