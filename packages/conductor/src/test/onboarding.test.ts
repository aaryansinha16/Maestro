// Phase 4.5 / Sub 4.5.4 — onboarding via dashboard.
//
// Four surfaces:
//   1. project-init renderers (pure functions)
//   2. github-scaffolder call sequencing against a fake GitHubClient
//   3. server endpoints: probe / init / register (fake client injected)
//   4. project-register against a local file:// bare repo
//
// The CLI keeps its own behavior by importing the same modules, so these
// tests double as regression cover for `maestro init` / `maestro add`.

import { execSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../db.js'
import { ProjectRepository } from '../repositories.js'
import { buildServer } from '../server.js'
import {
  buildAutonomyFromAnswers,
  buildMaestroFiles,
  renderContextMd,
  renderStateMd,
  seedFromPackageJson,
} from '../project-init.js'
import { scaffoldOnGitHub } from '../github-scaffolder.js'
import { registerProject } from '../project-register.js'
import {
  AutonomyFileSchema,
  DEFAULT_AUTONOMY_CONFIG,
} from '@maestro/shared'
import type {
  CommitFileInput,
  CreateBranchInput,
  CreatePullRequestInput,
  GitHubClient,
} from '../pr-manager.js'

// ─── 1. Renderers ────────────────────────────────────────────────────

describe('project-init renderers', () => {
  it('renderStateMd includes focus + checkbox tasks', () => {
    const md = renderStateMd({ focus: 'Ship the parser.', tasks: ['Fix tokenizer', 'Add tests'] })
    expect(md).toContain('## Focus\nShip the parser.')
    expect(md).toContain('- [ ] Fix tokenizer')
    expect(md).toContain('- [ ] Add tests')
    expect(md).toContain('orientation only')
  })

  it('renderStateMd uses placeholder when tasks are empty', () => {
    const md = renderStateMd({ focus: 'x', tasks: [] })
    expect(md).toContain('_add 3-5 concrete tasks here_')
  })

  it('renderContextMd renders package.json seed with scripts + deps + NEVER list', () => {
    const seed = seedFromPackageJson(
      JSON.stringify({
        name: 'cool-app',
        description: 'A cool app',
        scripts: { test: 'vitest', build: 'tsc' },
        dependencies: { hono: '1', zod: '2' },
        devDependencies: { '@types/node': '1', vitest: '2' },
      }),
      'fallback',
    )
    expect(seed).not.toBeNull()
    const md = renderContextMd(seed!)
    expect(md).toContain('# Project Context — cool-app')
    expect(md).toContain('> A cool app')
    expect(md).toContain('- `test`: `vitest`')
    expect(md).toContain('- hono')
    expect(md).not.toContain('@types/node') // filtered
    expect(md).toContain('## Project-specific NEVER list')
  })

  it('seedFromPackageJson returns null on malformed JSON', () => {
    expect(seedFromPackageJson('{nope', 'x')).toBeNull()
  })

  it('buildMaestroFiles emits the canonical five-file set with valid autonomy JSON', () => {
    const autonomy = buildAutonomyFromAnswers({
      level: 'pr-only',
      schedule: '0 */6 * * *',
      timeBudgetMinutes: 45,
      qualityGates: ['test', 'lint'],
      branchPrefix: 'maestro',
    })
    const files = buildMaestroFiles({
      state: renderStateMd({ focus: 'x', tasks: [] }),
      context: '# ctx',
      autonomy,
    })
    expect(Object.keys(files).sort()).toEqual([
      '.maestro/autonomy.json',
      '.maestro/context.md',
      '.maestro/decisions.md',
      '.maestro/journal/.gitkeep',
      '.maestro/state.md',
    ])
    // autonomy.json round-trips through the schema
    const parsed = AutonomyFileSchema.parse(JSON.parse(files['.maestro/autonomy.json']!))
    expect(parsed.branches.prefix).toBe('maestro/') // trailing slash added
    expect(parsed.timeBudget).toBe(45 * 60)
  })
})

// ─── 2. Scaffolder sequencing ────────────────────────────────────────

interface ScaffoldFake extends GitHubClient {
  calls: string[]
  branches: CreateBranchInput[]
  commits: CommitFileInput[]
  prs: CreatePullRequestInput[]
}

function scaffoldFake(): ScaffoldFake {
  const calls: string[] = []
  const branches: CreateBranchInput[] = []
  const commits: CommitFileInput[] = []
  const prs: CreatePullRequestInput[] = []
  return {
    calls,
    branches,
    commits,
    prs,
    async createBranch(req) {
      calls.push('createBranch')
      branches.push(req)
      return { sha: 'base-sha' }
    },
    async commitFile(req) {
      calls.push(`commitFile:${req.path}`)
      commits.push(req)
      return { commitSha: `sha-${commits.length}` }
    },
    async createPullRequest(req) {
      calls.push('createPullRequest')
      prs.push(req)
      return {
        number: 7,
        url: 'https://example.test/pr/7',
        title: req.title,
        body: req.body,
        status: 'open',
        branchName: req.branchName,
        baseBranch: req.baseBranch,
        createdAt: new Date().toISOString(),
        mergedAt: null,
        sessionId: null,
      }
    },
    async mergePullRequest() {
      throw new Error('not used')
    },
    async addLabels() {},
    async listOpenPullRequests() {
      return []
    },
    async listPullRequestComments() {
      return []
    },
    async getRepoInfo() {
      return { defaultBranch: 'main', description: 'desc', private: false }
    },
    async getFileContent() {
      return null
    },
    async verifyScopes() {},
  }
}

describe('scaffoldOnGitHub', () => {
  it('creates branch from base, commits files in sorted order, opens PR', async () => {
    const gh = scaffoldFake()
    const result = await scaffoldOnGitHub({
      client: gh,
      repo: { owner: 'o', repo: 'r' },
      files: { 'b.md': 'b', 'a.md': 'a' },
      branchName: 'maestro/init',
      baseBranch: 'main',
      prTitle: 'chore: maestro init',
      prBody: 'body',
      openAsPR: true,
    })
    expect(gh.calls).toEqual([
      'createBranch',
      'commitFile:a.md',
      'commitFile:b.md',
      'createPullRequest',
    ])
    expect(gh.branches[0]).toMatchObject({ branchName: 'maestro/init', fromBranch: 'main' })
    expect(gh.commits.every((c) => c.branch === 'maestro/init')).toBe(true)
    expect(gh.prs[0]).toMatchObject({ branchName: 'maestro/init', baseBranch: 'main' })
    expect(result.prNumber).toBe(7)
    expect(result.prUrl).toBe('https://example.test/pr/7')
    expect(result.commitShas).toHaveLength(2)
  })

  it('openAsPR=false commits straight to base branch with no branch/PR calls', async () => {
    const gh = scaffoldFake()
    const result = await scaffoldOnGitHub({
      client: gh,
      repo: { owner: 'o', repo: 'r' },
      files: { 'a.md': 'a' },
      branchName: 'maestro/init',
      baseBranch: 'main',
      prTitle: 't',
      prBody: 'b',
      openAsPR: false,
    })
    expect(gh.calls).toEqual(['commitFile:a.md'])
    expect(gh.commits[0]?.branch).toBe('main')
    expect(result.prUrl).toBeNull()
    expect(result.branch).toBe('main')
  })
})

// ─── 3. Server endpoints ─────────────────────────────────────────────

interface Harness {
  db: DbHandle
  root: string
}
let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-onb-'))
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

function serverWith(gh?: GitHubClient) {
  if (!h) throw new Error('harness missing')
  return buildServer({
    startedAt: Date.now(),
    version: 'test',
    db: h.db.db,
    dataDir: h.root,
    developerName: 'Tester',
    ...(gh ? { githubClient: gh } : {}),
  })
}

describe('GET /api/github/probe', () => {
  it('returns rendered seed context + default branch + maestro detection', async () => {
    const gh = scaffoldFake()
    gh.getFileContent = async ({ path }) => {
      if (path === 'package.json') {
        return JSON.stringify({ name: 'probed-app', scripts: { test: 'jest' } })
      }
      if (path === 'README.md') return '# Probed App\n\nHello.'
      return null // .maestro/state.md missing
    }
    const res = await serverWith(gh).request(
      '/api/github/probe?repoUrl=https://github.com/o/r',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projectName: string
      defaultBranch: string
      hasMaestroDir: boolean
      suggestedContext: string
    }
    expect(body.projectName).toBe('probed-app')
    expect(body.defaultBranch).toBe('main')
    expect(body.hasMaestroDir).toBe(false)
    expect(body.suggestedContext).toContain('# Project Context — probed-app')
    expect(body.suggestedContext).toContain('README excerpt')
  })

  it('503s when no GitHub client is available', async () => {
    const res = await serverWith().request(
      '/api/github/probe?repoUrl=https://github.com/o/r',
    )
    expect(res.status).toBe(503)
  })

  it('400s on a non-URL repoUrl', async () => {
    const res = await serverWith(scaffoldFake()).request('/api/github/probe?repoUrl=nope')
    expect(res.status).toBe(400)
  })
})

describe('POST /api/projects/init', () => {
  it('scaffolds the five files and returns the PR coordinates', async () => {
    const gh = scaffoldFake()
    const res = await serverWith(gh).request('/api/projects/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/o/r',
        focus: 'Get the tokenizer right.',
        tasks: ['Fix lexer'],
        autonomy: { ...DEFAULT_AUTONOMY_CONFIG },
        context: '# My context',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { branch: string; prUrl: string | null; prNumber: number | null }
    expect(body.branch).toBe('maestro/init')
    expect(body.prNumber).toBe(7)
    // Five files committed, sorted; context passed through verbatim.
    expect(gh.commits.map((c) => c.path)).toEqual([
      '.maestro/autonomy.json',
      '.maestro/context.md',
      '.maestro/decisions.md',
      '.maestro/journal/.gitkeep',
      '.maestro/state.md',
    ])
    const context = gh.commits.find((c) => c.path === '.maestro/context.md')
    expect(context?.content).toContain('# My context')
    const state = gh.commits.find((c) => c.path === '.maestro/state.md')
    expect(state?.content).toContain('Get the tokenizer right.')
    expect(state?.content).toContain('- [ ] Fix lexer')
  })

  it('rejects a body without focus', async () => {
    const res = await serverWith(scaffoldFake()).request('/api/projects/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/o/r',
        autonomy: { ...DEFAULT_AUTONOMY_CONFIG },
      }),
    })
    expect(res.status).toBe(400)
  })
})

// ─── 4. registerProject against a local repo ────────────────────────

async function makeFixtureRemote(root: string): Promise<string> {
  const remote = join(root, 'remote.git')
  const work = join(root, 'fixture')
  await mkdir(remote, { recursive: true })
  await mkdir(work, { recursive: true })
  execSync('git init --bare -b main', { cwd: remote, stdio: 'ignore' })
  execSync('git init -b main', { cwd: work, stdio: 'ignore' })
  execSync('git config user.email t@t && git config user.name T', { cwd: work })
  await mkdir(join(work, '.maestro/journal'), { recursive: true })
  await writeFile(
    join(work, '.maestro/state.md'),
    '# Current State\n\n## Focus\nx\n\n## Next Concrete Tasks\n- [ ] x\n',
  )
  await writeFile(join(work, '.maestro/context.md'), '# ctx\n')
  await writeFile(
    join(work, '.maestro/autonomy.json'),
    JSON.stringify({ ...DEFAULT_AUTONOMY_CONFIG }, null, 2),
  )
  await writeFile(join(work, '.maestro/journal/.gitkeep'), '')
  await writeFile(join(work, 'README.md'), '# fixture\n')
  execSync('git add -A && git commit -m init', { cwd: work, stdio: 'ignore' })
  execSync(`git remote add origin ${remote} && git push -u origin main`, {
    cwd: work,
    stdio: 'ignore',
  })
  return remote
}

describe('registerProject', () => {
  it('clones, validates .maestro/, and inserts the project row', async () => {
    if (!h) throw new Error('harness missing')
    const remote = await makeFixtureRemote(h.root)
    const project = await registerProject({
      db: h.db.db,
      repoUrl: `file://${remote}`,
    })
    expect(project.slug).toBe('local-remote')
    expect(project.autonomyConfig.level).toBe(DEFAULT_AUTONOMY_CONFIG.level)
    expect(new ProjectRepository(h.db.db).findBySlug('local-remote')).not.toBeNull()
  })

  it('throws on duplicate registration', async () => {
    if (!h) throw new Error('harness missing')
    const remote = await makeFixtureRemote(h.root)
    await registerProject({ db: h.db.db, repoUrl: `file://${remote}` })
    await expect(
      registerProject({ db: h.db.db, repoUrl: `file://${remote}` }),
    ).rejects.toThrow(/already registered/)
  })

  it('throws when .maestro/ is missing from the repo', async () => {
    if (!h) throw new Error('harness missing')
    const remote = join(h.root, 'bare2.git')
    const work = join(h.root, 'fixture2')
    await mkdir(remote, { recursive: true })
    await mkdir(work, { recursive: true })
    execSync('git init --bare -b main', { cwd: remote, stdio: 'ignore' })
    execSync('git init -b main', { cwd: work, stdio: 'ignore' })
    execSync('git config user.email t@t && git config user.name T', { cwd: work })
    await writeFile(join(work, 'README.md'), 'no maestro here\n')
    execSync('git add -A && git commit -m init', { cwd: work, stdio: 'ignore' })
    execSync(`git remote add origin ${remote} && git push -u origin main`, {
      cwd: work,
      stdio: 'ignore',
    })
    await expect(
      registerProject({ db: h.db.db, repoUrl: `file://${remote}` }),
    ).rejects.toMatchObject({ code: 'CONTEXT_FILE_MISSING' })
  })
})
