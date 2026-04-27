// Cron-based scheduler — Phase 2 work (see PRODUCT_VISION.md "Phase 2:
// Scheduling and Parallelism"). In Phase 0 this is a no-op stub so wiring
// from index.ts is already in place when the real implementation lands.

import type Database from 'better-sqlite3'
import type { Config } from './config.js'
import { logger } from './logger.js'

export interface SchedulerDeps {
  db: Database.Database
  config: Config
}

export function startScheduler(_deps: SchedulerDeps): void {
  logger.debug('scheduler stub initialised (Phase 2 implementation pending)')
}
