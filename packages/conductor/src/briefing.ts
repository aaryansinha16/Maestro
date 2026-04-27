// Daily briefing generator + Telegram delivery. Phase 4 work (see
// PRODUCT_VISION.md "Phase 4: Telegram Briefing"). The Phase 0 file is a stub.

import type Database from 'better-sqlite3'
import type { Config } from './config.js'
import { logger } from './logger.js'

export interface BriefingDeps {
  db: Database.Database
  config: Config
}

export function startBriefing(_deps: BriefingDeps): void {
  logger.debug('briefing stub initialised (Phase 4 implementation pending)')
}
