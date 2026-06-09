#!/usr/bin/env tsx
// `maestro` CLI entry point.
//
// `init`, `add`, `run`, and `inspect` operate against the local SQLite
// database (via the conductor's library API) so they work even when the
// HTTP server isn't running.
// `list` and `status` hit the running conductor over HTTP.

import { cac } from 'cac'
import type { HealthResponse, ListProjectsResponse } from '@maestro/api'
import {
  PROJECT_AUTONOMY_LEVELS,
  QUALITY_GATE_NAMES,
  type ProjectAutonomyConfig,
} from '@maestro/shared'
import { runInit } from './cli/init.js'
import { runAdd } from './cli/add.js'
import { runRun, runInspect } from './cli/run.js'
import { runDoctor } from './cli/doctor.js'
import { runReset, runGc } from './cli/maintenance.js'
import {
  runPause,
  runQueue,
  runResume,
  runScheduleDisable,
  runScheduleEnable,
  runScheduleList,
  runSkips,
} from './cli/scheduling.js'
import { runFeedback } from './cli/feedback.js'
import { runBackup } from './cli/backup.js'
import { runBriefingPreview, runBriefingSend } from './cli/briefing.js'
import { failWith, loadEnvFromRepoRoot } from './cli/util.js'

loadEnvFromRepoRoot()

const PACKAGE_VERSION = '0.0.0'
const DEFAULT_API_BASE = process.env['MAESTRO_API_BASE'] ?? 'http://localhost:3000'

const cli = cac('maestro')

cli
  .command('init <project-path>', 'Interactive .maestro/ scaffolding for a project')
  .option('--force', 'Skip the dirty-git-tree check')
  .option('--non-interactive', 'Use defaults / flags instead of prompts (CI-friendly)')
  .option('--focus <text>', 'Required with --non-interactive: 1–3 sentences for state.md')
  .option('--task <text>', 'Repeatable: an entry under "Next Concrete Tasks"')
  .option(
    '--level <level>',
    `Autonomy level (${PROJECT_AUTONOMY_LEVELS.join('|')})`,
    { default: 'pr-only' },
  )
  .option('--schedule <cron>', 'Cron schedule string', { default: '0 */6 * * *' })
  .option('--time-budget-minutes <n>', 'Session time budget in minutes', { default: 45 })
  .option(
    '--gates <list>',
    `Comma-separated quality gates (${QUALITY_GATE_NAMES.join('|')})`,
    { default: 'test,lint,typecheck' },
  )
  .option('--branch-prefix <prefix>', 'Branch prefix for Maestro PRs', {
    default: 'maestro/',
  })
  .option(
    '--scaffold-context',
    'Spawn a one-shot Claude run to draft a real context.md from the codebase (costs tokens)',
  )
  .action(
    async (
      path: string,
      opts: {
        force?: boolean
        nonInteractive?: boolean
        focus?: string
        task?: string | string[]
        level?: string
        schedule?: string
        timeBudgetMinutes?: number | string
        gates?: string
        branchPrefix?: string
        scaffoldContext?: boolean
      },
    ) => {
      const tasks = Array.isArray(opts.task) ? opts.task : opts.task ? [opts.task] : []
      const level = opts.level as ProjectAutonomyConfig['level']
      if (!PROJECT_AUTONOMY_LEVELS.includes(level)) {
        failWith(`Invalid --level: ${opts.level}`)
      }
      const gates = (opts.gates ?? '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean) as ProjectAutonomyConfig['qualityGates']
      for (const g of gates) {
        if (!QUALITY_GATE_NAMES.includes(g)) {
          failWith(`Invalid --gates entry: ${g}`)
        }
      }
      const minutes = Number(opts.timeBudgetMinutes ?? 45)
      if (!Number.isFinite(minutes) || minutes < 5 || minutes > 180) {
        failWith('--time-budget-minutes must be between 5 and 180')
      }
      await runInit(path, {
        force: opts.force ?? false,
        nonInteractive: opts.nonInteractive ?? false,
        focus: opts.focus,
        tasks,
        level,
        schedule: opts.schedule,
        timeBudgetMinutes: minutes,
        qualityGates: gates,
        branchPrefix: opts.branchPrefix,
        scaffoldContext: opts.scaffoldContext ?? false,
      })
    },
  )

cli
  .command('add <repo-url>', 'Register a GitHub repository with Maestro')
  .option('--from-path <path>', 'Use a local checkout instead of cloning the repo')
  .action(async (repoUrl: string, opts: { fromPath?: string }) => {
    await runAdd(repoUrl, { fromPath: opts.fromPath })
  })

cli
  .command('run <slug>', 'Manually trigger a session for a project')
  .option('--dry-run', 'Build the prompt and log it without spawning Claude Code')
  .option('--claude-bin <path>', 'Override the claude binary (test-only)')
  .action(async (slug: string, opts: { dryRun?: boolean; claudeBin?: string }) => {
    await runRun(slug, { dryRun: opts.dryRun ?? false, claudeBin: opts.claudeBin })
  })

cli
  .command('inspect <session-id>', 'Show details and log tail for a session')
  .action(async (sessionId: string) => {
    await runInspect(sessionId)
  })

cli
  .command('doctor [slug]', 'Health-check one or all registered projects')
  .action(async (slug: string | undefined) => {
    await runDoctor({ slug })
  })

cli
  .command('reset <slug>', 'Blow away the working clone for a project')
  .action(async (slug: string) => {
    await runReset(slug)
  })

cli
  .command('gc', 'Garbage-collect stale or orphan working clones')
  .option('--dry-run', 'Print what would be removed without removing it')
  .option(
    '--days <n>',
    'Override MAESTRO_WORKDIR_GC_DAYS (clones untouched longer than this are removed)',
  )
  .action(async (opts: { dryRun?: boolean; days?: string | number }) => {
    const days = opts.days !== undefined ? Number(opts.days) : undefined
    await runGc({ dryRun: opts.dryRun ?? false, days })
  })

cli
  .command('list', 'List projects under Maestro management')
  .option('--api <url>', 'Override the conductor API base URL', { default: DEFAULT_API_BASE })
  .action(async (opts: { api: string }) => {
    const data = await fetchJson<ListProjectsResponse>(opts.api, '/api/projects')
    if (data.projects.length === 0) {
      console.log('No projects yet. Add one with: maestro add <repo-url>')
      return
    }
    for (const p of data.projects) {
      console.log(`${p.slug.padEnd(24)}  ${p.autonomyConfig.level.padEnd(12)}  ${p.repoUrl}`)
    }
  })

cli
  .command('status', 'Conductor health check')
  .option('--api <url>', 'Override the conductor API base URL', { default: DEFAULT_API_BASE })
  .action(async (opts: { api: string }) => {
    const health = await fetchJson<HealthResponse>(opts.api, '/api/health')
    console.log(`status     ${health.status}`)
    console.log(`version    ${health.version}`)
    console.log(`uptime     ${health.uptimeSeconds}s`)
    console.log(`timestamp  ${health.timestamp}`)
  })

// ─── Phase 2: scheduling commands ───────────────────────────────────

cli
  .command('schedule enable <slug>', 'Enable scheduled execution for a project')
  .action(async (slug: string) => {
    await runScheduleEnable(slug)
  })

cli
  .command('schedule disable <slug>', 'Disable scheduled execution for a project')
  .action(async (slug: string) => {
    await runScheduleDisable(slug)
  })

cli
  .command('schedule list', 'Show every project with its scheduling state and next run')
  .action(async () => {
    await runScheduleList()
  })

cli
  .command('pause <slug>', 'Pause a project (skips both scheduled and auto runs)')
  .option('--reason <text>', 'Optional human note recorded with the pause')
  .action(async (slug: string, opts: { reason?: string }) => {
    await runPause(slug, opts.reason)
  })

cli
  .command('resume <slug>', 'Clear an auto-pause or manual pause on a project')
  .action(async (slug: string) => {
    await runResume(slug)
  })

cli
  .command('queue', 'Show running, queued, and recently completed jobs')
  .action(async () => {
    await runQueue()
  })

cli
  .command('skips <slug>', 'Show recent scheduled-runs entries (skips + enqueues) for a project')
  .option('--limit <n>', 'Number of rows to show', { default: 20 })
  .action(async (slug: string, opts: { limit?: number | string }) => {
    const n = Number(opts.limit ?? 20)
    await runSkips(slug, Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 20)
  })

cli
  .command('feedback <slug>', 'Show unprocessed PR comments that will be fed into the next session')
  .action(async (slug: string) => {
    await runFeedback(slug)
  })

cli
  .command('backup', 'Snapshot the SQLite database now and prune old backups')
  .action(async () => {
    await runBackup()
  })

cli
  .command('briefing preview', "Print today's briefing without sending or recording it")
  .action(async () => {
    await runBriefingPreview()
  })

cli
  .command('briefing send', "Generate today's briefing and deliver it via Telegram")
  .option('--force', 'Send even if a briefing already went out today')
  .action(async (opts: { force?: boolean }) => {
    await runBriefingSend({ force: opts.force ?? false })
  })

cli.help()
cli.version(PACKAGE_VERSION)

try {
  cli.parse(process.argv, { run: false })
  await cli.runMatchedCommand()
} catch (err) {
  failWith(err instanceof Error ? err.message : String(err), err)
}

async function fetchJson<T>(base: string, path: string): Promise<T> {
  const url = `${base.replace(/\/$/, '')}${path}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`API ${res.status} ${res.statusText} (${url})`)
  }
  return (await res.json()) as T
}
