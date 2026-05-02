// GitHub PR operations. Thin Octokit wrapper with retry/backoff for rate
// limits and a one-time scope check on first use.
//
// Tests must NOT hit GitHub. Production code paths construct their own
// Octokit (via `createGitHubClient`); tests inject a mock that conforms to
// `GitHubClient`.

import { Octokit } from '@octokit/rest'
import pRetry, { AbortError } from 'p-retry'
import {
  MaestroError,
  PullRequestSchema,
  type Project,
  type PullRequest,
} from '@maestro/shared'
import { logger } from './logger.js'

// ─── Public types ────────────────────────────────────────────────────

export interface GitHubClient {
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>
  mergePullRequest(input: MergePullRequestInput): Promise<MergePullRequestResult>
  addLabels(input: AddLabelsInput): Promise<void>
  listOpenPullRequests(repo: RepoCoords): Promise<PullRequest[]>
  /**
   * Fetch comments on a PR. Returns both issue-level comments and
   * review-level comments collapsed into one chronological list, since
   * for the feedback-loop use case the distinction does not matter.
   *
   * `since` is an ISO timestamp; the GitHub API only returns comments
   * newer than this value when provided.
   */
  listPullRequestComments(input: ListPullRequestCommentsInput): Promise<PullRequestComment[]>
  verifyScopes(): Promise<void>
}

export interface RepoCoords {
  owner: string
  repo: string
}

export interface CreatePullRequestInput {
  repo: RepoCoords
  branchName: string
  baseBranch: string
  title: string
  body: string
  draft?: boolean
  labels?: string[]
}

export interface AddLabelsInput {
  repo: RepoCoords
  prNumber: number
  labels: string[]
}

export interface MergePullRequestInput {
  repo: RepoCoords
  prNumber: number
  /** Defaults to 'squash' — the agent's WIP commits collapse to one PR commit. */
  method?: 'merge' | 'squash' | 'rebase'
  commitTitle?: string
  commitMessage?: string
}

export type MergePullRequestResult =
  | { status: 'merged'; sha: string }
  | { status: 'blocked'; reason: string }

export interface ListPullRequestCommentsInput {
  repo: RepoCoords
  prNumber: number
  /** ISO timestamp; only comments posted after this are returned. */
  since?: string
}

export interface PullRequestComment {
  id: number
  prNumber: number
  /** GitHub login (e.g. `aaryansinha16`, `vercel[bot]`). */
  author: string
  body: string
  postedAt: string
  /** "issue" = top-level PR thread; "review" = inline review comment. */
  kind: 'issue' | 'review'
}

// ─── Construction ────────────────────────────────────────────────────

export interface CreateGitHubClientInput {
  token: string
  /** Optional override for tests. */
  octokitFactory?: (token: string) => Octokit
}

export function createGitHubClient(input: CreateGitHubClientInput): GitHubClient {
  const octokit = input.octokitFactory
    ? input.octokitFactory(input.token)
    : new Octokit({ auth: input.token, userAgent: 'maestro/0.0.0' })

  return {
    async createPullRequest(req) {
      return runWithRetry(async () => {
        const { data } = await octokit.pulls.create({
          owner: req.repo.owner,
          repo: req.repo.repo,
          head: req.branchName,
          base: req.baseBranch,
          title: req.title,
          body: req.body,
          draft: req.draft ?? false,
        })

        if (req.labels && req.labels.length > 0) {
          await octokit.issues.addLabels({
            owner: req.repo.owner,
            repo: req.repo.repo,
            issue_number: data.number,
            labels: req.labels,
          })
        }

        return PullRequestSchema.parse({
          number: data.number,
          url: data.html_url,
          title: data.title,
          body: data.body ?? '',
          status: data.draft ? 'draft' : 'open',
          branchName: data.head.ref,
          baseBranch: data.base.ref,
          createdAt: data.created_at,
          mergedAt: data.merged_at ?? null,
          sessionId: null,
        })
      }, 'createPullRequest')
    },

    async addLabels(req) {
      await runWithRetry(async () => {
        await octokit.issues.addLabels({
          owner: req.repo.owner,
          repo: req.repo.repo,
          issue_number: req.prNumber,
          labels: req.labels,
        })
      }, 'addLabels')
    },

    async mergePullRequest(req) {
      // Branch protection / unmergeable states return 405/409 from
      // GitHub. Surface those as a structured `blocked` outcome rather
      // than throwing, so a `level: full` session leaves the PR open
      // for the developer to merge manually instead of failing the
      // whole run.
      try {
        const { data } = await octokit.pulls.merge({
          owner: req.repo.owner,
          repo: req.repo.repo,
          pull_number: req.prNumber,
          merge_method: req.method ?? 'squash',
          commit_title: req.commitTitle,
          commit_message: req.commitMessage,
        })
        return { status: 'merged', sha: data.sha }
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 405 || status === 409 || status === 422) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn({ prNumber: req.prNumber, status, message }, 'auto-merge blocked')
          return { status: 'blocked', reason: message }
        }
        throw err
      }
    },

    async listOpenPullRequests(repo) {
      return runWithRetry(async () => {
        const { data } = await octokit.pulls.list({
          owner: repo.owner,
          repo: repo.repo,
          state: 'open',
          per_page: 100,
        })
        return data.map((pr) =>
          PullRequestSchema.parse({
            number: pr.number,
            url: pr.html_url,
            title: pr.title,
            body: pr.body ?? '',
            status: pr.draft ? 'draft' : 'open',
            branchName: pr.head.ref,
            baseBranch: pr.base.ref,
            createdAt: pr.created_at,
            mergedAt: pr.merged_at ?? null,
            sessionId: null,
          }),
        )
      }, 'listOpenPullRequests')
    },

    async listPullRequestComments(req) {
      // Issue + review comment endpoints are separate. We merge them so
      // the worker doesn't have to care about the difference — for the
      // feedback-loop use case both kinds carry the same signal.
      const sinceArg = req.since ? { since: req.since } : {}
      const [issue, review] = await runWithRetry(async () => {
        const issueRes = await octokit.issues.listComments({
          owner: req.repo.owner,
          repo: req.repo.repo,
          issue_number: req.prNumber,
          per_page: 100,
          ...sinceArg,
        })
        const reviewRes = await octokit.pulls.listReviewComments({
          owner: req.repo.owner,
          repo: req.repo.repo,
          pull_number: req.prNumber,
          per_page: 100,
          ...sinceArg,
        })
        return [issueRes.data, reviewRes.data] as const
      }, 'listPullRequestComments')

      const issueComments: PullRequestComment[] = issue.map((c) => ({
        id: c.id,
        prNumber: req.prNumber,
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        postedAt: c.created_at,
        kind: 'issue' as const,
      }))
      const reviewComments: PullRequestComment[] = review.map((c) => ({
        id: c.id,
        prNumber: req.prNumber,
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        postedAt: c.created_at,
        kind: 'review' as const,
      }))
      return [...issueComments, ...reviewComments]
        .filter((c) => c.body.trim().length > 0)
        .sort((a, b) => a.postedAt.localeCompare(b.postedAt))
    },

    async verifyScopes() {
      try {
        // The token's scopes come back in the response headers from a
        // simple `get authenticated user` call.
        const res = await octokit.users.getAuthenticated()
        const scopes = (res.headers['x-oauth-scopes'] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        // Fine-grained PATs return an empty x-oauth-scopes; only classic
        // tokens populate it. We treat empty as "fine-grained, trust it".
        if (scopes.length > 0 && !scopes.some((s) => s === 'repo' || s === 'public_repo')) {
          throw new MaestroError('GITHUB_API_FAILED', {
            message: 'GitHub token is missing the `repo` scope',
            context: { scopes },
          })
        }
        logger.debug({ scopes, login: res.data.login }, 'github token verified')
      } catch (err) {
        if (err instanceof MaestroError) throw err
        throw new MaestroError('GITHUB_API_FAILED', {
          message: 'Failed to verify GitHub token scopes',
          cause: err,
        })
      }
    },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse "https://github.com/owner/repo[.git]" or "git@github.com:owner/repo"
 * into RepoCoords. Also accepts "file://" URLs (returns synthetic
 * `local`/<basename> coordinates) so test harnesses can exercise the
 * worker against bare local repos. Throws on anything else.
 */
export function parseRepoUrl(url: string): RepoCoords {
  const trimmed = url.trim().replace(/\.git$/, '')
  const httpsMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/.exec(trimmed)
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] }
  }
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/.exec(trimmed)
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] }
  }
  const fileMatch = /^file:\/\/(.+)$/.exec(trimmed)
  if (fileMatch?.[1]) {
    const segments = fileMatch[1].split('/').filter(Boolean)
    const basename = segments[segments.length - 1] ?? 'local'
    return { owner: 'local', repo: basename }
  }
  throw new MaestroError('CONFIG_VALIDATION_FAILED', {
    message: `Repository URL does not look like a GitHub URL: ${url}`,
    context: { url },
  })
}

export function repoCoordsForProject(project: Project): RepoCoords {
  return parseRepoUrl(project.repoUrl)
}

async function runWithRetry<T>(fn: () => Promise<T>, op: string): Promise<T> {
  return pRetry(
    async () => {
      try {
        return await fn()
      } catch (err) {
        if (isRateLimit(err)) {
          logger.warn({ op }, 'github rate limited, will retry')
          throw err // p-retry retries
        }
        // Other errors are abort-worthy — most GitHub failures are not
        // transient.
        throw new AbortError(err instanceof Error ? err.message : String(err))
      }
    },
    { retries: 3, factor: 2, minTimeout: 2000, maxTimeout: 30000 },
  )
}

function isRateLimit(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: number; message?: string }
  if (e.status === 403 || e.status === 429) {
    if (typeof e.message === 'string' && /rate limit/i.test(e.message)) return true
  }
  return false
}

// ─── Backwards-compat shim ───────────────────────────────────────────

// Older code in PRs imported `openPullRequest` directly. Keep it for now
// so the worker can call it without ceremony; production callers should
// prefer `createGitHubClient(...).createPullRequest(...)`.
export interface OpenPullRequestInput {
  project: Project
  branchName: string
  baseBranch: string
  title: string
  body: string
  draft?: boolean
  labels?: string[]
  client: GitHubClient
}

export async function openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
  return input.client.createPullRequest({
    repo: repoCoordsForProject(input.project),
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    title: input.title,
    body: input.body,
    draft: input.draft ?? false,
    labels: input.labels ?? [],
  })
}
