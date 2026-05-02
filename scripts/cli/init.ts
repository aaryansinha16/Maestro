// `maestro init <project-path>` — interactive .maestro/ scaffolding.
//
// Validates the path is a clean git checkout, scrapes a starter context.md
// from the project (package.json scripts, README excerpt, top-level dirs),
// asks the developer for state.md focus + initial tasks and autonomy
// settings, then writes the `.maestro/` skeleton.

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import prompts from 'prompts'
import simpleGit from 'simple-git'
import {
  AutonomyFileSchema,
  DEFAULT_AUTONOMY_CONFIG,
  DEFAULT_QUALITY_GATES,
  DEFAULT_TIME_BUDGET_SECONDS,
  PROJECT_AUTONOMY_LEVELS,
  QUALITY_GATE_NAMES,
  type ProjectAutonomyConfig,
} from '@maestro/shared'
import { initMaestroDir } from '@maestro/conductor'
import { failWith, info, ok } from './util.js'

export interface InitOptions {
  /** When true, skip the dirty-git-tree check. Useful for tests. */
  force?: boolean
  /** When true, never prompt — caller must supply enough fields below. */
  nonInteractive?: boolean
  focus?: string
  tasks?: string[]
  level?: ProjectAutonomyConfig['level']
  schedule?: string
  timeBudgetMinutes?: number
  qualityGates?: ProjectAutonomyConfig['qualityGates']
  branchPrefix?: string
}

export async function runInit(rawPath: string, options: InitOptions = {}): Promise<void> {
  const projectRoot = resolve(rawPath)
  if (!existsSync(projectRoot)) failWith(`Path does not exist: ${projectRoot}`)

  await ensureCleanGitRepo(projectRoot, options.force ?? false)

  const seed = await scrapeContext(projectRoot)
  const responses = options.nonInteractive
    ? buildNonInteractiveResponses(options)
    : await askInteractive(seed.name)
  const stateBody = renderStateMd({
    focus: responses.focus,
    tasks: responses.tasks,
  })
  const autonomy = buildAutonomy(responses)

  info(`writing .maestro/ to ${projectRoot}`)
  try {
    await initMaestroDir({
      projectRoot,
      state: stateBody,
      context: seed.contextMd,
      autonomy,
    })
  } catch (err) {
    failWith('Failed to initialise .maestro/', err)
  }

  ok('.maestro/ created and validated')
  console.log()
  console.log('Next steps:')
  console.log(`  1. Edit ${projectRoot}/.maestro/context.md to flesh out project context`)
  console.log('  2. Commit .maestro/ to your project repo')
  console.log('  3. Register with Maestro:  maestro add <repo-url>')
  console.log('  4. Dry-run a session:      maestro run <slug> --dry-run')
}

// ─── Pre-flight ──────────────────────────────────────────────────────

async function ensureCleanGitRepo(projectRoot: string, force: boolean): Promise<void> {
  if (!existsSync(`${projectRoot}/.git`)) {
    failWith(`${projectRoot} is not a git repository`)
  }
  if (force) return
  const git = simpleGit(projectRoot)
  const status = await git.status()
  if (!status.isClean()) {
    failWith(
      `${projectRoot} has uncommitted changes. Stash, commit, or rerun with --force.`,
      new Error(`modified=${status.modified.length} not_added=${status.not_added.length}`),
    )
  }
}

// ─── Context scraping ────────────────────────────────────────────────

interface SeededContext {
  name: string
  contextMd: string
}

async function scrapeContext(projectRoot: string): Promise<SeededContext> {
  const lines: string[] = []
  let projectName = projectRoot.split('/').slice(-1)[0] ?? 'project'

  const pkgPath = `${projectRoot}/package.json`
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as {
        name?: string
        description?: string
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      if (pkg.name) projectName = pkg.name
      lines.push(`# Project Context — ${projectName}`)
      lines.push('')
      lines.push('## Stack')
      lines.push('')
      lines.push('Detected from package.json. Update freely.')
      if (pkg.description) {
        lines.push('')
        lines.push(`> ${pkg.description}`)
      }
      if (pkg.scripts) {
        lines.push('')
        lines.push('### Scripts')
        lines.push('')
        for (const [name, value] of Object.entries(pkg.scripts)) {
          lines.push(`- \`${name}\`: \`${value}\``)
        }
      }
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
        .filter((d) => !d.startsWith('@types/'))
        .slice(0, 12)
      if (deps.length > 0) {
        lines.push('')
        lines.push('### Notable dependencies')
        lines.push('')
        lines.push(deps.map((d) => `- ${d}`).join('\n'))
      }
    } catch {
      lines.push(`# Project Context — ${projectName}`)
    }
  } else if (existsSync(`${projectRoot}/pyproject.toml`)) {
    lines.push(`# Project Context — ${projectName}`)
    lines.push('')
    lines.push('## Stack')
    lines.push('')
    lines.push('Python project (pyproject.toml). Fill in framework, deps, etc.')
  } else if (existsSync(`${projectRoot}/Cargo.toml`)) {
    lines.push(`# Project Context — ${projectName}`)
    lines.push('')
    lines.push('## Stack')
    lines.push('')
    lines.push('Rust project (Cargo.toml).')
  } else {
    lines.push(`# Project Context — ${projectName}`)
    lines.push('')
    lines.push('## Stack')
    lines.push('')
    lines.push('Unrecognised project layout. Describe it here.')
  }

  // Top-level layout
  try {
    const entries = (await readdir(projectRoot, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, 20)
    if (entries.length > 0) {
      lines.push('')
      lines.push('## Top-level layout')
      lines.push('')
      lines.push(
        entries.map((e) => `- \`${e.name}${e.isDirectory() ? '/' : ''}\``).join('\n'),
      )
    }
  } catch {
    /* ignore */
  }

  // README excerpt
  for (const candidate of ['README.md', 'README', 'Readme.md']) {
    const p = `${projectRoot}/${candidate}`
    if (existsSync(p)) {
      try {
        const body = await readFile(p, 'utf-8')
        const excerpt = body.split('\n').slice(0, 30).join('\n').trim()
        if (excerpt.length > 0) {
          lines.push('')
          lines.push('## README excerpt')
          lines.push('')
          lines.push(excerpt)
        }
      } catch {
        /* ignore */
      }
      break
    }
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

  return { name: projectName, contextMd: lines.join('\n') + '\n' }
}

// ─── Interactive prompts ─────────────────────────────────────────────

interface Responses {
  focus: string
  tasks: string[]
  level: ProjectAutonomyConfig['level']
  schedule: string
  timeBudgetMinutes: number
  qualityGates: ProjectAutonomyConfig['qualityGates']
  branchPrefix: string
}

async function askInteractive(suggestedName: string): Promise<Responses> {
  void suggestedName
  const focus = await ask<string>({
    type: 'text',
    name: 'value',
    message: 'Current focus (1–3 sentences)',
    validate: (s) => (s.trim().length > 0 ? true : 'required'),
  })

  const tasksRaw = await ask<string>({
    type: 'text',
    name: 'value',
    message: 'Initial tasks (one per line; blank line to finish)',
    multiline: true,
  })
  const tasks = tasksRaw
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)

  const level = await ask<ProjectAutonomyConfig['level']>({
    type: 'select',
    name: 'value',
    message: 'Autonomy level',
    initial: 1,
    choices: PROJECT_AUTONOMY_LEVELS.map((l) => ({ title: l, value: l })),
  })

  const schedule = await ask<string>({
    type: 'text',
    name: 'value',
    message: 'Cron schedule (Phase 2 will read this)',
    initial: DEFAULT_AUTONOMY_CONFIG.schedule,
  })

  const timeBudgetMinutes = await ask<number>({
    type: 'number',
    name: 'value',
    message: 'Time budget per session (minutes)',
    initial: DEFAULT_TIME_BUDGET_SECONDS / 60,
    min: 5,
    max: 180,
  })

  const qualityGates = await ask<ProjectAutonomyConfig['qualityGates']>({
    type: 'multiselect',
    name: 'value',
    message: 'Quality gates to run pre-PR',
    instructions: false,
    choices: QUALITY_GATE_NAMES.map((g) => ({
      title: g,
      value: g,
      selected: DEFAULT_QUALITY_GATES.includes(g),
    })),
  })

  const branchPrefix = await ask<string>({
    type: 'text',
    name: 'value',
    message: 'Branch prefix for Maestro PRs',
    initial: 'maestro/',
  })

  return {
    focus,
    tasks,
    level,
    schedule,
    timeBudgetMinutes,
    qualityGates,
    branchPrefix,
  }
}

async function ask<T>(question: prompts.PromptObject): Promise<T> {
  const answer = await prompts(question, {
    onCancel: () => {
      console.log('\nCancelled.')
      process.exit(130)
    },
  })
  return answer['value'] as T
}

function buildNonInteractiveResponses(o: InitOptions): Responses {
  if (!o.focus || o.focus.trim().length === 0) {
    failWith('--non-interactive requires --focus "<sentence>"')
  }
  return {
    focus: o.focus,
    tasks: o.tasks ?? [],
    level: o.level ?? 'pr-only',
    schedule: o.schedule ?? DEFAULT_AUTONOMY_CONFIG.schedule,
    timeBudgetMinutes: o.timeBudgetMinutes ?? DEFAULT_TIME_BUDGET_SECONDS / 60,
    qualityGates: o.qualityGates ?? DEFAULT_QUALITY_GATES,
    branchPrefix: o.branchPrefix ?? 'maestro/',
  }
}

// ─── Composition ─────────────────────────────────────────────────────

function renderStateMd(args: { focus: string; tasks: string[] }): string {
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

function buildAutonomy(r: Responses): ProjectAutonomyConfig {
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
