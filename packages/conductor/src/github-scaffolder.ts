// Phase 4.5 / Sub 4.5.4 — scaffold `.maestro/` on GitHub without a local
// clone. Used by POST /api/projects/init.
//
// Why API-direct instead of clone-and-push: the conductor may run on a
// small-disk host (Railway). Five small file commits through the contents
// API cost a handful of HTTP calls and zero disk. The trade-off — one
// commit per file instead of a single atomic commit — is acceptable for
// an init PR that's reviewed before merge anyway.

import type {
  GitHubClient,
  RepoCoords,
} from './pr-manager.js'
import { logger } from './logger.js'

export interface ScaffoldOnGitHubInput {
  client: GitHubClient
  repo: RepoCoords
  /** path → content. Committed in sorted-path order for determinism. */
  files: Record<string, string>
  branchName: string
  baseBranch: string
  prTitle: string
  prBody: string
  /**
   * When false, commit straight to baseBranch and skip the PR. Only for
   * repos the developer owns end-to-end; the wizard defaults to true.
   */
  openAsPR: boolean
  prLabels?: string[]
}

export interface ScaffoldResult {
  branch: string
  prUrl: string | null
  prNumber: number | null
  commitShas: string[]
}

export async function scaffoldOnGitHub(input: ScaffoldOnGitHubInput): Promise<ScaffoldResult> {
  const { client, repo, files } = input
  const targetBranch = input.openAsPR ? input.branchName : input.baseBranch

  if (input.openAsPR) {
    await client.createBranch({
      repo,
      branchName: input.branchName,
      fromBranch: input.baseBranch,
    })
  }

  const commitShas: string[] = []
  for (const path of Object.keys(files).sort()) {
    const content = files[path] ?? ''
    const { commitSha } = await client.commitFile({
      repo,
      branch: targetBranch,
      path,
      content,
      message: `chore: maestro init — ${path}`,
    })
    commitShas.push(commitSha)
  }

  logger.info(
    { repo: `${repo.owner}/${repo.repo}`, branch: targetBranch, files: commitShas.length },
    'github-scaffolder: files committed',
  )

  if (!input.openAsPR) {
    return { branch: targetBranch, prUrl: null, prNumber: null, commitShas }
  }

  const pr = await client.createPullRequest({
    repo,
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    title: input.prTitle,
    body: input.prBody,
    draft: false,
    labels: input.prLabels ?? ['maestro'],
  })

  return { branch: input.branchName, prUrl: pr.url, prNumber: pr.number, commitShas }
}
