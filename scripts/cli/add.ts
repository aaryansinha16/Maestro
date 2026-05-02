// `maestro add <repo-url>` — register a project with the conductor.
//
// Clones the repo into a temp directory, validates `.maestro/` is present
// and Zod-clean, parses autonomy.json, then inserts a row into the
// projects table. The clone is removed on success — the worker will create
// its own working clone under MAESTRO_DATA_DIR/work/<slug>.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import simpleGit from 'simple-git'
import {
  loadConfig,
  openDatabase,
  ProjectRepository,
  parseRepoUrl,
  readMaestroDir,
} from '@maestro/conductor'
import { failWith, info, ok } from './util.js'

interface AddOptions {
  /**
   * Use a local path instead of cloning. The path must already contain a
   * valid `.maestro/`. Pair with --repo-url for what to record.
   */
  fromPath?: string
}

export async function runAdd(repoUrl: string, options: AddOptions = {}): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const repo = parseRepoUrl(repoUrl)
    const slug = `${repo.owner}-${repo.repo}`.toLowerCase()
    const projects = new ProjectRepository(db)

    if (projects.findBySlug(slug)) {
      failWith(`Project ${slug} is already registered`)
    }

    const checkoutPath = options.fromPath
      ? resolve(options.fromPath)
      : await cloneToTemp(repoUrl)

    try {
      if (!existsSync(checkoutPath)) {
        failWith(`Path does not exist: ${checkoutPath}`)
      }
      info(`validating .maestro/ in ${checkoutPath}`)
      const maestro = await readMaestroDir(checkoutPath).catch((err) => {
        failWith('.maestro/ is missing or invalid', err)
      })
      if (!maestro) failWith('readMaestroDir returned no value')

      const project = projects.insert({
        id: randomUUID(),
        slug,
        repoUrl,
        autonomyConfig: maestro.autonomy,
      })

      ok(`registered ${project.slug}`)
      console.log(`  level    : ${project.autonomyConfig.level}`)
      console.log(`  schedule : ${project.autonomyConfig.schedule}`)
      console.log(`  budget   : ${Math.round(project.autonomyConfig.timeBudget / 60)}m`)
      console.log(`  gates    : ${project.autonomyConfig.qualityGates.join(', ')}`)
      console.log()
      console.log('Next steps:')
      console.log(`  1. Dry-run a session:  maestro run ${project.slug} --dry-run`)
      console.log(`  2. Real session:       maestro run ${project.slug}`)
    } finally {
      if (!options.fromPath) {
        await rm(checkoutPath, { recursive: true, force: true })
      }
    }
  } finally {
    close()
  }
}

async function cloneToTemp(repoUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-add-'))
  const checkoutPath = join(dir, 'checkout')
  info(`cloning ${repoUrl} → ${checkoutPath}`)
  try {
    await simpleGit().clone(repoUrl, checkoutPath)
    return checkoutPath
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    failWith(`Failed to clone ${repoUrl}`, err)
  }
}
