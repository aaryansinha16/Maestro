// GitHub PR operations. Wraps Octokit. Phase 1 work (see PRODUCT_VISION.md
// "Phase 1: Manual Single-Project Sessions"). The Phase 0 file is a stub.

import type { Project, PullRequest } from '@maestro/shared'
import { MaestroError } from '@maestro/shared'

export interface OpenPullRequestInput {
  project: Project
  branchName: string
  baseBranch: string
  title: string
  body: string
  draft?: boolean
  labels?: string[]
}

export async function openPullRequest(_input: OpenPullRequestInput): Promise<PullRequest> {
  throw new MaestroError('INTERNAL_ERROR', {
    message: 'openPullRequest is Phase 1 work. See PRODUCT_VISION.md.',
  })
}
