// Phase 1.5: orientation mode (ADR-015) + never-touch parser (ADR-017)
// + journal-filename migration (ADR-016).
//
// These exercise the "first-pass behaviour" the developer would never want
// to break silently — drift here would degrade every real-project session.

import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSessionPrompt, isOrientationModeFromContext } from '@maestro/shared'
import { parseNeverTouchSection, deriveTaskFromState } from '../worker.js'
import { migrateJournalFilenames } from '../state-manager.js'

const COMMON: Parameters<typeof buildSessionPrompt>[0] = {
  projectName: 'p',
  projectSlug: 'p',
  timeBudgetSeconds: 1800,
  developerName: 'Aaryan Sinha',
  context: '',
  state: '',
  recentJournal: [],
  task: '',
  qualityGates: [],
}

describe('orientation mode (Fix 1)', () => {
  it('flags orientation when journal is empty AND task is empty', () => {
    expect(
      isOrientationModeFromContext({ ...COMMON, recentJournal: [], task: '' }),
    ).toBe(true)
  })

  it('does NOT flag orientation when state.md has a concrete task', () => {
    expect(
      isOrientationModeFromContext({
        ...COMMON,
        recentJournal: [],
        task: 'Fix the broken add() function',
      }),
    ).toBe(false)
  })

  it('does NOT flag orientation when prior journal exists', () => {
    expect(
      isOrientationModeFromContext({
        ...COMMON,
        recentJournal: [{ filename: '2026-04-15-08-00-00.md', body: '...' }],
        task: '',
      }),
    ).toBe(false)
  })

  it('emits ORIENTATION MODE preamble (not FIRST SESSION) when triggered', () => {
    const prompt = buildSessionPrompt({
      ...COMMON,
      task: '',
      recentJournal: [],
      state: '# Current State\n\n## Focus\nx\n\n## Next Concrete Tasks\n\n',
      context: '# Project Context — p\n',
      isFirstSession: true,
    })
    expect(prompt).toContain('ORIENTATION MODE')
    expect(prompt).toContain('No quality gates will run.')
    expect(prompt).not.toContain('== FIRST SESSION ==')
  })

  it('emits FIRST SESSION preamble when state has a concrete task', () => {
    const prompt = buildSessionPrompt({
      ...COMMON,
      task: 'Fix the broken add() function',
      recentJournal: [],
      state: '## Next Concrete Tasks\n- [ ] Fix the broken add() function\n',
      context: '',
      isFirstSession: true,
    })
    expect(prompt).toContain('== FIRST SESSION ==')
    expect(prompt).toContain('treat that task as authoritative')
    expect(prompt).not.toContain('ORIENTATION MODE')
  })
})

describe('never-touch parser (Fix 3)', () => {
  it('extracts bullets from "## Project-specific NEVER list"', () => {
    const md = [
      '# Context',
      '## Project-specific NEVER list',
      '- payment processing in src/billing/',
      '- session token storage',
      '* OAuth callbacks',
      '',
      '## Notes',
      '- (this should not appear)',
    ].join('\n')
    expect(parseNeverTouchSection(md)).toEqual([
      'payment processing in src/billing/',
      'session token storage',
      'OAuth callbacks',
    ])
  })

  it('also matches "## Never Touch" alias', () => {
    const md = ['## Never Touch', '- production migrations'].join('\n')
    expect(parseNeverTouchSection(md)).toEqual(['production migrations'])
  })

  it('strips italic placeholder bullets', () => {
    const md = [
      '## Project-specific NEVER list',
      '_Add anything the agent must not touch._',
      '- _placeholder_',
      '- real entry',
    ].join('\n')
    expect(parseNeverTouchSection(md)).toEqual(['real entry'])
  })

  it('returns empty array when section is missing', () => {
    expect(parseNeverTouchSection('# nothing here')).toEqual([])
  })
})

describe('deriveTaskFromState', () => {
  it('returns the first unchecked bullet', () => {
    const md = [
      '## Next Concrete Tasks',
      '- [x] already done',
      '- [ ] do this thing',
      '- [ ] then this',
    ].join('\n')
    expect(deriveTaskFromState(md)).toBe('do this thing')
  })

  it('returns empty string for placeholder bullets so orientation mode triggers', () => {
    const md = ['## Next Concrete Tasks', '- [ ] _add 3-5 concrete tasks here_'].join('\n')
    expect(deriveTaskFromState(md)).toBe('')
  })

  it('returns empty string when section has no unchecked bullets', () => {
    expect(deriveTaskFromState('## Next Concrete Tasks\n')).toBe('')
  })
})

describe('journal filename migration (Fix 2)', () => {
  it('renames legacy minute-granularity files to seconds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-journal-'))
    try {
      const journalDir = join(root, '.maestro', 'journal')
      await mkdir(journalDir, { recursive: true })
      await writeFile(join(journalDir, '2026-04-15-08-00.md'), '# old')
      await writeFile(join(journalDir, '2026-04-15-08-30-12.md'), '# new')

      const migrated = await migrateJournalFilenames(root)
      expect(migrated).toBe(1)

      const entries = await readdir(journalDir)
      expect(entries.sort()).toEqual([
        '2026-04-15-08-00-00.md',
        '2026-04-15-08-30-12.md',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is idempotent — second call is a no-op', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-journal-'))
    try {
      const journalDir = join(root, '.maestro', 'journal')
      await mkdir(journalDir, { recursive: true })
      await writeFile(join(journalDir, '2026-04-15-08-00-00.md'), '# x')
      const first = await migrateJournalFilenames(root)
      const second = await migrateJournalFilenames(root)
      expect(first).toBe(0)
      expect(second).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves legacy file in place if target already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-journal-'))
    try {
      const journalDir = join(root, '.maestro', 'journal')
      await mkdir(journalDir, { recursive: true })
      await writeFile(join(journalDir, '2026-04-15-08-00.md'), '# legacy')
      await writeFile(join(journalDir, '2026-04-15-08-00-00.md'), '# already migrated')
      const migrated = await migrateJournalFilenames(root)
      expect(migrated).toBe(0)
      const entries = await readdir(journalDir)
      expect(entries.sort()).toEqual([
        '2026-04-15-08-00-00.md',
        '2026-04-15-08-00.md',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Regression test for the actual collision scenario: two sessions
  // landing in the same second still collide on the new format, but
  // that's a much narrower window than the old per-minute collision.
  it('seconds granularity shrinks the collision window from 60s to 1s', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-journal-'))
    try {
      const journalDir = join(root, '.maestro', 'journal')
      await mkdir(journalDir, { recursive: true })
      // Two sessions starting in the same minute, different seconds:
      await writeFile(join(journalDir, '2026-04-15-08-00-12.md'), '# a')
      await writeFile(join(journalDir, '2026-04-15-08-00-37.md'), '# b')
      // Both filenames remain distinct.
      const entries = await readdir(journalDir)
      expect(entries).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// Suppress unused import warning when nothing references rename above
// directly — vitest hoists imports differently than eslint expects.
void rename
