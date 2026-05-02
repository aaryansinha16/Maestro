// `maestro schedule …`, `maestro pause`, `maestro resume`, `maestro queue`.
// All of these talk to the local SQLite via @maestro/conductor (consistent
// with init/add/run/inspect — works without the HTTP server running).

import {
  loadConfig,
  openDatabase,
  ProjectRepository,
  ScheduledRunsRepository,
  SessionRepository,
  computeNextCronRun,
} from '@maestro/conductor'
import { JobQueueRepository } from '@maestro/conductor'
import { AutonomyFileSchema, type Job, type Project } from '@maestro/shared'
import kleur from 'kleur'
import { failWith, info, ok } from './util.js'

// ─── schedule enable / disable ───────────────────────────────────────

export async function runScheduleEnable(slug: string): Promise<void> {
  await mutateScheduling(slug, true)
  ok(`scheduling enabled for ${slug}`)
  info('the scheduler picks up the change on its next reconcile (default 30s)')
}

export async function runScheduleDisable(slug: string): Promise<void> {
  await mutateScheduling(slug, false)
  ok(`scheduling disabled for ${slug}`)
}

async function mutateScheduling(slug: string, enabled: boolean): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const projects = new ProjectRepository(db)
    const project = projects.findBySlug(slug)
    if (!project) failWith(`Unknown project slug: ${slug}`)
    const next = AutonomyFileSchema.parse({
      ...project.autonomyConfig,
      scheduledEnabled: enabled,
    })
    projects.updateAutonomyConfig(slug, next)
  } finally {
    close()
  }
}

// ─── schedule list ───────────────────────────────────────────────────

export async function runScheduleList(): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const projects = new ProjectRepository(db).list()
    if (projects.length === 0) {
      info('no projects registered')
      return
    }
    const tz = process.env['MAESTRO_TZ'] ?? 'UTC'
    for (const p of projects) {
      printScheduleRow(p, tz)
    }
  } finally {
    close()
  }
}

function printScheduleRow(p: Project, tz: string): void {
  const enabled = p.scheduledEnabled ? kleur.green('on ') : kleur.gray('off')
  const paused = p.autoPausedAt ? kleur.yellow('paused') : '      '
  const next = p.scheduledEnabled
    ? computeNextCronRun(p.autonomyConfig.schedule, tz) ?? 'unknown'
    : '—'
  console.log(
    `${enabled}  ${paused}  ${p.slug.padEnd(28)}  ${p.autonomyConfig.schedule.padEnd(16)}  next ${next}`,
  )
}

// ─── pause / resume ──────────────────────────────────────────────────

export async function runPause(slug: string, reason?: string): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const projects = new ProjectRepository(db)
    const project = projects.findBySlug(slug)
    if (!project) failWith(`Unknown project slug: ${slug}`)
    projects.setAutoPause(slug, reason ?? 'manual pause')
    ok(`paused ${slug}`)
  } finally {
    close()
  }
}

export async function runResume(slug: string): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const projects = new ProjectRepository(db)
    const project = projects.findBySlug(slug)
    if (!project) failWith(`Unknown project slug: ${slug}`)
    projects.clearAutoPause(slug)
    ok(`resumed ${slug}`)
  } finally {
    close()
  }
}

// ─── queue ───────────────────────────────────────────────────────────

export async function runQueue(): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const queueRepo = new JobQueueRepository(db)
    const projects = new Map(
      new ProjectRepository(db).list().map((p) => [p.id, p.slug]),
    )
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const running = queueRepo.listRunning()
    const queued = queueRepo.listQueued()
    const recent = queueRepo.listRecent(since)
    print('Running', running, projects)
    print('Queued', queued, projects)
    print('Recently completed (24h)', recent, projects)
  } finally {
    close()
  }
}

function print(
  heading: string,
  jobs: Job[],
  projects: Map<string, string>,
): void {
  console.log()
  console.log(kleur.bold(heading))
  if (jobs.length === 0) {
    console.log(kleur.gray('  (none)'))
    return
  }
  for (const j of jobs) {
    const slug = projects.get(j.projectId) ?? j.projectId.slice(0, 8)
    console.log(
      `  ${j.id.slice(0, 8)}  ${slug.padEnd(28)}  ${j.source.padEnd(8)}  ${j.status.padEnd(10)}  ${j.enqueuedAt}`,
    )
  }
}

// ─── skips ───────────────────────────────────────────────────────────

export async function runSkips(slug: string, limit = 20): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const project = new ProjectRepository(db).findBySlug(slug)
    if (!project) failWith(`Unknown project slug: ${slug}`)
    const skips = new ScheduledRunsRepository(db).recentForProject(project.id, limit)
    if (skips.length === 0) {
      info(`no scheduled runs recorded for ${slug}`)
      return
    }
    for (const s of skips) {
      const tag =
        s.action === 'enqueued'
          ? kleur.green('enqueued')
          : s.action === 'skipped'
            ? kleur.yellow('skipped ')
            : kleur.red('failed  ')
      console.log(`${tag}  ${s.firedAt}  ${s.skipReason ?? ''}  ${s.notes ?? ''}`)
    }
  } finally {
    close()
  }
}

// Suppress unused-import warning when only some helpers are referenced.
void SessionRepository
