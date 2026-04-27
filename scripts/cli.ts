#!/usr/bin/env tsx
// `maestro` CLI. Lightweight wrapper around the conductor API for tasks the
// developer runs from the terminal.
//
// Phase 0: `list` and `status` hit the API. `add` and `run` are stubbed to
// "not implemented" — the actual project registration and session triggering
// arrive in Phases 1 and 2 respectively.

import { cac } from 'cac'
import type { HealthResponse, ListProjectsResponse } from '@maestro/api'

const PACKAGE_VERSION = '0.0.0'
const DEFAULT_API_BASE = process.env.MAESTRO_API_BASE ?? 'http://localhost:3000'

const cli = cac('maestro')

cli
  .command('add <repo-url>', 'Register a GitHub repository with Maestro')
  .option('--autonomy <level>', 'Autonomy level (full|pr-only|draft-only|paused)', {
    default: 'pr-only',
  })
  .option('--schedule <cron>', 'Cron schedule', { default: '0 */6 * * *' })
  .action((_repoUrl: string, _opts: unknown) => {
    notImplemented(
      'maestro add',
      'Project registration arrives in Phase 1. See PRODUCT_VISION.md.',
    )
  })

cli
  .command('run <project>', 'Manually trigger a session for a project')
  .option('--dry-run', 'Build the prompt and log it without spawning Claude')
  .action((_project: string, _opts: { dryRun?: boolean }) => {
    notImplemented(
      'maestro run',
      'Manual session execution arrives in Phase 1. See PRODUCT_VISION.md.',
    )
  })

cli
  .command('list', 'List projects under Maestro management')
  .option('--api <url>', 'Override the conductor API base URL', {
    default: DEFAULT_API_BASE,
  })
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
  .option('--api <url>', 'Override the conductor API base URL', {
    default: DEFAULT_API_BASE,
  })
  .action(async (opts: { api: string }) => {
    const health = await fetchJson<HealthResponse>(opts.api, '/api/health')
    console.log(`status     ${health.status}`)
    console.log(`version    ${health.version}`)
    console.log(`uptime     ${health.uptimeSeconds}s`)
    console.log(`timestamp  ${health.timestamp}`)
  })

cli.help()
cli.version(PACKAGE_VERSION)

try {
  cli.parse(process.argv, { run: false })
  await cli.runMatchedCommand()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}

function notImplemented(name: string, why: string): never {
  console.error(`${name}: not implemented`)
  console.error(why)
  process.exit(2)
}

async function fetchJson<T>(base: string, path: string): Promise<T> {
  const url = `${base.replace(/\/$/, '')}${path}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`API ${res.status} ${res.statusText} (${url})`)
  }
  return (await res.json()) as T
}
