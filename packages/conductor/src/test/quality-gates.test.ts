// Quality-gate tests. Focused on ENG-05: a gate that the project explicitly
// configured but which resolves to no runnable command must FAIL (block the
// PR), not silently pass as it did before.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runQualityGates } from '../quality-gates.js'

let root: string | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'maestro-qg-'))
})

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

describe('runQualityGates — ENG-05: configured gate with no command', () => {
  it('fails (does not silently skip) when a configured gate cannot be resolved', async () => {
    if (!root) throw new Error('no root')
    // A Node project with no scripts and no tsconfig.json — so neither the
    // lint nor the typecheck gate can resolve to a command.
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: {} }),
    )

    const res = await runQualityGates({ projectRoot: root, gates: ['lint', 'typecheck'] })

    expect(res.allPassed).toBe(false)
    const lint = res.results.find((r) => r.gate === 'lint')
    expect(lint?.status).toBe('failed')
    expect(lint?.command).toBeNull()
    expect(lint?.output).toMatch(/no command could be resolved/i)
  })
})
