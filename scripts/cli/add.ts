// `maestro add <repo-url>` — register a project with the conductor.
//
// Thin CLI wrapper around registerProject (packages/conductor/src/
// project-register.ts), which the dashboard's POST /api/projects/register
// also uses. Phase 4.5 moved the clone-and-validate logic there.

import { resolve } from 'node:path'
import { loadConfig, openDatabase, registerProject } from '@maestro/conductor'
import { failWith, info, ok } from './util.js'

interface AddOptions {
  /**
   * Use a local path instead of cloning. The path must already contain a
   * valid `.maestro/`.
   */
  fromPath?: string
}

export async function runAdd(repoUrl: string, options: AddOptions = {}): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    if (options.fromPath) info(`using local checkout at ${resolve(options.fromPath)}`)
    const project = await registerProject({
      db,
      repoUrl,
      ...(options.fromPath ? { fromPath: options.fromPath } : {}),
    }).catch((err: unknown) => {
      failWith(err instanceof Error ? err.message : 'failed to register project', err)
    })
    if (!project) failWith('registerProject returned no value')

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
    close()
  }
}
