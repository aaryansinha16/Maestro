// Session worker — the heart of Phase 1.
//
// runSession(...) executes the 12 steps described in CLAUDE.md:
//   1.  Acquire the per-project advisory lock                       (locks)
//   2.  Prepare the working directory (clone or refresh)            (git)
//   3.  Read .maestro/ files and validate with Zod                  (state-manager)
//   4.  Build the session prompt                                    (shared/prompt-templates)
//   5.  Spawn `claude` and capture stream output                    (claude-runner)
//   6.  Enforce time budget with SIGTERM-then-SIGKILL choreography  (claude-runner)
//   7.  Verify the agent committed work + touched .maestro/         (state-manager + git)
//   8.  Run quality gates                                           (quality-gates)
//   9.  Optional fixup turn if gates failed                         (claude-runner again)
//   10. Push branch and open PR (or apply needs-review label)       (pr-manager)
//   11. Persist the session row                                     (repositories)
//   12. Cleanup intent (we keep working dirs for inspection)
//
// Tests inject a mock `claudeBin` via options so the suite never spawns
// the real CLI. Production calls pass the real `claude` path through
// the env (DEFAULT: just "claude").

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import simpleGit, { type SimpleGit } from 'simple-git'
import {
  FIXUP_TURN_BUDGET_SECONDS,
  LOGS_SUBDIR,
  MaestroError,
  PROMPT_VERSION,
  WORK_SUBDIR,
  buildFixupTurnPrompt,
  buildSessionPrompt,
  type Project,
  type SessionStatus,
  type SessionResult,
  type QualityGate,
} from '@maestro/shared'
import type { Config } from './config.js'
import { logger } from './logger.js'
import {
  ProjectLockManager,
} from './locks.js'
import {
  ProjectRepository,
  QualityGateRepository,
  SessionRepository,
} from './repositories.js'
import {
  listRecentJournal,
  readMaestroDir,
  snapshotMaestroDir,
  verifyAgentTouchedMaestroDir,
} from './state-manager.js'
import {
  ensureClaudeAvailable,
  runClaudeSession,
  type ClaudeRunResult,
} from './claude-runner.js'
import {
  runQualityGates,
  type SingleGateResult,
} from './quality-gates.js'
import {
  createGitHubClient,
  parseRepoUrl,
  type GitHubClient,
} from './pr-manager.js'

// ─── Public types ────────────────────────────────────────────────────

export interface RunSessionInput {
  db: Database.Database
  config: Config
  project: Project
  /** When true, build the prompt and log it without spawning Claude. */
  dryRun?: boolean
  /**
   * Override the claude binary. Tests pass a path to a mock executable;
   * production passes nothing and the runner uses `claude`.
   */
  claudeBin?: string
  /**
   * Inject a GitHub client. Tests pass a mock; production constructs
   * one from config.githubToken.
   */
  githubClient?: GitHubClient
  /**
   * Skip the live `claude --version` check. Used by tests.
   */
  skipClaudeProbe?: boolean
}

export interface RunSessionOutput extends SessionResult {
  /** Path to the freshly-written log file. */
  logPath: string
  /** Whether the worker spawned a fixup turn. */
  fixupTurnRan: boolean
}

// ─── Entry point ─────────────────────────────────────────────────────

export async function runSession(input: RunSessionInput): Promise<RunSessionOutput> {
  const sessionId = randomUUID()
  const sessions = new SessionRepository(input.db)
  const gates = new QualityGateRepository(input.db)
  const locks = new ProjectLockManager(input.db)
  const projects = new ProjectRepository(input.db)

  // Pre-flight ------------------------------------------------------------------------
  if (!input.dryRun && !input.skipClaudeProbe) {
    await ensureClaudeAvailable(input.claudeBin)
  }

  // Step 1: lock --------------------------------------------------------------------
  if (!input.dryRun) locks.acquire(input.project.id, sessionId)

  const sessionRow = input.dryRun
    ? null
    : sessions.insert({
        id: sessionId,
        projectId: input.project.id,
        promptVersion: PROMPT_VERSION,
      })

  let result: RunSessionOutput | null = null
  try {
    result = await runSessionInner({
      ...input,
      sessionId,
      sessions,
      gates,
      projects,
    })
    return result
  } catch (err) {
    if (sessionRow) {
      sessions.update(sessionId, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        terminationCause: 'failed',
      })
    }
    throw err
  } finally {
    if (!input.dryRun) locks.release(input.project.id, sessionId)
  }
}

interface InnerInput extends RunSessionInput {
  sessionId: string
  sessions: SessionRepository
  gates: QualityGateRepository
  projects: ProjectRepository
}

async function runSessionInner(input: InnerInput): Promise<RunSessionOutput> {
  const { project, config } = input
  const workingRoot = workingDirFor(config.dataDir, project.slug)
  const logPath = sessionLogPath(config.dataDir, input.sessionId)

  // Step 2: working directory ------------------------------------------------------
  await prepareWorkingDir({
    workingRoot,
    repoUrl: project.repoUrl,
    baseBranch: project.autonomyConfig.branches.base,
    developerName: config.developerName,
    developerEmail: config.developerEmail ?? `${config.developerGithubUsername}@users.noreply.github.com`,
  })

  // Step 3: read .maestro/ ----------------------------------------------------------
  const maestro = await readMaestroDir(workingRoot)
  const recentJournal = await listRecentJournal(workingRoot, 3)

  // Step 4: build prompt ------------------------------------------------------------
  const task = deriveTaskFromState(maestro.state.raw)
  const prompt = buildSessionPrompt({
    projectName: project.slug,
    projectSlug: project.slug,
    timeBudgetSeconds: project.autonomyConfig.timeBudget,
    developerName: config.developerName,
    context: maestro.context,
    state: maestro.state.raw,
    recentJournal: recentJournal.map((j) => ({ filename: j.filename, body: j.body })),
    task,
    qualityGates: project.autonomyConfig.qualityGates,
    isFirstSession: recentJournal.length === 0,
  })

  if (input.dryRun) {
    logger.info({ projectSlug: project.slug, promptBytes: prompt.length }, 'dry-run prompt')
    process.stdout.write(prompt)
    process.stdout.write('\n')
    return {
      sessionId: input.sessionId,
      status: 'completed',
      filesChanged: [],
      commitSha: null,
      branchName: null,
      prNumber: null,
      qualityGates: [],
      costCents: null,
      journalPath: null,
      notes: 'dry-run — prompt printed, no session spawned',
      logPath,
      fixupTurnRan: false,
    }
  }

  // Snapshot .maestro/ so we can verify the agent touched it later.
  const before = await snapshotMaestroDir(workingRoot)

  input.sessions.update(input.sessionId, {
    status: 'running',
    logPath,
  })

  // Step 5–6: spawn Claude with budget --------------------------------------------
  const runResult = await runClaudeSession({
    cwd: workingRoot,
    prompt,
    timeBudgetSeconds: project.autonomyConfig.timeBudget,
    logPath,
    claudeBin: input.claudeBin,
  })
  logRunResult(runResult)

  // Step 7: post-session validation ------------------------------------------------
  const git = simpleGit(workingRoot)
  const branch = (await git.branch()).current
  const branchOk = branch !== project.autonomyConfig.branches.base
  const filesChanged = (await git.diff(['--name-only', `${project.autonomyConfig.branches.base}...HEAD`]))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const headSha = (await git.revparse(['HEAD'])).trim()
  const touchedMaestro = await verifyAgentTouchedMaestroDir(workingRoot, before)

  // Tracked across the rest of this function so the final status report can
  // accurately tell the developer whether a fixup turn actually fired.
  let didRunFixupTurn = false

  const baseFinalize = (
    status: SessionStatus,
    extra: Partial<SessionResult> = {},
  ): RunSessionOutput => {
    const updated = input.sessions.update(input.sessionId, {
      status,
      endedAt: new Date().toISOString(),
      branchName: branchOk ? branch : null,
      modelUsed: runResult.modelUsed,
      costCents: runResult.costCents,
      terminationCause: runResult.terminationCause,
      journalPath: touchedMaestro.newJournalFile
        ? join('.maestro', 'journal', touchedMaestro.newJournalFile)
        : null,
      ...extra,
    })
    void updated
    return {
      sessionId: input.sessionId,
      status,
      filesChanged,
      commitSha: filesChanged.length > 0 ? headSha : null,
      branchName: branchOk ? branch : null,
      prNumber: extra.prNumber ?? null,
      qualityGates: input.gates.listForSession(input.sessionId),
      costCents: runResult.costCents,
      journalPath: touchedMaestro.newJournalFile
        ? join('.maestro', 'journal', touchedMaestro.newJournalFile)
        : null,
      notes: extra.notes ?? null,
      logPath,
      fixupTurnRan: didRunFixupTurn,
    }
  }

  if (filesChanged.length === 0) {
    return baseFinalize('completed-no-changes', {
      notes: 'agent ran but produced no committed changes',
    })
  }
  if (!branchOk) {
    return baseFinalize('failed', {
      notes: `agent committed to ${branch} (must be a feature branch)`,
    })
  }
  if (!touchedMaestro.stateUpdated || !touchedMaestro.journalAppended) {
    return baseFinalize('failed', {
      notes: `agent skipped required .maestro/ updates (state=${touchedMaestro.stateUpdated}, journal=${touchedMaestro.journalAppended})`,
    })
  }

  // Step 8: quality gates ---------------------------------------------------------
  const gateRun = await runQualityGates({
    projectRoot: workingRoot,
    gates: project.autonomyConfig.qualityGates,
  })
  recordGateResults(input.sessionId, input.gates, gateRun.results)

  // Step 9: fixup turn ------------------------------------------------------------
  let secondGateRun = gateRun
  if (!gateRun.allPassed) {
    didRunFixupTurn = true
    const failureOutput = gateRun.results
      .filter((r) => r.status === 'failed')
      .map((r) => `## ${r.gate}\n\n${r.output}`)
      .join('\n\n')
    const fixupPrompt = buildFixupTurnPrompt({
      projectName: project.slug,
      timeBudgetSeconds: FIXUP_TURN_BUDGET_SECONDS,
      failureOutput,
    })
    const fixupSessionId = `${input.sessionId}-fixup`
    const fixupRow = input.sessions.insert({
      id: fixupSessionId,
      projectId: project.id,
      promptVersion: PROMPT_VERSION,
      isFixupTurn: true,
      parentSessionId: input.sessionId,
    })
    void fixupRow
    const fixupLogPath = sessionLogPath(config.dataDir, fixupSessionId)
    const fixupResult = await runClaudeSession({
      cwd: workingRoot,
      prompt: fixupPrompt,
      timeBudgetSeconds: FIXUP_TURN_BUDGET_SECONDS,
      logPath: fixupLogPath,
      claudeBin: input.claudeBin,
    })
    logRunResult(fixupResult)
    input.sessions.update(fixupSessionId, {
      status: fixupResult.exitCode === 0 ? 'completed' : 'failed',
      endedAt: new Date().toISOString(),
      logPath: fixupLogPath,
      modelUsed: fixupResult.modelUsed,
      costCents: fixupResult.costCents,
      terminationCause: fixupResult.terminationCause,
    })
    secondGateRun = await runQualityGates({
      projectRoot: workingRoot,
      gates: project.autonomyConfig.qualityGates,
    })
    recordGateResults(fixupSessionId, input.gates, secondGateRun.results)
  }

  // Step 10: PR creation ----------------------------------------------------------
  const baseBranch = project.autonomyConfig.branches.base
  await git.push(['-u', 'origin', branch])

  const githubClient =
    input.githubClient ??
    (config.githubToken
      ? createGitHubClient({ token: config.githubToken })
      : null)

  if (!secondGateRun.allPassed) {
    if (githubClient) {
      try {
        const repo = parseRepoUrl(project.repoUrl)
        const open = await githubClient.listOpenPullRequests(repo)
        const existing = open.find((pr) => pr.branchName === branch)
        if (existing) {
          await githubClient.addLabels({
            repo,
            prNumber: existing.number,
            labels: ['quality-gates-failed'],
          })
        }
      } catch (err) {
        logger.warn({ err }, 'could not label PR on quality-gate failure')
      }
    }
    return baseFinalize('quality-gate-failed', {
      notes: 'quality gates failed; branch pushed without PR',
    })
  }

  if (!githubClient) {
    return baseFinalize('completed', {
      notes: 'GITHUB_TOKEN not configured; branch pushed but PR not opened',
    })
  }

  let repo
  try {
    repo = parseRepoUrl(project.repoUrl)
  } catch (err) {
    logger.warn({ err, repoUrl: project.repoUrl }, 'cannot parse repo URL — branch pushed without PR')
    return baseFinalize('completed', {
      notes: 'branch pushed; PR not opened (non-GitHub URL)',
    })
  }

  const lastCommitSubject = (await git.log({ maxCount: 1 })).latest?.message ?? ''
  const title = lastCommitSubject || `Maestro: ${input.sessionId}`
  const journalRef = touchedMaestro.newJournalFile
    ? `\n\n_Session journal: \`.maestro/journal/${touchedMaestro.newJournalFile}\`_`
    : ''
  const gateSummary = secondGateRun.results
    .map((r) => `- **${r.gate}**: ${r.status}${r.durationMs ? ` (${Math.round(r.durationMs / 1000)}s)` : ''}`)
    .join('\n')
  const body = [
    `Drafted by Maestro session \`${input.sessionId}\`. Reviewed and merged by the developer.`,
    '',
    '### Quality gates',
    gateSummary,
    journalRef,
  ].join('\n')

  const pr = await githubClient.createPullRequest({
    repo,
    branchName: branch,
    baseBranch,
    title,
    body,
    draft:
      project.autonomyConfig.level === 'draft-only' ||
      project.autonomyConfig.github.draftByDefault,
    labels: project.autonomyConfig.github.prLabels,
  })

  return baseFinalize('completed', {
    prNumber: pr.number,
    notes: pr.url,
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────

function workingDirFor(dataDir: string, slug: string): string {
  return resolve(dataDir, WORK_SUBDIR, slug)
}

function sessionLogPath(dataDir: string, sessionId: string): string {
  return resolve(dataDir, LOGS_SUBDIR, `${sessionId}.log`)
}

function logRunResult(r: ClaudeRunResult): void {
  logger.info(
    {
      exitCode: r.exitCode,
      signal: r.signal,
      terminationCause: r.terminationCause,
      durationMs: r.durationMs,
      modelUsed: r.modelUsed,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costCents: r.costCents,
    },
    'claude session finished',
  )
}

function recordGateResults(
  sessionId: string,
  repo: QualityGateRepository,
  results: SingleGateResult[],
): void {
  for (const r of results) {
    repo.insert({
      sessionId,
      gateName: r.gate,
      status: r.status,
      output: r.output,
      durationMs: r.durationMs,
    })
  }
}

interface PrepareWorkingDirInput {
  workingRoot: string
  repoUrl: string
  baseBranch: string
  developerName: string
  developerEmail: string
}

async function prepareWorkingDir(input: PrepareWorkingDirInput): Promise<void> {
  await mkdir(dirname(input.workingRoot), { recursive: true })
  const exists = existsSync(input.workingRoot)
  const hasGit = exists && existsSync(join(input.workingRoot, '.git'))

  if (hasGit) {
    try {
      const git = simpleGit(input.workingRoot)
      await git.fetch(['--all', '--prune'])
      await git.checkout(input.baseBranch)
      await git.reset(['--hard', `origin/${input.baseBranch}`])
      await git.clean('f', ['-d', '-x'])
      await configureGitIdentity(git, input.developerName, input.developerEmail)
      return
    } catch (err) {
      logger.warn({ err, dir: input.workingRoot }, 're-init working dir from scratch')
      await rm(input.workingRoot, { recursive: true, force: true })
    }
  } else if (exists) {
    await rm(input.workingRoot, { recursive: true, force: true })
  }

  const git = simpleGit(dirname(input.workingRoot))
  try {
    await git.clone(input.repoUrl, input.workingRoot, ['--branch', input.baseBranch])
  } catch (err) {
    throw new MaestroError('GIT_OPERATION_FAILED', {
      message: `Failed to clone ${input.repoUrl}`,
      cause: err,
      context: { workingRoot: input.workingRoot, repoUrl: input.repoUrl },
    })
  }
  await configureGitIdentity(simpleGit(input.workingRoot), input.developerName, input.developerEmail)
}

async function configureGitIdentity(git: SimpleGit, name: string, email: string): Promise<void> {
  await git.addConfig('user.name', name, false, 'local')
  await git.addConfig('user.email', email, false, 'local')
}

/**
 * Pull a single concrete task out of state.md by reading the first
 * unchecked checkbox under "Next Concrete Tasks". Falls back to a
 * permissive note that lets the agent decide.
 */
function deriveTaskFromState(stateMd: string): string {
  const sectionMatch = /##\s*Next Concrete Tasks\s*\n([\s\S]*?)(\n##\s|$)/.exec(stateMd)
  const body = sectionMatch?.[1] ?? ''
  const firstUnchecked = /^-\s*\[\s*\]\s*(.+)$/m.exec(body)
  if (firstUnchecked?.[1]) {
    return firstUnchecked[1].trim()
  }
  return 'Pick the most important task from state.md "Next Concrete Tasks" — or do nothing and explain why in the journal.'
}

// ─── Re-exports for tests ────────────────────────────────────────────

export { sessionLogPath, workingDirFor, deriveTaskFromState }

// Type re-export so call-sites can pin to the local definition.
export type WorkerQualityGate = QualityGate
