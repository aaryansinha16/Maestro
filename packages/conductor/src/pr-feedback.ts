// Phase 4 / Sub 1: PR feedback loop.
//
// Before a session starts, the worker calls `syncPendingFeedback` to fetch
// reviewer comments on the project's open Maestro-opened PRs. Bot accounts
// (vercel[bot], github-actions[bot], etc.) are filtered out via a configurable
// allowlist; the default allowlist is just the developer's GitHub username,
// so the agent never reacts to CI noise.
//
// After a session completes, the worker calls `markFeedbackProcessedFromJournal`
// to clear feedback for any PR the agent acknowledged in its journal entry
// ("addressed PR #42 feedback"). Anything still unprocessed surfaces in the
// next session's prompt.

import type { Project } from '@maestro/shared'
import { type PrFeedbackRepository } from './repositories.js'
import { logger } from './logger.js'
import {
  parseRepoUrl,
  type GitHubClient,
  type PullRequestComment,
} from './pr-manager.js'

// ─── Defaults ────────────────────────────────────────────────────────

/** Don't refetch a given PR's comments faster than this. */
export const PR_FEEDBACK_SYNC_COOLDOWN_MS = 5 * 60 * 1000

/** Bot accounts always excluded, even if not in the user's allowlist. */
const ALWAYS_BOT_AUTHORS = new Set([
  'vercel[bot]',
  'netlify[bot]',
  'railway[bot]',
  'github-actions[bot]',
  'dependabot[bot]',
  'renovate[bot]',
  'codecov[bot]',
  'sonarcloud[bot]',
])

// ─── Public API ──────────────────────────────────────────────────────

export interface PrFeedbackAllowlist {
  /**
   * GitHub logins whose comments are ingested. Authors not in this list
   * (and not in the always-bot-authors deny set) are silently dropped.
   * Defaults to `[config.developerGithubUsername]`.
   */
  authors: string[]
}

export interface SyncPendingFeedbackInput {
  project: Project
  githubClient: GitHubClient
  feedback: PrFeedbackRepository
  allowlist: PrFeedbackAllowlist
  /** Override the wallclock for tests. */
  now?: () => Date
}

/**
 * Walk the project's open Maestro-opened PRs (branch starts with the
 * configured prefix), fetch any new comments since the last sync, filter
 * via the allowlist, and persist new ones. Honors the 5-minute cooldown
 * per PR.
 *
 * Errors fetching from GitHub are logged and swallowed — feedback is a
 * best-effort enrichment, never a blocker for running a session.
 */
export async function syncPendingFeedback(input: SyncPendingFeedbackInput): Promise<{
  prsChecked: number
  newComments: number
  skippedByCooldown: number
}> {
  const { project, githubClient, feedback, allowlist } = input
  const now = (input.now ?? (() => new Date()))()

  let repoCoords
  try {
    repoCoords = parseRepoUrl(project.repoUrl)
  } catch {
    return { prsChecked: 0, newComments: 0, skippedByCooldown: 0 }
  }

  let openPrs
  try {
    openPrs = await githubClient.listOpenPullRequests(repoCoords)
  } catch (err) {
    logger.warn({ err, slug: project.slug }, 'pr-feedback: listOpenPullRequests failed')
    return { prsChecked: 0, newComments: 0, skippedByCooldown: 0 }
  }

  const prefix = project.autonomyConfig.branches.prefix
  const ours = openPrs.filter((pr) => pr.branchName.startsWith(prefix))

  let prsChecked = 0
  let newComments = 0
  let skippedByCooldown = 0

  for (const pr of ours) {
    const lastSynced = feedback.lastSyncedAt(project.id, pr.number)
    if (lastSynced) {
      const elapsed = now.getTime() - new Date(lastSynced).getTime()
      if (elapsed < PR_FEEDBACK_SYNC_COOLDOWN_MS) {
        skippedByCooldown += 1
        continue
      }
    }
    prsChecked += 1
    let comments: PullRequestComment[]
    try {
      comments = await githubClient.listPullRequestComments({
        repo: repoCoords,
        prNumber: pr.number,
        ...(lastSynced ? { since: lastSynced } : {}),
      })
    } catch (err) {
      logger.warn(
        { err, slug: project.slug, prNumber: pr.number },
        'pr-feedback: listPullRequestComments failed; will retry on next session',
      )
      continue
    }
    for (const c of comments) {
      if (!shouldIngestAuthor(c.author, allowlist)) continue
      const inserted = feedback.upsert({
        projectId: project.id,
        prNumber: pr.number,
        prBranch: pr.branchName,
        commentId: c.id,
        commentBody: c.body,
        commentAuthor: c.author,
        postedAt: c.postedAt,
      })
      if (inserted) newComments += 1
    }
    feedback.recordSync(project.id, pr.number, now.toISOString())
  }

  if (newComments > 0 || prsChecked > 0) {
    logger.info(
      { slug: project.slug, prsChecked, newComments, skippedByCooldown },
      'pr-feedback: sync complete',
    )
  }
  return { prsChecked, newComments, skippedByCooldown }
}

export function shouldIngestAuthor(
  author: string,
  allowlist: PrFeedbackAllowlist,
): boolean {
  if (ALWAYS_BOT_AUTHORS.has(author)) return false
  // GitHub's bot suffix convention catches forks not in the static deny set.
  if (author.toLowerCase().endsWith('[bot]')) return false
  if (allowlist.authors.length === 0) return false
  return allowlist.authors.some((a) => a.toLowerCase() === author.toLowerCase())
}

// ─── Post-session marking ────────────────────────────────────────────

/**
 * Heuristic: scan a journal entry body for PR numbers the agent claims
 * to have addressed. Marks all unprocessed feedback rows for those PRs
 * as processed. Returns the number of rows updated.
 *
 * Patterns matched (case-insensitive):
 *   - "addressed PR #42 feedback"
 *   - "addressed feedback on PR #42"
 *   - "applied PR #42 feedback"
 *   - "in response to PR #42"
 *
 * False negatives are fine — the developer can always trigger another
 * session and the same feedback will appear again.
 */
export function markFeedbackProcessedFromJournal(opts: {
  projectId: string
  sessionId: string
  journalBody: string
  feedback: PrFeedbackRepository
}): number {
  const prNumbers = extractAddressedPrNumbers(opts.journalBody)
  if (prNumbers.length === 0) return 0
  return opts.feedback.markProcessedForPrs({
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    prNumbers,
  })
}

const ADDRESSED_PR_PATTERNS = [
  /addressed\s+pr\s*#(\d+)\s+feedback/gi,
  /addressed\s+feedback\s+on\s+pr\s*#(\d+)/gi,
  /applied\s+pr\s*#(\d+)\s+feedback/gi,
  /in\s+response\s+to\s+pr\s*#(\d+)/gi,
]

export function extractAddressedPrNumbers(journalBody: string): number[] {
  const found = new Set<number>()
  for (const pattern of ADDRESSED_PR_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(journalBody)) !== null) {
      const n = Number(match[1])
      if (Number.isFinite(n) && n > 0) found.add(n)
    }
  }
  return [...found].sort((a, b) => a - b)
}

// ─── Allowlist construction ──────────────────────────────────────────

export function defaultAllowlistFor(developerGithubUsername: string): PrFeedbackAllowlist {
  return { authors: [developerGithubUsername] }
}
