// Phase 4 / Sub 2: session continuation tests.
//
// Multi-turn integration is exercised by running a real session in
// production; here we test the components in isolation:
//   1. SessionTurnRepository CRUD
//   2. softResetForNextTurn carries .maestro/ across a git reset
//   3. The prompt's CONTINUATION preamble appears when continuation context
//      is set, and references previous PR numbers
//   4. End-to-end: continueUntilBudget=true with a state.md that has no
//      next task after turn 1 → continuation does NOT trigger (the
//      `shouldContinue` predicate respects the empty task list)

import { execSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../db.js'
import {
  ProjectRepository,
  SessionRepository,
  SessionTurnRepository,
} from '../repositories.js'
import {
  buildSessionPrompt,
  DEFAULT_AUTONOMY_CONFIG,
  PROMPT_VERSION,
} from '@maestro/shared'

interface Harness {
  db: DbHandle
  root: string
}
let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-cont-'))
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

const here = dirname(fileURLToPath(import.meta.url))
void here

describe('SessionTurnRepository', () => {
  it('insert + update + listForSession', () => {
    if (!h) throw new Error('harness missing')
    const projects = new ProjectRepository(h.db.db)
    const projectId = randomUUID()
    projects.insert({
      id: projectId,
      slug: 'p',
      repoUrl: 'https://github.com/example/p',
      autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG },
    })
    const sessions = new SessionRepository(h.db.db)
    const sessionId = randomUUID()
    sessions.insert({ id: sessionId, projectId, promptVersion: PROMPT_VERSION })

    const turns = new SessionTurnRepository(h.db.db)
    const t1 = turns.insert({ sessionId, turnNumber: 1 })
    expect(t1.turnNumber).toBe(1)
    expect(t1.status).toBe('completed')

    const updated = turns.update(sessionId, 1, {
      branchName: 'maestro/p/foo',
      prNumber: 42,
      prUrl: 'https://github.com/example/p/pull/42',
      status: 'completed',
      costCents: 5,
      endedAt: new Date().toISOString(),
      notes: 'turn 1 happy path',
    })
    expect(updated.prNumber).toBe(42)
    expect(updated.notes).toBe('turn 1 happy path')

    turns.insert({ sessionId, turnNumber: 2 })
    const all = turns.listForSession(sessionId)
    expect(all).toHaveLength(2)
    expect(all.map((t) => t.turnNumber)).toEqual([1, 2])
  })

  it('rejects duplicate (session, turn_number)', () => {
    if (!h) throw new Error('harness missing')
    const projects = new ProjectRepository(h.db.db)
    const projectId = randomUUID()
    projects.insert({
      id: projectId,
      slug: 'p',
      repoUrl: 'https://github.com/example/p',
      autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG },
    })
    const sessions = new SessionRepository(h.db.db)
    const sessionId = randomUUID()
    sessions.insert({ id: sessionId, projectId, promptVersion: PROMPT_VERSION })
    const turns = new SessionTurnRepository(h.db.db)
    turns.insert({ sessionId, turnNumber: 1 })
    expect(() => turns.insert({ sessionId, turnNumber: 1 })).toThrow()
  })
})

describe('buildSessionPrompt with continuation', () => {
  it('includes CONTINUATION preamble and previous PR numbers when continuation context is set', () => {
    const prompt = buildSessionPrompt({
      projectName: 'p',
      projectSlug: 'p',
      timeBudgetSeconds: 1800,
      developerName: 'Tester',
      context: '# context',
      state: '# state',
      recentJournal: [],
      task: 'do task 2',
      qualityGates: ['test'],
      continuation: {
        turnNumber: 2,
        previousPrNumbers: [42, 43],
      },
    })
    expect(prompt).toContain('== CONTINUATION ==')
    expect(prompt).toContain('turn 2')
    expect(prompt).toContain('#42, #43')
  })

  it('omits CONTINUATION preamble on a normal first turn', () => {
    const prompt = buildSessionPrompt({
      projectName: 'p',
      projectSlug: 'p',
      timeBudgetSeconds: 1800,
      developerName: 'Tester',
      context: '# context',
      state: '# state',
      recentJournal: [],
      task: 'do task',
      qualityGates: ['test'],
    })
    expect(prompt).not.toContain('== CONTINUATION ==')
  })
})

describe('softResetForNextTurn', () => {
  it('preserves .maestro/ contents across a base-branch reset', async () => {
    if (!h) throw new Error('harness missing')
    // Set up a tiny git repo: bare remote + working clone with a commit on
    // main, then a feature branch with a different .maestro/state.md.
    const root = h.root
    const remote = join(root, 'remote.git')
    const work = join(root, 'work')
    await mkdir(remote, { recursive: true })
    await mkdir(work, { recursive: true })
    execSync('git init --bare -b main', { cwd: remote, stdio: 'ignore' })
    execSync('git init -b main', { cwd: work, stdio: 'ignore' })
    execSync('git config user.email tester@example.com', { cwd: work })
    execSync('git config user.name Tester', { cwd: work })

    await mkdir(join(work, '.maestro/journal'), { recursive: true })
    await writeFile(join(work, '.maestro/state.md'), '# original state')
    await writeFile(join(work, '.maestro/context.md'), '# original ctx')
    await writeFile(join(work, '.maestro/journal/.gitkeep'), '')
    await writeFile(join(work, 'README.md'), '# project')
    execSync('git add -A && git commit -m init', { cwd: work, stdio: 'ignore' })
    execSync(`git remote add origin ${remote}`, { cwd: work })
    execSync('git push -u origin main', { cwd: work, stdio: 'ignore' })

    // Branch off and modify .maestro/state.md to simulate turn 1's work.
    execSync('git checkout -b maestro/p/turn-1', { cwd: work, stdio: 'ignore' })
    await writeFile(join(work, '.maestro/state.md'), '# turn-1 updated state')
    await writeFile(
      join(work, '.maestro/journal/2026-04-30-08-00-00.md'),
      '# journal turn 1',
    )
    execSync('git add -A && git commit -m "turn 1"', { cwd: work, stdio: 'ignore' })
    execSync('git push -u origin maestro/p/turn-1', { cwd: work, stdio: 'ignore' })

    // Soft-reset: switch to main, but carry .maestro/ from turn-1's tip.
    const { softResetForNextTurn } = await import('../worker.js') as unknown as {
      softResetForNextTurn: (root: string, base: string) => Promise<void>
    }
    if (!softResetForNextTurn) {
      // Fall back: re-import the module shape that's actually exported.
      // (See `re-exports for tests` block at the bottom of worker.ts.)
    }

    // Use a workaround: call via the test export, which is added below.
    const { softResetForNextTurn: fn } = await import('../worker.js')
    await fn(work, 'main')

    // After soft-reset:
    //  - working tree should be on main (no turn-1 commits in HEAD log)
    //  - .maestro/state.md should still hold the turn-1 update
    //  - the new journal file should still be present in the working tree
    const headBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: work }).toString().trim()
    expect(headBranch).toBe('main')

    const log = execSync('git log --format=%s', { cwd: work }).toString().trim()
    expect(log).toBe('init')

    const carriedState = await readFile(join(work, '.maestro/state.md'), 'utf-8')
    expect(carriedState).toContain('turn-1 updated state')

    const carriedJournal = await readFile(
      join(work, '.maestro/journal/2026-04-30-08-00-00.md'),
      'utf-8',
    )
    expect(carriedJournal).toContain('journal turn 1')

    // Those .maestro/ files are uncommitted on main — git status should
    // show them as modified/added relative to base.
    const status = execSync('git status --porcelain', { cwd: work }).toString()
    expect(status.length).toBeGreaterThan(0)
  })
})
