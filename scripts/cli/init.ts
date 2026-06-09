// `maestro init <project-path>` — interactive .maestro/ scaffolding.
//
// Validates the path is a clean git checkout, scrapes a starter context.md
// from the project (package.json scripts, README excerpt, top-level dirs),
// asks the developer for state.md focus + initial tasks and autonomy
// settings, then writes the `.maestro/` skeleton.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import prompts from 'prompts'
import simpleGit from 'simple-git'
import {
  DEFAULT_AUTONOMY_CONFIG,
  DEFAULT_QUALITY_GATES,
  DEFAULT_TIME_BUDGET_SECONDS,
  PROJECT_AUTONOMY_LEVELS,
  QUALITY_GATE_NAMES,
  type ProjectAutonomyConfig,
} from '@maestro/shared'
import {
  buildAutonomyFromAnswers,
  initMaestroDir,
  renderStateMd,
  scaffoldContextMd,
  scrapeContextFromDisk,
  type AutonomyAnswers,
} from '@maestro/conductor'
import { failWith, info, ok, warn } from './util.js'

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
  /**
   * When true, spawn a one-shot Claude run to draft a real context.md
   * from the codebase. Costs Claude tokens; falls back to the cheap
   * scrape if it fails.
   */
  scaffoldContext?: boolean
}

export async function runInit(rawPath: string, options: InitOptions = {}): Promise<void> {
  const projectRoot = resolve(rawPath)
  if (!existsSync(projectRoot)) failWith(`Path does not exist: ${projectRoot}`)

  await ensureCleanGitRepo(projectRoot, options.force ?? false)

  const seed = await scrapeContextFromDisk(projectRoot)
  const responses = options.nonInteractive
    ? buildNonInteractiveResponses(options)
    : await askInteractive(seed.name)
  const stateBody = renderStateMd({
    focus: responses.focus,
    tasks: responses.tasks,
  })
  const autonomy = buildAutonomyFromAnswers(responses)

  let contextMd = seed.contextMd
  if (options.scaffoldContext) {
    info('scaffolding context.md via claude (this takes ~1-2 minutes on a real codebase)…')
    try {
      const result = await scaffoldContextMd({ projectRoot })
      contextMd = result.contextMd
      ok(
        `context.md scaffolded (${result.contextMd.split('\n').length} lines, ${
          result.costCents !== null ? `$${(result.costCents / 100).toFixed(2)}` : 'cost n/a'
        }, ${Math.round(result.durationMs / 1000)}s)`,
      )
    } catch (err) {
      warn('context scaffolder failed; falling back to manual scrape')
      console.error(err instanceof Error ? `  ${err.message}` : err)
    }
  }

  info(`writing .maestro/ to ${projectRoot}`)
  try {
    await initMaestroDir({
      projectRoot,
      state: stateBody,
      context: contextMd,
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

// ─── Interactive prompts ─────────────────────────────────────────────

// The rendering/composition logic (scrapeContextFromDisk, renderStateMd,
// buildAutonomyFromAnswers) moved to @maestro/conductor's project-init.ts
// in Phase 4.5 so the dashboard onboarding wizard shares it. This file
// keeps only the prompt UX.

interface Responses extends AutonomyAnswers {
  focus: string
  tasks: string[]
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

