// Conductor entry point. Loads config, opens the database, builds the Hono
// app, and starts listening. Background subsystems (scheduler, briefing) hang
// off this module once their phases land.

import { serve } from '@hono/node-server'
import { loadConfig } from './config.js'
import { openDatabase } from './db.js'
import { buildServer } from './server.js'
import { logger } from './logger.js'
import { startScheduler, type Scheduler } from './scheduler.js'
import { startBriefing } from './briefing.js'
import { JobQueue, type JobRunOutcome } from './job-queue.js'
import { ProjectRepository } from './repositories.js'
import { runSession } from './worker.js'
import { evaluateAutoPause } from './auto-pause.js'

const PACKAGE_VERSION = '0.0.0'

async function main(): Promise<void> {
  const config = loadConfig()
  logger.info(
    { port: config.port, dataDir: config.dataDir, env: config.nodeEnv },
    'starting maestro conductor',
  )

  const dbHandle = openDatabase({ dataDir: config.dataDir })
  const startedAt = Date.now()

  // Reclaim any stale per-project locks left behind by a previous crash.
  const { ProjectLockManager } = await import('./locks.js')
  const stale = new ProjectLockManager(dbHandle.db).releaseAllForCurrentProcess()
  if (stale > 0) logger.warn({ stale }, 'reclaimed stale project locks')

  // Phase 2: job queue + scheduler. The queue's `runner` callback bridges
  // to runSession() from the worker. Per-project lock + per-project
  // queue concurrency together guarantee ADR-008 (sequential per project,
  // parallel across projects).
  const projects = new ProjectRepository(dbHandle.db)
  const queue = new JobQueue({
    db: dbHandle.db,
    runner: async (job): Promise<JobRunOutcome> => {
      const project = projects.findById(job.projectId)
      if (!project) {
        return {
          status: 'failed',
          sessionId: null,
          reason: `project ${job.projectId} not found`,
        }
      }
      try {
        const result = await runSession({ db: dbHandle.db, config, project })
        // After every session, re-evaluate the project's auto-pause state.
        const refreshed = projects.findById(project.id)
        if (refreshed) {
          evaluateAutoPause(
            { projects, sessions: new (await import('./repositories.js')).SessionRepository(dbHandle.db) },
            refreshed,
          )
        }
        const failed =
          result.status !== 'completed' || result.prNumber === null
        return {
          status: failed ? 'failed' : 'completed',
          sessionId: result.sessionId,
        }
      } catch (err) {
        logger.error(
          { err, jobId: job.id, projectId: job.projectId },
          'queue runner: runSession threw',
        )
        return {
          status: 'failed',
          sessionId: null,
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    },
  })
  const scheduler: Scheduler = startScheduler({
    db: dbHandle.db,
    config,
    queue,
  })
  startBriefing({ db: dbHandle.db, config })

  const app = buildServer({
    startedAt,
    version: PACKAGE_VERSION,
    db: dbHandle.db,
    dataDir: config.dataDir,
    developerName: config.developerName,
    queue,
    scheduler,
    schedulerTimezone: process.env['MAESTRO_TZ'] ?? 'UTC',
    ...(config.githubToken ? { githubToken: config.githubToken } : {}),
  })

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ address: info.address, port: info.port }, 'conductor listening')
  })

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down')
    void (async () => {
      await scheduler.stop().catch((err) => logger.error({ err }, 'scheduler stop failed'))
      await queue.stop().catch((err) => logger.error({ err }, 'queue stop failed'))
      server.close(() => {
        dbHandle.close()
        process.exit(0)
      })
    })()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error')
  process.exit(1)
})
