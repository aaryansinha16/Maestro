// Phase 4 / Sub 1: PR feedback loop unit tests.
//
// Covers four behaviors:
//   1. syncPendingFeedback: bot/allowlist filtering + 5-minute cooldown
//   2. PrFeedbackRepository: upsert dedupes by comment_id, mark-processed
//      flips the right rows
//   3. extractAddressedPrNumbers: regex extracts PR numbers from journal text
//   4. The full prompt renders the FEEDBACK section when entries are present

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type DbHandle } from '../db.js'
import {
  PrFeedbackRepository,
  ProjectRepository,
  SessionRepository,
} from '../repositories.js'
import {
  PR_FEEDBACK_SYNC_COOLDOWN_MS,
  defaultAllowlistFor,
  extractAddressedPrNumbers,
  shouldIngestAuthor,
  syncPendingFeedback,
} from '../pr-feedback.js'
import {
  DEFAULT_AUTONOMY_CONFIG,
  buildSessionPrompt,
  type Project,
} from '@maestro/shared'
import type {
  GitHubClient,
  PullRequest,
  PullRequestComment,
  RepoCoords,
} from '../pr-manager.js'

interface Harness {
  db: DbHandle
  root: string
}
let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-prfb-'))
  const db = openDatabase({ dataDir: root })
  h = { db, root }
})

afterEach(async () => {
  if (h) {
    h.db.close()
    await rm(h.root, { recursive: true, force: true })
    h = null
  }
})

function addProject(slug: string): { project: Project; projectId: string } {
  if (!h) throw new Error('harness missing')
  const id = randomUUID()
  const projects = new ProjectRepository(h.db.db)
  const project = projects.insert({
    id,
    slug,
    repoUrl: `https://github.com/example/${slug}`,
    autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG },
  })
  return { project, projectId: id }
}

interface FakeGitHub extends GitHubClient {
  prs: PullRequest[]
  commentsByPr: Map<number, PullRequestComment[]>
  fetches: Array<{ prNumber: number; since?: string }>
}

function makeFakeGitHub(opts: {
  prs?: PullRequest[]
  commentsByPr?: Map<number, PullRequestComment[]>
}): FakeGitHub {
  const prs = opts.prs ?? []
  const commentsByPr = opts.commentsByPr ?? new Map()
  const fetches: Array<{ prNumber: number; since?: string }> = []
  return {
    prs,
    commentsByPr,
    fetches,
    async createPullRequest() {
      throw new Error('not used in these tests')
    },
    async mergePullRequest() {
      throw new Error('not used in these tests')
    },
    async addLabels() {},
    async listOpenPullRequests(_repo: RepoCoords) {
      return prs
    },
    async listPullRequestComments(req) {
      const sinceArg: { prNumber: number; since?: string } = { prNumber: req.prNumber }
      if (req.since !== undefined) sinceArg.since = req.since
      fetches.push(sinceArg)
      const all = commentsByPr.get(req.prNumber) ?? []
      if (!req.since) return all
      return all.filter((c) => c.postedAt > (req.since as string))
    },
    async verifyScopes() {},
  }
}

function pr(branch: string, number: number): PullRequest {
  return {
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    title: `PR ${number}`,
    body: '',
    status: 'open',
    branchName: branch,
    baseBranch: 'main',
    createdAt: '2026-04-29T00:00:00.000Z',
    mergedAt: null,
    sessionId: null,
  }
}

function comment(args: {
  id: number
  prNumber: number
  author: string
  body: string
  postedAt?: string
  kind?: 'issue' | 'review'
}): PullRequestComment {
  return {
    id: args.id,
    prNumber: args.prNumber,
    author: args.author,
    body: args.body,
    postedAt: args.postedAt ?? '2026-04-30T08:00:00.000Z',
    kind: args.kind ?? 'issue',
  }
}

describe('shouldIngestAuthor', () => {
  it('rejects always-bot accounts even if listed', () => {
    expect(
      shouldIngestAuthor('vercel[bot]', { authors: ['vercel[bot]', 'me'] }),
    ).toBe(false)
    expect(shouldIngestAuthor('github-actions[bot]', { authors: ['me'] })).toBe(false)
  })
  it('rejects any [bot]-suffixed login', () => {
    expect(shouldIngestAuthor('coolnewservice[bot]', { authors: ['me'] })).toBe(false)
  })
  it('accepts allowlisted humans (case-insensitive)', () => {
    expect(shouldIngestAuthor('aaryansinha16', { authors: ['Aaryansinha16'] })).toBe(true)
    expect(shouldIngestAuthor('AaryanSinha16', { authors: ['aaryansinha16'] })).toBe(true)
  })
  it('rejects non-allowlisted humans', () => {
    expect(shouldIngestAuthor('random-reviewer', { authors: ['me'] })).toBe(false)
  })
  it('rejects everyone when allowlist is empty', () => {
    expect(shouldIngestAuthor('me', { authors: [] })).toBe(false)
  })
})

describe('extractAddressedPrNumbers', () => {
  it('extracts simple "addressed PR #N feedback"', () => {
    expect(extractAddressedPrNumbers('I addressed PR #42 feedback in this turn.'))
      .toEqual([42])
  })
  it('extracts "addressed feedback on PR #N"', () => {
    expect(
      extractAddressedPrNumbers('Today I addressed feedback on PR #99 from the reviewer.'),
    ).toEqual([99])
  })
  it('handles multiple PR numbers + dedupes', () => {
    expect(
      extractAddressedPrNumbers(
        'addressed PR #42 feedback then addressed PR #42 feedback again. Also applied PR #7 feedback.',
      ),
    ).toEqual([7, 42])
  })
  it('returns empty when nothing matches', () => {
    expect(extractAddressedPrNumbers('No relevant phrases here.')).toEqual([])
  })
  it('is case-insensitive', () => {
    expect(extractAddressedPrNumbers('Applied PR #3 Feedback')).toEqual([3])
  })
})

describe('PrFeedbackRepository', () => {
  it('upsert dedupes by (project, comment_id)', () => {
    if (!h) throw new Error('harness missing')
    const { projectId } = addProject('p')
    const repo = new PrFeedbackRepository(h.db.db)
    const input = {
      projectId,
      prNumber: 42,
      prBranch: 'maestro/p/foo',
      commentId: 1001,
      commentBody: 'rename this',
      commentAuthor: 'me',
      postedAt: '2026-04-29T08:00:00.000Z',
    }
    expect(repo.upsert(input)).toBe(true)
    expect(repo.upsert(input)).toBe(false)
    expect(repo.pendingCount(projectId)).toBe(1)
  })

  it('markProcessedForPrs flips matching rows and leaves others alone', () => {
    if (!h) throw new Error('harness missing')
    const { projectId } = addProject('p')
    const repo = new PrFeedbackRepository(h.db.db)
    repo.upsert({
      projectId,
      prNumber: 42,
      prBranch: 'b1',
      commentId: 1,
      commentBody: 'a',
      commentAuthor: 'me',
      postedAt: '2026-04-29T08:00:00.000Z',
    })
    repo.upsert({
      projectId,
      prNumber: 7,
      prBranch: 'b2',
      commentId: 2,
      commentBody: 'b',
      commentAuthor: 'me',
      postedAt: '2026-04-29T08:01:00.000Z',
    })

    const sessions = new SessionRepository(h.db.db)
    const sessionId = randomUUID()
    sessions.insert({ id: sessionId, projectId, promptVersion: '1.2.0' })
    const updated = repo.markProcessedForPrs({
      projectId,
      prNumbers: [42],
      sessionId,
    })
    expect(updated).toBe(1)
    const pending = repo.pendingForProject(projectId)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.prNumber).toBe(7)
  })

  it('lastSyncedAt + recordSync round-trip', () => {
    if (!h) throw new Error('harness missing')
    const { projectId } = addProject('p')
    const repo = new PrFeedbackRepository(h.db.db)
    expect(repo.lastSyncedAt(projectId, 42)).toBeNull()
    repo.recordSync(projectId, 42, '2026-04-30T01:00:00.000Z')
    expect(repo.lastSyncedAt(projectId, 42)).toBe('2026-04-30T01:00:00.000Z')
    repo.recordSync(projectId, 42, '2026-04-30T02:00:00.000Z')
    expect(repo.lastSyncedAt(projectId, 42)).toBe('2026-04-30T02:00:00.000Z')
  })
})

describe('syncPendingFeedback', () => {
  it('ingests human comments + skips bot comments', async () => {
    if (!h) throw new Error('harness missing')
    const { project, projectId } = addProject('p')
    const commentsByPr = new Map<number, PullRequestComment[]>([
      [
        42,
        [
          comment({ id: 1, prNumber: 42, author: 'aaryansinha16', body: 'rename this' }),
          comment({ id: 2, prNumber: 42, author: 'vercel[bot]', body: 'preview ready' }),
          comment({ id: 3, prNumber: 42, author: 'unknown-stranger', body: 'hi' }),
        ],
      ],
    ])
    const gh = makeFakeGitHub({
      prs: [pr('maestro/p/auth-fix', 42)],
      commentsByPr,
    })
    const feedback = new PrFeedbackRepository(h.db.db)

    const out = await syncPendingFeedback({
      project,
      githubClient: gh,
      feedback,
      allowlist: defaultAllowlistFor('aaryansinha16'),
    })
    expect(out.prsChecked).toBe(1)
    expect(out.newComments).toBe(1)
    const pending = feedback.pendingForProject(projectId)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.commentAuthor).toBe('aaryansinha16')
    expect(pending[0]?.prBranch).toBe('maestro/p/auth-fix')
  })

  it('honors the 5-minute cooldown per PR', async () => {
    if (!h) throw new Error('harness missing')
    const { project } = addProject('p')
    const commentsByPr = new Map<number, PullRequestComment[]>([
      [42, [comment({ id: 1, prNumber: 42, author: 'me', body: 'a' })]],
    ])
    const gh = makeFakeGitHub({
      prs: [pr('maestro/p/branch', 42)],
      commentsByPr,
    })
    const feedback = new PrFeedbackRepository(h.db.db)
    const allowlist = { authors: ['me'] }

    const t0 = new Date('2026-04-30T08:00:00.000Z')
    const tBeforeCooldown = new Date(t0.getTime() + PR_FEEDBACK_SYNC_COOLDOWN_MS - 1000)
    const tAfterCooldown = new Date(t0.getTime() + PR_FEEDBACK_SYNC_COOLDOWN_MS + 1000)

    await syncPendingFeedback({ project, githubClient: gh, feedback, allowlist, now: () => t0 })
    expect(gh.fetches).toHaveLength(1)

    const second = await syncPendingFeedback({
      project,
      githubClient: gh,
      feedback,
      allowlist,
      now: () => tBeforeCooldown,
    })
    expect(second.skippedByCooldown).toBe(1)
    expect(gh.fetches).toHaveLength(1) // unchanged

    const third = await syncPendingFeedback({
      project,
      githubClient: gh,
      feedback,
      allowlist,
      now: () => tAfterCooldown,
    })
    expect(third.skippedByCooldown).toBe(0)
    expect(gh.fetches).toHaveLength(2)
    expect(gh.fetches[1]?.since).toBe(t0.toISOString())
  })

  it('only inspects PRs whose branch matches the project prefix', async () => {
    if (!h) throw new Error('harness missing')
    const { project } = addProject('p')
    const gh = makeFakeGitHub({
      prs: [
        pr('maestro/p/yes', 1),
        pr('feature/some-other-branch', 2),
      ],
    })
    const feedback = new PrFeedbackRepository(h.db.db)
    const out = await syncPendingFeedback({
      project,
      githubClient: gh,
      feedback,
      allowlist: { authors: ['me'] },
    })
    expect(out.prsChecked).toBe(1)
    expect(gh.fetches.map((f) => f.prNumber)).toEqual([1])
  })

  it('swallows GitHub errors and returns zero counts', async () => {
    if (!h) throw new Error('harness missing')
    const { project } = addProject('p')
    const gh: GitHubClient = {
      async createPullRequest() { throw new Error('not used') },
      async mergePullRequest() { throw new Error('not used') },
      async addLabels() {},
      async listOpenPullRequests() { throw new Error('rate limited') },
      async listPullRequestComments() { throw new Error('rate limited') },
      async verifyScopes() {},
    }
    const feedback = new PrFeedbackRepository(h.db.db)
    const out = await syncPendingFeedback({
      project,
      githubClient: gh,
      feedback,
      allowlist: { authors: ['me'] },
    })
    expect(out).toEqual({ prsChecked: 0, newComments: 0, skippedByCooldown: 0 })
  })
})

describe('buildSessionPrompt with PR feedback', () => {
  it('includes the FEEDBACK ON RECENT PRs section when entries are present', () => {
    const prompt = buildSessionPrompt({
      projectName: 'p',
      projectSlug: 'p',
      timeBudgetSeconds: 2700,
      developerName: 'Tester',
      context: '# context',
      state: '# state',
      recentJournal: [{ filename: '2026-04-15-08-00-00.md', body: 'prev' }],
      task: 'do the thing',
      qualityGates: ['test'],
      pendingPrFeedback: [
        {
          prNumber: 42,
          branchName: 'maestro/p/foo',
          author: 'me',
          body: 'rename `bar` to `baz`',
          postedAt: '2026-04-29T08:00:00.000Z',
        },
      ],
    })
    expect(prompt).toContain('== FEEDBACK ON RECENT PRs ==')
    expect(prompt).toContain('PR #42')
    expect(prompt).toContain('maestro/p/foo')
    expect(prompt).toContain('rename `bar` to `baz`')
  })

  it('omits the FEEDBACK section when no entries are present', () => {
    const prompt = buildSessionPrompt({
      projectName: 'p',
      projectSlug: 'p',
      timeBudgetSeconds: 2700,
      developerName: 'Tester',
      context: '# context',
      state: '# state',
      recentJournal: [{ filename: '2026-04-15-08-00-00.md', body: 'prev' }],
      task: 'do the thing',
      qualityGates: ['test'],
    })
    expect(prompt).not.toContain('== FEEDBACK ON RECENT PRs ==')
  })
})
