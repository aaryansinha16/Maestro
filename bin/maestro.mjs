#!/usr/bin/env node
// Bin shim for the `maestro` CLI. Loads scripts/cli.ts in this same Node
// process via tsx's ESM API — no child process, no shell script invocation.
// When the package is published, this can be replaced with the compiled
// ./dist/cli.js entry.

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const cliPath = resolve(root, 'scripts', 'cli.ts')

if (!existsSync(cliPath)) {
  console.error(`maestro: scripts/cli.ts not found at ${cliPath}`)
  process.exit(1)
}

let tsImport
try {
  ;({ tsImport } = await import('tsx/esm/api'))
} catch (err) {
  console.error('maestro: tsx is not installed. Run `pnpm install` first.')
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}

try {
  await tsImport(pathToFileURL(cliPath).href, import.meta.url)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
