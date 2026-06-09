// Phase 4.5 / Sub 4.5.4 — register a repo with the conductor.
//
// Extracted from scripts/cli/add.ts so `maestro add` and the dashboard's
// POST /api/projects/register share one implementation. Clones to a temp
// dir, validates `.maestro/` with Zod, inserts the projects row, removes
// the clone. The worker creates its own working clone later under
// MAESTRO_DATA_DIR/work/<slug>.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import simpleGit from 'simple-git'
import { MaestroError, type Project } from '@maestro/shared'
import type Database from 'better-sqlite3'
import { ProjectRepository } from './repositories.js'
import { parseRepoUrl } from './pr-manager.js'
import { readMaestroDir } from './state-manager.js'
import { logger } from './logger.js'

export interface RegisterProjectInput {
  db: Database.Database
  repoUrl: string
  /**
   * Use a local path instead of cloning. The path must already contain a
   * valid `.maestro/`. CLI-only escape hatch (`maestro add --from-path`).
   */
  fromPath?: string
}

export async function registerProject(input: RegisterProjectInput): Promise<Project> {
  const repo = parseRepoUrl(input.repoUrl)
  const slug = `${repo.owner}-${repo.repo}`.toLowerCase()
  const projects = new ProjectRepository(input.db)

  if (projects.findBySlug(slug)) {
    throw new MaestroError('CONFIG_VALIDATION_FAILED', {
      message: `Project ${slug} is already registered`,
      context: { slug },
    })
  }

  const checkoutPath = input.fromPath
    ? resolve(input.fromPath)
    : await cloneToTemp(input.repoUrl)

  try {
    if (!existsSync(checkoutPath)) {
      throw new MaestroError('GIT_OPERATION_FAILED', {
        message: `Path does not exist: ${checkoutPath}`,
        context: { checkoutPath },
      })
    }
    logger.info({ checkoutPath, slug }, 'register: validating .maestro/')
    const maestro = await readMaestroDir(checkoutPath)

    return projects.insert({
      id: randomUUID(),
      slug,
      repoUrl: input.repoUrl,
      autonomyConfig: maestro.autonomy,
    })
  } finally {
    if (!input.fromPath) {
      await rm(checkoutPath, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function cloneToTemp(repoUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-add-'))
  const checkoutPath = join(dir, 'checkout')
  logger.info({ repoUrl, checkoutPath }, 'register: cloning')
  try {
    await simpleGit().clone(repoUrl, checkoutPath, ['--depth', '1'])
    return checkoutPath
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw new MaestroError('GIT_OPERATION_FAILED', {
      message: `Failed to clone ${repoUrl}`,
      cause: err,
      context: { repoUrl },
    })
  }
}
