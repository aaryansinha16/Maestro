// `maestro feedback <slug>` — list pending PR-comment feedback for a
// project. Shipped with Phase 4 / Sub 1.

import {
  loadConfig,
  openDatabase,
  PrFeedbackRepository,
  ProjectRepository,
} from '@maestro/conductor'
import kleur from 'kleur'
import { failWith, info } from './util.js'

export async function runFeedback(slug: string): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const projects = new ProjectRepository(db)
    const project = projects.findBySlug(slug)
    if (!project) failWith(`Unknown project: ${slug}`)

    const feedback = new PrFeedbackRepository(db)
    const pending = feedback.pendingForProject(project.id)
    if (pending.length === 0) {
      info(`No pending PR feedback for ${slug}.`)
      return
    }

    process.stdout.write(`\n${kleur.bold(`Pending feedback for ${slug}`)}  (${pending.length})\n\n`)
    for (const f of pending) {
      const head = `${kleur.cyan(`PR #${f.prNumber}`)} ${kleur.dim(`(${f.prBranch})`)} — ${kleur.yellow(f.commentAuthor)}, ${kleur.dim(f.postedAt)}`
      process.stdout.write(`${head}\n`)
      const indented = f.commentBody
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
      process.stdout.write(`${indented}\n\n`)
    }
    info(
      'Feedback is fed into the next session for this project. To mark it processed,\nlet the agent address it (it will write "addressed PR #N feedback" to the journal).',
    )
  } finally {
    close()
  }
}
