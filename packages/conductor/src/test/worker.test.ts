// End-to-end worker integration tests using a local git "remote" + the
// mock-claude harness. No real claude, no real GitHub, no network.
//
// Each test sets up:
//   - a tmp dir
//   - a bare git repo acting as the GitHub "remote"
//   - a fixture working clone with .maestro/ populated, pushed to that remote
//   - a SQLite db (file-backed), a project row, and an InMemoryGitHubClient
// then calls runSession() with a mock-claude fixture that simulates the
// agent's side effects.

import { execSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../db.js'
import { ProjectRepository } from '../repositories.js'
import { runSession } from '../worker.js'
import type { Config } from '../config.js'
import type { ProjectAutonomyConfig } from '@maestro/shared'
import { DEFAULT_AUTONOMY_CONFIG } from '@maestro/shared'
import type { GitHubClient, RepoCoords } from '../pr-manager.js'
import type { CreatePullRequestInput, AddLabelsInput } from '../pr-manager.js'

const here = dirname(fileURLToPath(import.meta.url))
const MOCK_CLAUDE = join(here, 'mock-claude.mjs')

interface Harness {
  root: string
  remoteDir: string
  fixtureDir: string
  dataDir: string
  db: DbHandle
  config: Config
  projectId: string
  slug: string
}

const TEST_AUTONOMY: ProjectAutonomyConfig = {
  ...DEFAULT_AUTONOMY_CONFIG,
  // 5-minute budget — long enough that the mock's instant exit doesn't race
  // the wrap-up signal, short enough that a hung process surfaces quickly.
  timeBudget: 300,
  // Skip lint to keep stack detection fast; we'll add a typecheck stub.
  qualityGates: ['test', 'typecheck'],
  branches: { base: 'main', prefix: 'maestro/' },
}

async function gitInit(dir: string, opts: { bare?: boolean } = {}): Promise<void> {
  const args = opts.bare ? ['git', 'init', '--bare', '-b', 'main'] : ['git', 'init', '-b', 'main']
  execSync(args.join(' '), { cwd: dir, stdio: 'pipe' })
  if (!opts.bare) {
    execSync('git config user.email tester@example.com', { cwd: dir })
    execSync('git config user.name "Tester"', { cwd: dir })
  }
}

async function setupHarness(scenario: 'all-good' | 'failing-gate'): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'maestro-test-'))
  const remoteDir = join(root, 'remote.git')
  const fixtureDir = join(root, 'fixture')
  const dataDir = join(root, 'data')

  await mkdir(remoteDir, { recursive: true })
  await mkdir(fixtureDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  await gitInit(remoteDir, { bare: true })
  await gitInit(fixtureDir)

  // package.json for stack detection — provides scripts to run as "gates".
  const testScript = scenario === 'all-good' ? 'exit 0' : 'exit 0' // both scenarios let test pass
  const typecheckScript = scenario === 'all-good' ? 'exit 0' : 'exit 1'
  await writeFile(
    join(fixtureDir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-project',
        version: '0.0.0',
        private: true,
        scripts: {
          test: testScript,
          typecheck: typecheckScript,
        },
      },
      null,
      2,
    ),
  )

  // .maestro/ skeleton
  await mkdir(join(fixtureDir, '.maestro/journal'), { recursive: true })
  await writeFile(
    join(fixtureDir, '.maestro/state.md'),
    '# Current State\n\n## Focus\nTesting harness.\n\n## Next Concrete Tasks\n- [ ] Add a comment to the README\n\n## Blockers\n\n_(none)_\n\n## Recent Context\n\nNew project.\n\n## Notes\n\n',
  )
  await writeFile(
    join(fixtureDir, '.maestro/context.md'),
    '# Project Context — fixture-project\n\n## Stack\n\nNode.\n',
  )
  await writeFile(
    join(fixtureDir, '.maestro/autonomy.json'),
    JSON.stringify(TEST_AUTONOMY, null, 2),
  )
  await writeFile(join(fixtureDir, '.maestro/journal/.gitkeep'), '')
  await writeFile(join(fixtureDir, 'README.md'), '# Fixture\n')

  execSync('git add -A', { cwd: fixtureDir })
  execSync('git -c user.email=t@test -c user.name=Tester commit -m "init fixture"', {
    cwd: fixtureDir,
  })
  execSync(`git remote add origin ${remoteDir}`, { cwd: fixtureDir })
  execSync('git push -u origin main', { cwd: fixtureDir, stdio: 'pipe' })

  // Open the conductor SQLite at <dataDir>/maestro.db
  const db = openDatabase({ dataDir })
  const projects = new ProjectRepository(db.db)
  const slug = `fixture-${randomUUID().slice(0, 8)}`
  const projectId = randomUUID()
  projects.insert({
    id: projectId,
    slug,
    repoUrl: `file://${remoteDir}`,
    autonomyConfig: TEST_AUTONOMY,
  })

  const config: Config = {
    port: 3001,
    dataDir,
    developerName: 'Tester',
    developerGithubUsername: 'tester',
    nodeEnv: 'test',
    developerEmail: 'tester@example.com',
  }

  return { root, remoteDir, fixtureDir, dataDir, db, config, projectId, slug }
}

interface FakeGitHub extends GitHubClient {
  created: CreatePullRequestInput[]
  labelsAdded: AddLabelsInput[]
  merged: { prNumber: number; method?: string }[]
}

function fakeGitHub(opts: { mergeBlocked?: boolean } = {}): FakeGitHub {
  const created: CreatePullRequestInput[] = []
  const labelsAdded: AddLabelsInput[] = []
  const merged: { prNumber: number; method?: string }[] = []
  return {
    created,
    labelsAdded,
    merged,
    async createPullRequest(req) {
      created.push(req)
      return {
        number: 42,
        url: `https://example.test/pr/42`,
        title: req.title,
        body: req.body,
        status: req.draft ? 'draft' : 'open',
        branchName: req.branchName,
        baseBranch: req.baseBranch,
        createdAt: new Date().toISOString(),
        mergedAt: null,
        sessionId: null,
      }
    },
    async mergePullRequest(req) {
      merged.push({ prNumber: req.prNumber, method: req.method })
      if (opts.mergeBlocked) {
        return { status: 'blocked', reason: 'branch protection requires review' }
      }
      return { status: 'merged', sha: 'abcdef0123456789' }
    },
    async addLabels(req) {
      labelsAdded.push(req)
    },
    async listOpenPullRequests(_repo: RepoCoords) {
      return []
    },
    async verifyScopes() {
      /* no-op */
    },
  }
}

let harness: Harness | null = null

afterEach(async () => {
  if (harness) {
    harness.db.close()
    await rm(harness.root, { recursive: true, force: true })
    harness = null
  }
})

describe('runSession (integration)', () => {
  beforeEach(() => {
    // No-op: each test calls setupHarness in its own context.
  })

  it('happy path: agent commits, gates pass, PR opens', async () => {
    harness = await setupHarness('all-good')
    const { db, config, slug } = harness
    const projects = new ProjectRepository(db.db)
    const project = projects.findBySlug(slug)
    if (!project) throw new Error('project missing')

    const gh = fakeGitHub()
    process.env['MAESTRO_MOCK_INLINE'] = JSON.stringify({
      files: { 'README.md': '# Fixture\n\nTouched by mock.\n' },
      branch: `maestro/${slug}/touch-readme`,
      commitMessage: 'chore: touch README',
      stateBody:
        '# Current State\n\n## Focus\nTesting harness.\n\n## Next Concrete Tasks\n- [ ] Next thing\n\n## Blockers\n\n_(none)_\n\n## Recent Context\n\nMock touched README.\n\n## Notes\n\n',
      journalFilename: '2026-04-28-09-00.md',
      journalBody:
        '# Session 2026-04-28T09:00:00.000Z\n\n## Goal\nTouch README\n\n## What I Did\nAdded a line.\n',
      result: { usage: { input_tokens: 1234, output_tokens: 567 } },
    })

    const result = await runSession({
      db: db.db,
      config,
      project,
      claudeBin: MOCK_CLAUDE,
      githubClient: gh,
      skipClaudeProbe: true,
    })

    expect(result.status).toBe('completed')
    expect(result.branchName).toBe(`maestro/${slug}/touch-readme`)
    expect(result.qualityGates.length).toBeGreaterThan(0)
    expect(result.prNumber).toBe(42)
    expect(gh.created).toHaveLength(1)
    expect(gh.created[0]?.branchName).toBe(`maestro/${slug}/touch-readme`)
    expect(gh.created[0]?.baseBranch).toBe('main')

    // .maestro/ updates land in the working dir
    const wdState = await readFile(
      join(harness.dataDir, 'work', slug, '.maestro/state.md'),
      'utf-8',
    )
    expect(wdState).toContain('Mock touched README')
  }, 60_000)

  it('failed-gate path: agent commits, gate fails, no PR, fixup turn runs', async () => {
    harness = await setupHarness('failing-gate')
    const { db, config, slug } = harness
    const projects = new ProjectRepository(db.db)
    const project = projects.findBySlug(slug)
    if (!project) throw new Error('project missing')

    const gh = fakeGitHub()
    process.env['MAESTRO_MOCK_INLINE'] = JSON.stringify({
      files: { 'README.md': '# Fixture\n\nFailing path.\n' },
      branch: `maestro/${slug}/breakage`,
      commitMessage: 'chore: introduce break',
      stateBody:
        '# Current State\n\n## Focus\n.\n\n## Next Concrete Tasks\n- [ ] x\n\n## Blockers\n\n_(none)_\n\n## Recent Context\n\nx.\n\n## Notes\n\n',
      journalFilename: '2026-04-28-10-00.md',
      journalBody: '# Session 2026-04-28T10:00:00.000Z\n\n## Goal\nx.\n',
    })

    const result = await runSession({
      db: db.db,
      config,
      project,
      claudeBin: MOCK_CLAUDE,
      githubClient: gh,
      skipClaudeProbe: true,
    })

    expect(['quality-gate-failed', 'completed']).toContain(result.status)
    if (result.status === 'quality-gate-failed') {
      // No PR opened on quality-gate-failed
      expect(result.prNumber).toBeNull()
      expect(gh.created).toHaveLength(0)
      expect(result.fixupTurnRan).toBe(true)
    }
  }, 90_000)

  it('level: full auto-merges the PR after creation', async () => {
    harness = await setupHarness('all-good')
    const { db, config, slug } = harness
    const projects = new ProjectRepository(db.db)
    projects.updateAutonomyConfig(slug, { ...TEST_AUTONOMY, level: 'full' })
    const project = projects.findBySlug(slug)
    if (!project) throw new Error('project missing')

    const gh = fakeGitHub()
    process.env['MAESTRO_MOCK_INLINE'] = JSON.stringify({
      files: { 'README.md': '# Fixture\n\nAuto-merge path.\n' },
      branch: `maestro/${slug}/full-mode`,
      commitMessage: 'chore: full-mode change',
      stateBody:
        '# Current State\n\n## Focus\nFull mode.\n\n## Next Concrete Tasks\n- [ ] x\n\n## Blockers\n\n_(none)_\n\n## Recent Context\n\nx.\n\n## Notes\n\n',
      journalFilename: '2026-04-29-09-00.md',
      journalBody: '# Session 2026-04-29T09:00:00.000Z\n\n## Goal\nx.\n',
    })

    const result = await runSession({
      db: db.db,
      config,
      project,
      claudeBin: MOCK_CLAUDE,
      githubClient: gh,
      skipClaudeProbe: true,
    })

    expect(result.status).toBe('completed')
    expect(result.prNumber).toBe(42)
    expect(gh.created).toHaveLength(1)
    expect(gh.created[0]?.draft).toBe(false)
    expect(gh.merged).toHaveLength(1)
    expect(gh.merged[0]?.prNumber).toBe(42)
    expect(gh.merged[0]?.method).toBe('squash')
    expect(result.notes).toContain('auto-merged')
  }, 60_000)

  it('level: full leaves PR open with a note when auto-merge is blocked', async () => {
    harness = await setupHarness('all-good')
    const { db, config, slug } = harness
    const projects = new ProjectRepository(db.db)
    projects.updateAutonomyConfig(slug, { ...TEST_AUTONOMY, level: 'full' })
    const project = projects.findBySlug(slug)
    if (!project) throw new Error('project missing')

    const gh = fakeGitHub({ mergeBlocked: true })
    process.env['MAESTRO_MOCK_INLINE'] = JSON.stringify({
      files: { 'README.md': '# Fixture\n\nBlocked merge.\n' },
      branch: `maestro/${slug}/full-blocked`,
      commitMessage: 'chore: blocked merge',
      stateBody:
        '# Current State\n\n## Focus\nx.\n\n## Next Concrete Tasks\n- [ ] x\n\n## Blockers\n\n_(none)_\n\n## Recent Context\n\nx.\n\n## Notes\n\n',
      journalFilename: '2026-04-29-10-00.md',
      journalBody: '# Session 2026-04-29T10:00:00.000Z\n\n## Goal\nx.\n',
    })

    const result = await runSession({
      db: db.db,
      config,
      project,
      claudeBin: MOCK_CLAUDE,
      githubClient: gh,
      skipClaudeProbe: true,
    })

    expect(result.status).toBe('completed')
    expect(result.prNumber).toBe(42)
    expect(gh.merged).toHaveLength(1)
    expect(result.notes).toContain('auto-merge blocked')
  }, 60_000)

  it('refuses to run a second session for the same project (lock)', async () => {
    harness = await setupHarness('all-good')
    const { db, config, slug, projectId } = harness
    const projects = new ProjectRepository(db.db)
    const project = projects.findBySlug(slug)
    if (!project) throw new Error('project missing')

    // Take the lock manually to simulate a concurrent session.
    db.db
      .prepare('INSERT INTO project_locks (project_id, session_id, pid) VALUES (?, ?, ?)')
      .run(projectId, 'other-session', process.pid)

    process.env['MAESTRO_MOCK_INLINE'] = JSON.stringify({})

    await expect(
      runSession({
        db: db.db,
        config,
        project,
        claudeBin: MOCK_CLAUDE,
        githubClient: fakeGitHub(),
        skipClaudeProbe: true,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_LOCKED' })
  })
})
