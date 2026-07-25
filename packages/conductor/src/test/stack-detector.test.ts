// ENG-16: Bun projects using the text `bun.lock` (Bun 1.1+) must be detected
// as bun, not fall through to npm.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectStack } from '../stack-detector.js'

let root: string | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'maestro-stack-'))
})

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function pkg(scripts: Record<string, string>): Promise<void> {
  if (!root) throw new Error('no root')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts }))
}

describe('detectStack — Bun lockfiles (ENG-16)', () => {
  it('detects a text bun.lock as the bun package manager', async () => {
    if (!root) throw new Error('no root')
    await pkg({ test: 'bun test' })
    await writeFile(join(root, 'bun.lock'), '')
    const stack = await detectStack(root)
    expect(stack.stack).toBe('bun')
    expect(stack.gates.test).toEqual({ command: 'bun', args: ['run', 'test'] })
  })

  it('still detects the binary bun.lockb', async () => {
    if (!root) throw new Error('no root')
    await pkg({ test: 'bun test' })
    await writeFile(join(root, 'bun.lockb'), '')
    expect((await detectStack(root)).stack).toBe('bun')
  })

  it('falls back to npm without a recognised lockfile', async () => {
    if (!root) throw new Error('no root')
    await pkg({ test: 'jest' })
    expect((await detectStack(root)).stack).toBe('npm')
  })
})
