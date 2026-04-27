#!/usr/bin/env node
// Bin shim for the `maestro` CLI. Resolves tsx from the local node_modules and
// hands off to scripts/cli.ts so users get a full TypeScript experience without
// a build step. When the package is published, this can be replaced with the
// compiled ./dist/cli.js entry.

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const cliPath = resolve(root, 'scripts', 'cli.ts')

const candidates = [
  resolve(root, 'node_modules', '.bin', 'tsx'),
  resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
]
const tsxBin = candidates.find((p) => existsSync(p))

if (!tsxBin) {
  console.error('maestro: tsx binary not found. Run `pnpm install` first.')
  process.exit(1)
}

const child = spawn(process.execPath, [tsxBin, cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
