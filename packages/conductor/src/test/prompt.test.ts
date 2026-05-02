// Golden-file test for buildSessionPrompt. The prompt template is the
// most sensitive piece of code in the system — silent drift here directly
// degrades agent behaviour. This test pins the exact bytes produced for a
// representative input.
//
// To regenerate the golden file after an intentional template change:
//   UPDATE_GOLDENS=1 pnpm --filter @maestro/conductor test prompt
// Then re-read the file and confirm the diff is what you expected.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { buildSessionPrompt } from '@maestro/shared'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, 'fixtures')

describe('buildSessionPrompt', () => {
  it('produces stable output for a representative project (golden file)', () => {
    const state = readFileSync(join(FIXTURES, 'golden-state.md'), 'utf-8')
    const context = readFileSync(join(FIXTURES, 'golden-context.md'), 'utf-8')
    const j1 = readFileSync(join(FIXTURES, 'golden-journal-1.md'), 'utf-8')
    const j2 = readFileSync(join(FIXTURES, 'golden-journal-2.md'), 'utf-8')

    const prompt = buildSessionPrompt({
      projectName: 'testproject',
      projectSlug: 'testproject',
      timeBudgetSeconds: 45 * 60,
      developerName: 'Aaryan Sinha',
      context,
      state,
      recentJournal: [
        { filename: '2026-04-25-08-00.md', body: j1 },
        { filename: '2026-04-26-08-00.md', body: j2 },
      ],
      task: 'Wire the conductor to broadcast session events over WS at /events',
      qualityGates: ['test', 'lint', 'typecheck'],
      projectSpecificNeverTouch: ['the WebSocket auth flow'],
    })

    const goldenPath = join(FIXTURES, 'golden-prompt.txt')

    if (process.env['UPDATE_GOLDENS']) {
      writeFileSync(goldenPath, prompt, 'utf-8')
    }

    const golden = readFileSync(goldenPath, 'utf-8')
    expect(prompt).toBe(golden)
  })

  it('includes the FIRST SESSION preamble when no journal entries exist', () => {
    const prompt = buildSessionPrompt({
      projectName: 'fresh',
      projectSlug: 'fresh',
      timeBudgetSeconds: 1800,
      developerName: 'Aaryan Sinha',
      context: 'context',
      state: 'state',
      recentJournal: [],
      task: 'orient',
      qualityGates: [],
      isFirstSession: true,
    })
    expect(prompt).toContain('FIRST SESSION')
  })

  it('includes the LONG PAUSE preamble after 14+ days', () => {
    const prompt = buildSessionPrompt({
      projectName: 'stale',
      projectSlug: 'stale',
      timeBudgetSeconds: 1800,
      developerName: 'Aaryan Sinha',
      context: 'context',
      state: 'state',
      recentJournal: [],
      task: 'catch up',
      qualityGates: [],
      daysSinceLastSession: 30,
    })
    expect(prompt).toContain('LONG PAUSE')
    expect(prompt).toContain('30 days')
  })
})
