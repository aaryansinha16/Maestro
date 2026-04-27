// Session worker — spawns Claude Code, enforces the time budget, runs quality
// gates, commits, and opens a PR. This is Phase 1 work (see PRODUCT_VISION.md
// "Phase 1: Manual Single-Project Sessions"). The Phase 0 file is a stub so
// the rest of the system can import it.

import type Database from 'better-sqlite3'
import type { Project } from '@maestro/shared'
import { MaestroError } from '@maestro/shared'
import type { Config } from './config.js'

export interface RunSessionInput {
  db: Database.Database
  config: Config
  project: Project
  /** When true, build the prompt and log it without spawning Claude. */
  dryRun?: boolean
}

export async function runSession(_input: RunSessionInput): Promise<never> {
  throw new MaestroError('INTERNAL_ERROR', {
    message: 'runSession is Phase 1 work. See PRODUCT_VISION.md.',
  })
}
