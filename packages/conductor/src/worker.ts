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
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import simpleGit, { type SimpleGit } from 'simple-git'
import {
  CONTINUATION_TURN_OVERHEAD_SECONDS,
  COST_WARN_PER_SESSION_CENTS,
  DEFAULT_SESSION_BUDGET_USD,
  FIXUP_TURN_BUDGET_SECONDS,
  LOGS_SUBDIR,
  MaestroError,
  PROMPT_VERSION,
  WORK_SUBDIR,
  buildFixupTurnPrompt,
  buildSessionPrompt,
  isOrientationModeFromContext,
  type ContinuationContext,
  type Project,
  type PullRequest,
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
  PrFeedbackRepository,
  ProjectRepository,
  QualityGateRepository,
  SessionRepository,
  SessionTurnRepository,
} from './repositories.js'
import {
  defaultAllowlistFor,
  markFeedbackProcessedFromJournal,
  syncPendingFeedback,
  type PrFeedbackAllowlist,
} from './pr-feedback.js'
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
  /**
   * Phase 4 / Sub 1: override the PR-feedback author allowlist. Defaults to
   * `[config.developerGithubUsername]`. Tests inject a custom allowlist; the
   * production default is the developer's GitHub login.
   */
  prFeedbackAllowlist?: PrFeedbackAllowlist
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
  const turns = new SessionTurnRepository(input.db)

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

  const sessionStartMs = Date.now()
  let result: RunSessionOutput | null = null
  try {
    // Turn 1 -----------------------------------------------------------------------
    let turnNumber = 1
    if (!input.dryRun) turns.insert({ sessionId, turnNumber })
    result = await runSessionInner({ ...input, sessionId, sessions, gates, projects })
    if (!input.dryRun) recordTurnFromResult(turns, sessionId, turnNumber, result)

    // Phase 4 / Sub 2: continuation. Opt-in per autonomy.json. Each turn
    // gets the remaining budget (minus the per-turn overhead) and opens its
    // own PR. The loop exits as soon as state.md has no more concrete
    // tasks, the budget falls below minTimeForContinuation, or the last
    // turn failed / produced no PR.
    const previousPrs: number[] = result.prNumber ? [result.prNumber] : []
    while (
      !input.dryRun &&
      input.project.autonomyConfig.continueUntilBudget &&
      shouldContinueAfterTurn(result, input.project, sessionStartMs)
    ) {
      const totalBudget = input.project.autonomyConfig.timeBudget
      const elapsedSeconds = Math.floor((Date.now() - sessionStartMs) / 1000)
      const remaining = totalBudget - elapsedSeconds
      const nextTurnBudget = remaining - CONTINUATION_TURN_OVERHEAD_SECONDS
      if (nextTurnBudget < input.project.autonomyConfig.minTimeForContinuation) {
        logger.info(
          {
            sessionId,
            elapsedSeconds,
            remaining,
            min: input.project.autonomyConfig.minTimeForContinuation,
          },
          'continuation: budget below min — stopping',
        )
        break
      }
      const workingRoot = workingDirFor(input.config.dataDir, input.project.slug)
      try {
        await softResetForNextTurn(
          workingRoot,
          input.project.autonomyConfig.branches.base,
        )
      } catch (err) {
        logger.warn({ err, sessionId }, 'continuation: soft-reset failed; stopping')
        break
      }
      // Re-read state.md after the reset; if no remaining tasks, stop.
      const restoredState = await readMaestroDir(workingRoot)
      const nextTask = deriveTaskFromState(restoredState.state.raw)
      if (!nextTask || /^_\(/.test(nextTask)) {
        logger.info({ sessionId }, 'continuation: state.md has no next task — stopping')
        break
      }
      turnNumber += 1
      turns.insert({ sessionId, turnNumber })
      result = await runSessionInner({
        ...input,
        sessionId,
        sessions,
        gates,
        projects,
        continuation: { turnNumber, previousPrNumbers: previousPrs.slice() },
        timeBudgetSecondsOverride: nextTurnBudget,
      })
      recordTurnFromResult(turns, sessionId, turnNumber, result)
      if (result.prNumber) previousPrs.push(result.prNumber)
    }

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

/**
 * Phase 4 / Sub 2: a turn produced something worth continuing from when:
 *   - the run completed (status = 'completed'), AND
 *   - the run actually opened a PR or made changes the agent acknowledged
 *     in state.md (we use prNumber as the proxy for "the agent did real
 *     work this turn"), AND
 *   - we did not hit a quality-gate failure / time-out / failure path.
 * 'completed-no-changes' explicitly STOPS continuation: the agent told us
 * there is nothing to do.
 */
function shouldContinueAfterTurn(
  result: RunSessionOutput,
  _project: Project,
  _sessionStartMs: number,
): boolean {
  if (result.status !== 'completed') return false
  if (!result.prNumber) return false
  return true
}

function recordTurnFromResult(
  turns: SessionTurnRepository,
  sessionId: string,
  turnNumber: number,
  result: RunSessionOutput,
): void {
  // Map RunSessionOutput.status (SessionStatus) onto the narrower turn
  // status enum. Anything not in the enum collapses to 'failed'.
  const allowed: ReadonlyArray<RunSessionOutput['status']> = [
    'completed',
    'completed-no-changes',
    'quality-gate-failed',
    'timed-out',
    'failed',
    'cancelled',
  ]
  const status = (allowed.includes(result.status) ? result.status : 'failed') as
    | 'completed'
    | 'completed-no-changes'
    | 'quality-gate-failed'
    | 'timed-out'
    | 'failed'
    | 'cancelled'
  turns.update(sessionId, turnNumber, {
    branchName: result.branchName,
    prNumber: result.prNumber,
    prUrl: result.notes && /https?:\/\//.test(result.notes) ? result.notes.split(' ')[0] ?? null : null,
    status,
    costCents: result.costCents,
    endedAt: new Date().toISOString(),
    notes: result.notes,
  })
}

interface InnerInput extends RunSessionInput {
  sessionId: string
  sessions: SessionRepository
  gates: QualityGateRepository
  projects: ProjectRepository
  /**
   * Phase 4 / Sub 2: when set, this is a continuation turn (turn >= 2).
   * The worker skips prepareWorkingDir (the caller has already done a
   * soft reset that carries .maestro/ across turns) and the prompt
   * grows a CONTINUATION preamble.
   */
  continuation?: ContinuationContext
  /**
   * Phase 4 / Sub 2: per-turn time budget override. When set, replaces
   * `project.autonomyConfig.timeBudget` for the Claude invocation. Used
   * by continuation turns so each subsequent turn gets only the
   * remaining budget, not a fresh full ceiling.
   */
  timeBudgetSecondsOverride?: number
}

async function runSessionInner(input: InnerInput): Promise<RunSessionOutput> {
  const { project, config } = input
  const workingRoot = workingDirFor(config.dataDir, project.slug)
  const logPath = sessionLogPath(config.dataDir, input.sessionId)

  // Step 2: working directory ------------------------------------------------------
  // Continuation turns (Sub 2) skip the prepare; the caller has already
  // done a soft reset that carries .maestro/ across the boundary.
  if (!input.continuation) {
    await prepareWorkingDir({
      workingRoot,
      repoUrl: project.repoUrl,
      baseBranch: project.autonomyConfig.branches.base,
      developerName: config.developerName,
      developerEmail: config.developerEmail ?? `${config.developerGithubUsername}@users.noreply.github.com`,
    })
  }

  // Step 3: read .maestro/ ----------------------------------------------------------
  const maestro = await readMaestroDir(workingRoot)
  const recentJournal = await listRecentJournal(workingRoot, 3)

  // Phase 4 / Sub 1: fetch any pending reviewer comments on the project's
  // open Maestro PRs. Best-effort — failures are logged and the prompt
  // simply omits the section. Skipped on dry runs so `--dry-run` doesn't
  // talk to GitHub.
  const feedbackRepo = new PrFeedbackRepository(input.db)
  if (!input.dryRun) {
    const githubClient =
      input.githubClient ??
      (config.githubToken
        ? createGitHubClient({ token: config.githubToken })
        : null)
    if (githubClient) {
      await syncPendingFeedback({
        project,
        githubClient,
        feedback: feedbackRepo,
        allowlist:
          input.prFeedbackAllowlist ??
          defaultAllowlistFor(config.developerGithubUsername),
      })
    }
  }
  const pendingFeedback = feedbackRepo.pendingForProject(project.id)

  // Step 4: build prompt ------------------------------------------------------------
  const task = deriveTaskFromState(maestro.state.raw)
  const neverTouch = parseNeverTouchSection(maestro.context)
  const turnTimeBudget = input.timeBudgetSecondsOverride ?? project.autonomyConfig.timeBudget
  const promptCtx = {
    projectName: project.slug,
    projectSlug: project.slug,
    timeBudgetSeconds: turnTimeBudget,
    developerName: config.developerName,
    context: maestro.context,
    state: maestro.state.raw,
    recentJournal: recentJournal.map((j) => ({ filename: j.filename, body: j.body })),
    task,
    qualityGates: project.autonomyConfig.qualityGates,
    isFirstSession: recentJournal.length === 0,
    projectSpecificNeverTouch: neverTouch,
    pendingPrFeedback: pendingFeedback.map((f) => ({
      prNumber: f.prNumber,
      branchName: f.prBranch,
      author: f.commentAuthor,
      body: f.commentBody,
      postedAt: f.postedAt,
    })),
    ...(input.continuation ? { continuation: input.continuation } : {}),
  }
  const orientationMode = isOrientationModeFromContext(promptCtx)
  const prompt = buildSessionPrompt(promptCtx)

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
    timeBudgetSeconds: turnTimeBudget,
    logPath,
    claudeBin: input.claudeBin,
    maxBudgetUsd: sessionBudgetUsd(),
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
  // Which session's gate rows the final report reflects. Advances to the fixup
  // turn's id once a fixup runs, so the reported gates show the LAST run, not
  // the failed first one. ENG-09.
  let gateReportSessionId = input.sessionId

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
    // Phase 4 / Sub 1: if the agent's journal claims it addressed any PR
    // feedback, mark those rows processed. Best-effort; failure here must
    // not block the session result.
    void markFeedbackFromNewJournal({
      workingRoot,
      newJournalFile: touchedMaestro.newJournalFile,
      projectId: project.id,
      sessionId: input.sessionId,
      feedback: feedbackRepo,
    })
    return {
      sessionId: input.sessionId,
      status,
      filesChanged,
      commitSha: filesChanged.length > 0 ? headSha : null,
      branchName: branchOk ? branch : null,
      prNumber: extra.prNumber ?? null,
      qualityGates: input.gates.listForSession(gateReportSessionId),
      costCents: runResult.costCents,
      journalPath: touchedMaestro.newJournalFile
        ? join('.maestro', 'journal', touchedMaestro.newJournalFile)
        : null,
      notes: extra.notes ?? null,
      logPath,
      fixupTurnRan: didRunFixupTurn,
    }
  }

  // Orientation mode: agent should have updated .maestro/ but made no code
  // changes. Skip gates entirely and never open a PR. The branch (if any)
  // is preserved so the developer can review what the agent observed.
  if (orientationMode) {
    if (!touchedMaestro.stateUpdated && !touchedMaestro.journalAppended) {
      return baseFinalize('failed', {
        notes: 'orientation session ran but did not update state.md or journal',
      })
    }
    return baseFinalize('completed', {
      notes:
        'orientation session — context.md / state.md updated, no code changes, no PR opened',
    })
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
      maxBudgetUsd: sessionBudgetUsd(),
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
    gateReportSessionId = fixupSessionId
  }

  // Step 10: PR creation ----------------------------------------------------------
  const baseBranch = project.autonomyConfig.branches.base
  // Push with a token-authenticated URL when we have a token + GitHub HTTPS
  // remote (like GitHub Actions) — this sidesteps git credential helpers,
  // which are fragile headless and, since Git 2.50, break the push's credential
  // store step (VAL-01: "Configuring credential.helper is not permitted"). For
  // local/test (file://) or token-less setups, fall back to the ambient origin.
  // The token is never persisted (no `-u`) and redacted from any error. ENG-07.
  const pushRemote = authenticatedPushUrl(project.repoUrl, config.githubToken)
  try {
    await (pushRemote ? git.push([pushRemote, branch]) : git.push(['-u', 'origin', branch]))
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const safe = config.githubToken ? raw.split(config.githubToken).join('***') : raw
    throw new Error(`git push failed: ${safe}`)
  }

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

  // If the agent reused an existing branch (e.g. addressing PR feedback by
  // adding commits to the open PR's branch — which is what a developer would
  // do), GitHub returns 422 on createPullRequest because a PR already exists
  // for that head ref. The push above already updated that PR with the new
  // commits, so we just need to recognise the situation and proceed without
  // creating a duplicate. Without this check the 422 throws out of the worker
  // before baseFinalize runs, which means PR-feedback rows never get marked
  // processed and the next session sees the same feedback again.
  let pr: PullRequest
  let prAlreadyExisted = false
  const openPrs = await githubClient.listOpenPullRequests(repo).catch((err) => {
    logger.warn({ err }, 'could not pre-check open PRs; will attempt create')
    return [] as PullRequest[]
  })
  const existing = openPrs.find((p) => p.branchName === branch)
  if (existing) {
    pr = existing
    prAlreadyExisted = true
    logger.info(
      { prNumber: pr.number, branch },
      'pr-manager: branch already has an open PR — added commits to existing PR',
    )
  } else {
    pr = await githubClient.createPullRequest({
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
  }

  if (project.autonomyConfig.level === 'full') {
    const merge = await githubClient.mergePullRequest({
      repo,
      prNumber: pr.number,
      method: 'squash',
      commitTitle: title,
    })
    if (merge.status === 'merged') {
      logger.info(
        { prNumber: pr.number, sha: merge.sha, slug: project.slug },
        'auto-merged PR (level=full)',
      )
      return baseFinalize('completed', {
        prNumber: pr.number,
        notes: `${pr.url} (auto-merged ${merge.sha.slice(0, 7)})`,
      })
    }
    logger.warn(
      { prNumber: pr.number, slug: project.slug, reason: merge.reason },
      'auto-merge blocked; PR left open',
    )
    return baseFinalize('completed', {
      prNumber: pr.number,
      notes: `${pr.url} (auto-merge blocked: ${merge.reason})`,
    })
  }

  return baseFinalize('completed', {
    prNumber: pr.number,
    notes: prAlreadyExisted ? `${pr.url} (commits added to existing PR)` : pr.url,
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────

function workingDirFor(dataDir: string, slug: string): string {
  return resolve(dataDir, WORK_SUBDIR, slug)
}

/**
 * Build a token-authenticated HTTPS push URL for a GitHub repo, or null when
 * there's no token or the remote isn't github.com HTTPS. Pushing to this URL
 * avoids git credential helpers — fragile on headless hosts and, since Git
 * 2.50, blocked when the push's credential *store* step runs a `!shell` helper
 * (surfaced by VAL-01 as "Configuring credential.helper is not permitted").
 * The token lives only in the transient push argument (never persisted via
 * `-u`, never logged — redacted on error), matching how GitHub Actions pushes
 * and the single-owner self-host threat model. ENG-07.
 */
export function authenticatedPushUrl(repoUrl: string, token: string | undefined): string | null {
  if (!token) return null
  const m = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(repoUrl.trim())
  if (!m) return null
  return `https://x-access-token:${token}@github.com/${m[1]}/${m[2]}.git`
}

function sessionLogPath(dataDir: string, sessionId: string): string {
  return resolve(dataDir, LOGS_SUBDIR, `${sessionId}.log`)
}

/**
 * Hard per-session spend backstop (ENG-03), passed to claude via
 * --max-budget-usd so a runaway loop can't consume unbounded budget inside
 * the wall-clock window. Reads MAESTRO_SESSION_BUDGET_USD; a non-positive
 * value disables the cap. Applied to both the main turn and the fixup turn.
 */
function sessionBudgetUsd(): number | undefined {
  const raw = process.env['MAESTRO_SESSION_BUDGET_USD']
  if (raw === undefined || raw.trim() === '') return DEFAULT_SESSION_BUDGET_USD
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_SESSION_BUDGET_USD
  return n > 0 ? n : undefined
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
  if (r.costCents !== null && r.costCents > COST_WARN_PER_SESSION_CENTS) {
    logger.warn(
      { costCents: r.costCents, threshold: COST_WARN_PER_SESSION_CENTS },
      'expensive session — cost above threshold',
    )
  }
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

// Build artefact directories that we deliberately keep across sessions
// (ADR-019). Reinstalling these on every refresh burns Claude budget on
// `pnpm install` instead of actual work. They're regenerated lazily by
// the project's own tooling and blown away by `maestro reset` / `gc`.
const CACHE_DIRS = [
  'node_modules',
  '.pnpm-store',
  'target',
  'vendor',
  '.venv',
  '.next',
  '.turbo',
  '.cache',
  '__pycache__',
  'build',
  'dist',
] as const

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
      // Clean only untracked source files; preserve cached build artefacts
      // listed in CACHE_DIRS via -e exclude flags. Without -x we don't
      // touch ignored files (.env etc) which is fine — managed projects
      // don't keep secrets in working clones.
      const cleanFlags = ['-fd', ...CACHE_DIRS.flatMap((d) => ['-e', d])]
      await git.raw(['clean', ...cleanFlags])
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
 * unchecked checkbox under "Next Concrete Tasks". Returns an empty string
 * when no concrete task exists — the prompt builder then routes to
 * orientation mode rather than asking the agent to "pick something."
 */
function deriveTaskFromState(stateMd: string): string {
  const sectionMatch = /##\s*Next Concrete Tasks\s*\n([\s\S]*?)(\n##\s|$)/.exec(stateMd)
  const body = sectionMatch?.[1] ?? ''
  const firstUnchecked = /^-\s*\[\s*\]\s*(.+)$/m.exec(body)
  if (firstUnchecked?.[1]) {
    const candidate = firstUnchecked[1].trim()
    // Skip placeholder bullets seeded by `maestro init` so a fresh repo
    // routes to orientation mode rather than telling the agent "add 3-5
    // concrete tasks here" as if it were a task.
    if (/^_.*_$/.test(candidate)) return ''
    return candidate
  }
  return ''
}

/**
 * Read context.md and pull "## Project-specific NEVER list" or "## Never
 * Touch" items out as bullets. The agent already reads context.md, but
 * surfacing these as a structured list lets the prompt's rule #6 quote
 * them verbatim — making the boundary unmistakable rather than something
 * the agent has to extract on its own.
 */
function parseNeverTouchSection(contextMd: string): string[] {
  const heading = /^##\s*(?:Project-specific NEVER list|Never Touch|Never-touch)\b.*$/im
  const match = heading.exec(contextMd)
  if (!match || match.index === undefined) return []
  const tail = contextMd.slice(match.index + match[0].length)
  const sectionEnd = /\n##\s/.exec(tail)
  const body = sectionEnd ? tail.slice(0, sectionEnd.index) : tail
  return body
    .split('\n')
    .map((line) => {
      const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line)
      return m?.[1] ?? null
    })
    .filter((s): s is string => s !== null && s.length > 0 && !/^_.*_$/.test(s))
}

// ─── Phase 4 / Sub 2: soft reset between continuation turns ─────────

/**
 * Carry .maestro/ across a continuation boundary. Turn N produced commits
 * on a feature branch (already pushed and PR-opened). Turn N+1 should
 * start from a clean base branch but still see the agent's updated
 * state.md / context.md / journal — otherwise the next turn would pick
 * up the SAME task turn N just finished.
 *
 * Steps:
 *   1. Capture .maestro/ from the current working tree (turn N's branch tip).
 *   2. Switch to the base branch and reset to origin/<base>.
 *   3. Replace .maestro/ in the working tree with the captured copy.
 *   4. The next turn's agent will commit those .maestro/ updates as part
 *      of its own branch.
 *
 * Throws if the working dir isn't a git repo or the base branch doesn't
 * exist; the caller catches and stops continuation in that case.
 */
async function softResetForNextTurn(workingRoot: string, baseBranch: string): Promise<void> {
  const { cp, mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const maestroPath = joinPath(workingRoot, '.maestro')
  if (!existsSync(maestroPath)) return

  const tmp = await mkdtemp(joinPath(tmpdir(), 'maestro-soft-reset-'))
  const tmpMaestro = joinPath(tmp, '.maestro')
  await cp(maestroPath, tmpMaestro, { recursive: true })

  try {
    const git = simpleGit(workingRoot)
    await git.fetch(['origin', baseBranch])
    await git.checkout(baseBranch)
    await git.reset(['--hard', `origin/${baseBranch}`])
    // Replace .maestro/ with the snapshot. Reset already removed any
    // uncommitted changes; this writes the carried-over copy on top of
    // whatever .maestro/ shipped on base.
    await rm(maestroPath, { recursive: true, force: true })
    await cp(tmpMaestro, maestroPath, { recursive: true })
    logger.info({ workingRoot, baseBranch }, 'continuation: soft reset complete')
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

// ─── PR feedback marking ─────────────────────────────────────────────

interface MarkFeedbackFromJournalInput {
  workingRoot: string
  newJournalFile: string | null
  projectId: string
  sessionId: string
  feedback: PrFeedbackRepository
}

async function markFeedbackFromNewJournal(input: MarkFeedbackFromJournalInput): Promise<void> {
  if (!input.newJournalFile) return
  try {
    const path = join(input.workingRoot, '.maestro', 'journal', input.newJournalFile)
    if (!existsSync(path)) return
    const body = await readFile(path, 'utf-8')
    const updated = markFeedbackProcessedFromJournal({
      projectId: input.projectId,
      sessionId: input.sessionId,
      journalBody: body,
      feedback: input.feedback,
    })
    if (updated > 0) {
      logger.info(
        { sessionId: input.sessionId, updated },
        'pr-feedback: marked rows processed from journal',
      )
    }
  } catch (err) {
    logger.warn({ err }, 'pr-feedback: failed to mark journal-addressed feedback')
  }
}

// ─── Working-dir maintenance API ─────────────────────────────────────

/**
 * Blow away the working clone for a slug. Used by `maestro reset` and
 * `maestro gc`. Safe to call when the clone doesn't exist.
 */
export async function destroyWorkingDir(dataDir: string, slug: string): Promise<void> {
  const path = workingDirFor(dataDir, slug)
  if (!existsSync(path)) return
  await rm(path, { recursive: true, force: true })
}

/**
 * The age of the working clone in days, by mtime of the .git directory.
 * Used by `maestro gc` to decide which clones to blow away.
 */
export async function workingDirAgeDays(dataDir: string, slug: string): Promise<number | null> {
  const path = workingDirFor(dataDir, slug)
  const gitDir = join(path, '.git')
  if (!existsSync(gitDir)) return null
  const { stat: statFn } = await import('node:fs/promises')
  const info = await statFn(gitDir).catch(() => null)
  if (!info) return null
  return (Date.now() - info.mtimeMs) / (1000 * 60 * 60 * 24)
}

// ─── Re-exports for tests ────────────────────────────────────────────

export {
  sessionLogPath,
  workingDirFor,
  deriveTaskFromState,
  parseNeverTouchSection,
  softResetForNextTurn,
  CACHE_DIRS,
}

// Type re-export so call-sites can pin to the local definition.
export type WorkerQualityGate = QualityGate
