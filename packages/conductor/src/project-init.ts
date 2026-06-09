// Phase 4.5 / Sub 4.5.4 — pure rendering logic for `.maestro/` scaffolding.
//
// Extracted from scripts/cli/init.ts so the dashboard's init endpoint and
// the CLI share one implementation. Everything here is side-effect-free:
// the CLI wraps these with prompts + disk writes (initMaestroDir), the
// server wraps them with GitHub-API commits (github-scaffolder).

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import {
  AutonomyFileSchema,
  DEFAULT_AUTONOMY_CONFIG,
  DEFAULT_QUALITY_GATES,
  DEFAULT_TIME_BUDGET_SECONDS,
  type ProjectAutonomyConfig,
} from '@maestro/shared'

// ─── state.md ────────────────────────────────────────────────────────

export interface RenderStateMdInput {
  focus: string
  tasks: string[]
}

export function renderStateMd(args: RenderStateMdInput): string {
  const taskLines =
    args.tasks.length > 0
      ? args.tasks.map((t) => `- [ ] ${t}`).join('\n')
      : '- [ ] _add 3-5 concrete tasks here_'
  return [
    '# Current State',
    '',
    '## Focus',
    args.focus.trim(),
    '',
    '## Next Concrete Tasks',
    taskLines,
    '',
    '## Blockers',
    '',
    '_(none)_',
    '',
    '## Recent Context',
    '',
    'Project initialised by `maestro init`. The first session is for orientation only.',
    '',
    '## Notes',
    '',
    '',
  ].join('\n')
}

// ─── context.md ──────────────────────────────────────────────────────

/**
 * Data the context renderer consumes. The CLI builds this from disk
 * reads (scrapeContextFromDisk); the dashboard probe builds it from
 * GitHub API responses. Same renderer either way.
 */
export interface ContextSeed {
  projectName: string
  /** package.json description, when present. */
  description?: string
  /** package.json scripts, when present. */
  scripts?: Record<string, string>
  /** Dependency names (already filtered/capped by the caller). */
  dependencies?: string[]
  /** "Python project (pyproject.toml)…" style hint for non-Node stacks. */
  stackNote?: string
  /** Top-level files/dirs. Directories carry a trailing slash already or use isDir. */
  topLevel?: Array<{ name: string; isDir: boolean }>
  /** First ~30 lines of README, trimmed. */
  readmeExcerpt?: string
}

export function renderContextMd(seed: ContextSeed): string {
  const lines: string[] = []
  lines.push(`# Project Context — ${seed.projectName}`)
  lines.push('')
  lines.push('## Stack')
  lines.push('')
  if (seed.stackNote) {
    lines.push(seed.stackNote)
  } else {
    lines.push('Detected from package.json. Update freely.')
  }
  if (seed.description) {
    lines.push('')
    lines.push(`> ${seed.description}`)
  }
  if (seed.scripts && Object.keys(seed.scripts).length > 0) {
    lines.push('')
    lines.push('### Scripts')
    lines.push('')
    for (const [name, value] of Object.entries(seed.scripts)) {
      lines.push(`- \`${name}\`: \`${value}\``)
    }
  }
  if (seed.dependencies && seed.dependencies.length > 0) {
    lines.push('')
    lines.push('### Notable dependencies')
    lines.push('')
    lines.push(seed.dependencies.map((d) => `- ${d}`).join('\n'))
  }
  if (seed.topLevel && seed.topLevel.length > 0) {
    lines.push('')
    lines.push('## Top-level layout')
    lines.push('')
    lines.push(
      seed.topLevel.map((e) => `- \`${e.name}${e.isDir ? '/' : ''}\``).join('\n'),
    )
  }
  if (seed.readmeExcerpt && seed.readmeExcerpt.length > 0) {
    lines.push('')
    lines.push('## README excerpt')
    lines.push('')
    lines.push(seed.readmeExcerpt)
  }
  lines.push('')
  lines.push('## Conventions')
  lines.push('')
  lines.push('- Code style: _fill in_')
  lines.push('- Commit format: _fill in_')
  lines.push('- Test patterns: _fill in_')
  lines.push('')
  lines.push('## Project-specific NEVER list')
  lines.push('')
  lines.push('_Add anything the agent must not touch without explicit state.md instruction._')
  return lines.join('\n') + '\n'
}

/** Filter + cap dependency names the way the CLI scrape always has. */
export function notableDependencies(
  deps: Record<string, string> | undefined,
  devDeps: Record<string, string> | undefined,
): string[] {
  return Object.keys({ ...deps, ...devDeps })
    .filter((d) => !d.startsWith('@types/'))
    .slice(0, 12)
}

/**
 * Build a ContextSeed from a package.json body (string or parsed).
 * Returns null when the body isn't valid JSON. Shared by the disk scrape
 * and the GitHub probe.
 */
export function seedFromPackageJson(body: string, fallbackName: string): ContextSeed | null {
  try {
    const pkg = JSON.parse(body) as {
      name?: string
      description?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const seed: ContextSeed = {
      projectName: pkg.name ?? fallbackName,
    }
    if (pkg.description) seed.description = pkg.description
    if (pkg.scripts) seed.scripts = pkg.scripts
    const deps = notableDependencies(pkg.dependencies, pkg.devDependencies)
    if (deps.length > 0) seed.dependencies = deps
    return seed
  } catch {
    return null
  }
}

export interface ScrapedContext {
  name: string
  contextMd: string
}

/**
 * Disk-reading wrapper used by `maestro init`: inspects the local working
 * tree and renders the seed context.
 */
export async function scrapeContextFromDisk(projectRoot: string): Promise<ScrapedContext> {
  const fallbackName = projectRoot.split('/').slice(-1)[0] ?? 'project'
  let seed: ContextSeed = { projectName: fallbackName }

  const pkgPath = `${projectRoot}/package.json`
  if (existsSync(pkgPath)) {
    const parsed = seedFromPackageJson(await readFile(pkgPath, 'utf-8'), fallbackName)
    if (parsed) seed = parsed
  } else if (existsSync(`${projectRoot}/pyproject.toml`)) {
    seed.stackNote = 'Python project (pyproject.toml). Fill in framework, deps, etc.'
  } else if (existsSync(`${projectRoot}/Cargo.toml`)) {
    seed.stackNote = 'Rust project (Cargo.toml).'
  } else {
    seed.stackNote = 'Unrecognised project layout. Describe it here.'
  }

  try {
    const entries = (await readdir(projectRoot, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, 20)
    if (entries.length > 0) {
      seed.topLevel = entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    }
  } catch {
    /* ignore */
  }

  for (const candidate of ['README.md', 'README', 'Readme.md']) {
    const p = `${projectRoot}/${candidate}`
    if (existsSync(p)) {
      try {
        const body = await readFile(p, 'utf-8')
        const excerpt = body.split('\n').slice(0, 30).join('\n').trim()
        if (excerpt.length > 0) seed.readmeExcerpt = excerpt
      } catch {
        /* ignore */
      }
      break
    }
  }

  return { name: seed.projectName, contextMd: renderContextMd(seed) }
}

// ─── autonomy.json ───────────────────────────────────────────────────

export interface AutonomyAnswers {
  level: ProjectAutonomyConfig['level']
  schedule: string
  timeBudgetMinutes: number
  qualityGates: ProjectAutonomyConfig['qualityGates']
  branchPrefix: string
}

export function buildAutonomyFromAnswers(r: AutonomyAnswers): ProjectAutonomyConfig {
  const draft = {
    level: r.level,
    schedule: r.schedule,
    timeBudget: Math.round(r.timeBudgetMinutes * 60),
    qualityGates: r.qualityGates,
    branches: {
      base: 'main',
      prefix: r.branchPrefix.endsWith('/') ? r.branchPrefix : `${r.branchPrefix}/`,
    },
    github: {
      prLabels: ['maestro'],
      draftByDefault: r.level === 'draft-only',
    },
    skipDays: [],
    maxSessionsPerDay: 6,
  }
  return AutonomyFileSchema.parse(draft)
}

export const AUTONOMY_ANSWER_DEFAULTS: AutonomyAnswers = {
  level: 'pr-only',
  schedule: DEFAULT_AUTONOMY_CONFIG.schedule,
  timeBudgetMinutes: DEFAULT_TIME_BUDGET_SECONDS / 60,
  qualityGates: DEFAULT_QUALITY_GATES,
  branchPrefix: 'maestro/',
}

// ─── File map for the GitHub-API scaffold path ───────────────────────

export interface BuildMaestroFilesInput {
  state: string
  context: string
  autonomy: ProjectAutonomyConfig
  decisions?: string
}

/**
 * The exact `.maestro/` file set initMaestroDir writes to disk, as a
 * path → content map for github-scaffolder to commit. Keep in sync with
 * state-manager.initMaestroDir.
 */
export function buildMaestroFiles(input: BuildMaestroFilesInput): Record<string, string> {
  return {
    '.maestro/state.md': ensureTrailingNewline(input.state),
    '.maestro/context.md': ensureTrailingNewline(input.context),
    '.maestro/decisions.md': ensureTrailingNewline(input.decisions ?? defaultDecisionsMd()),
    '.maestro/autonomy.json': JSON.stringify(input.autonomy, null, 2) + '\n',
    '.maestro/journal/.gitkeep': '',
  }
}

export function defaultDecisionsMd(): string {
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
