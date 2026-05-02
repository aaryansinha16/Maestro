// `maestro run <slug>` and `maestro inspect <session-id>`. Both talk to
// the local SQLite via the conductor's library API rather than going
// through the HTTP server, so the CLI works even when the conductor isn't
// running.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  loadConfig,
  openDatabase,
  ProjectRepository,
  QualityGateRepository,
  SessionRepository,
  runSession,
} from '@maestro/conductor'
import { failWith, info, ok, pretty, warn } from './util.js'

export interface RunOptions {
  dryRun?: boolean
  /** Override the claude binary; intended for tests, not normal use. */
  claudeBin?: string
}

export async function runRun(slug: string, options: RunOptions): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const projects = new ProjectRepository(db)
    const project = projects.findBySlug(slug)
    if (!project) failWith(`Unknown project slug: ${slug}`)

    info(`session for ${project.slug}${options.dryRun ? ' (dry run)' : ''}`)
    info(`time budget: ${Math.round(project.autonomyConfig.timeBudget / 60)}m`)

    const result = await runSession({
      db,
      config,
      project,
      dryRun: options.dryRun ?? false,
      claudeBin: options.claudeBin,
    })

    if (options.dryRun) {
      ok('dry-run prompt printed above')
      return
    }

    ok(`session ${result.sessionId} → ${result.status}`)
    if (result.branchName) console.log(pretty('branch', result.branchName))
    if (result.prNumber !== null) console.log(pretty('PR #', String(result.prNumber)))
    if (result.notes) console.log(pretty('notes', result.notes))
    if (result.qualityGates.length > 0) {
      console.log()
      console.log('Quality gates:')
      for (const g of result.qualityGates) {
        const tag = g.status === 'passed' ? '✓' : g.status === 'failed' ? '✗' : '∼'
        console.log(`  ${tag} ${g.gateName}`)
      }
    }
    console.log()
    console.log(`log: ${result.logPath}`)
    if (result.fixupTurnRan) warn('a fixup turn ran (see logs)')
  } finally {
    close()
  }
}

export async function runInspect(sessionId: string): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const sessions = new SessionRepository(db)
    const gates = new QualityGateRepository(db)
    const session = sessions.findById(sessionId)
    if (!session) failWith(`Unknown session: ${sessionId}`)

    console.log(pretty('id', session.id))
    console.log(pretty('project', session.projectId))
    console.log(pretty('status', session.status))
    console.log(pretty('started', session.startedAt))
    console.log(pretty('ended', session.endedAt))
    console.log(pretty('branch', session.branchName))
    console.log(pretty('PR #', session.prNumber !== null ? String(session.prNumber) : null))
    console.log(pretty('PR url', session.prUrl))
    console.log(pretty('cost (¢)', session.costCents !== null ? String(session.costCents) : null))
    console.log(pretty('model', session.modelUsed))
    console.log(pretty('terminated', session.terminationCause))
    console.log(pretty('log', session.logPath))
    console.log(pretty('journal', session.journalPath))

    const gateRows = gates.listForSession(session.id)
    if (gateRows.length > 0) {
      console.log()
      console.log('Quality gates:')
      for (const g of gateRows) {
        console.log(`  ${tagFor(g.status)} ${g.gateName}${g.durationMs ? `  (${Math.round(g.durationMs / 1000)}s)` : ''}`)
      }
    }

    if (session.logPath && existsSync(session.logPath)) {
      console.log()
      console.log('--- log tail ---')
      const text = await readFile(session.logPath, 'utf-8')
      const lines = text.split('\n')
      console.log(lines.slice(-200).join('\n'))
    }
  } finally {
    close()
  }
}

function tagFor(s: string): string {
  return s === 'passed' ? '✓' : s === 'failed' ? '✗' : '∼'
}
