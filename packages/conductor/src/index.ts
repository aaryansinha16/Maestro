// Conductor entry point. Loads config, opens the database, builds the Hono
// app, and starts listening. Background subsystems (scheduler, briefing) hang
// off this module once their phases land.

import { serve } from '@hono/node-server'
import { loadConfig } from './config.js'
import { openDatabase } from './db.js'
import { buildServer } from './server.js'
import { logger } from './logger.js'
import { startScheduler } from './scheduler.js'
import { startBriefing } from './briefing.js'

const PACKAGE_VERSION = '0.0.0'

async function main(): Promise<void> {
  const config = loadConfig()
  logger.info(
    { port: config.port, dataDir: config.dataDir, env: config.nodeEnv },
    'starting maestro conductor',
  )

  const dbHandle = openDatabase({ dataDir: config.dataDir })
  const startedAt = Date.now()
  const app = buildServer({ startedAt, version: PACKAGE_VERSION, db: dbHandle.db })

  // Reclaim any stale per-project locks left behind by a previous crash.
  const { ProjectLockManager } = await import('./locks.js')
  const stale = new ProjectLockManager(dbHandle.db).releaseAllForCurrentProcess()
  if (stale > 0) logger.warn({ stale }, 'reclaimed stale project locks')

  // Phase-deferred subsystems (Phase 2 scheduling, Phase 4 briefings).
  startScheduler({ db: dbHandle.db, config })
  startBriefing({ db: dbHandle.db, config })

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ address: info.address, port: info.port }, 'conductor listening')
  })

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down')
    server.close(() => {
      dbHandle.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error')
  process.exit(1)
})
