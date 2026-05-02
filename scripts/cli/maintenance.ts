// `maestro reset <slug>` and `maestro gc` — working-directory hygiene.
//
// reset = blow away one project's working clone (next run re-clones fresh).
// gc    = blow away every working clone untouched for MAESTRO_WORKDIR_GC_DAYS
//         (default 30). Useful when projects come and go or after a long
//         absence.

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  destroyWorkingDir,
  loadConfig,
  ProjectRepository,
  openDatabase,
  workingDirAgeDays,
  workingDirFor,
} from '@maestro/conductor'
import { failWith, info, ok } from './util.js'

const WORK_SUBDIR = 'work'

export async function runReset(slug: string): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const projects = new ProjectRepository(db)
    const project = projects.findBySlug(slug)
    if (!project) failWith(`Unknown project slug: ${slug}`)

    const path = workingDirFor(config.dataDir, project.slug)
    if (!existsSync(path)) {
      info(`no working clone for ${slug} — nothing to reset`)
      return
    }
    info(`removing working clone: ${path}`)
    await destroyWorkingDir(config.dataDir, project.slug)
    ok(`reset ${slug} — next session will reclone from origin`)
  } finally {
    close()
  }
}

export interface GcOptions {
  dryRun?: boolean
  /** Override the days-untouched threshold. */
  days?: number
}

export async function runGc(options: GcOptions = {}): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const projects = new ProjectRepository(db)
    const all = projects.list()
    const knownSlugs = new Set(all.map((p) => p.slug))
    const days =
      options.days ??
      Number(process.env['MAESTRO_WORKDIR_GC_DAYS'] ?? '30')
    if (!Number.isFinite(days) || days < 1) {
      failWith(`Invalid GC threshold: ${days} days`)
    }

    const workRoot = join(config.dataDir, WORK_SUBDIR)
    if (!existsSync(workRoot)) {
      info('no work/ directory yet — nothing to GC')
      return
    }

    const slugsOnDisk = (await readdir(workRoot)).filter((name) => !name.startsWith('.'))
    if (slugsOnDisk.length === 0) {
      info('no working clones — nothing to GC')
      return
    }

    let removed = 0
    let kept = 0
    for (const slug of slugsOnDisk) {
      const age = await workingDirAgeDays(config.dataDir, slug)
      const orphan = !knownSlugs.has(slug)
      const stale = age !== null && age > days
      const path = workingDirFor(config.dataDir, slug)

      if (orphan) {
        if (options.dryRun) {
          info(`would remove orphan: ${slug} (no project row)`)
        } else {
          info(`removing orphan: ${slug}`)
          await destroyWorkingDir(config.dataDir, slug)
        }
        removed++
        continue
      }
      if (stale) {
        if (options.dryRun) {
          info(`would remove stale: ${slug} (${age?.toFixed(1)}d > ${days}d)`)
        } else {
          info(`removing stale: ${slug} (${age?.toFixed(1)}d > ${days}d)`)
          await destroyWorkingDir(config.dataDir, slug)
        }
        removed++
        continue
      }
      void path
      kept++
    }

    ok(`gc complete — removed ${removed}, kept ${kept}${options.dryRun ? ' (dry run)' : ''}`)
  } finally {
    close()
  }
}
