#!/usr/bin/env node
// Copy SQL migrations into dist/ so that the compiled server can find them at
// runtime. tsc doesn't move non-.ts files; this is a one-line build step.

import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..', 'src', 'db', 'migrations')
const dest = resolve(here, '..', 'dist', 'db', 'migrations')

await mkdir(dest, { recursive: true })
await cp(src, dest, { recursive: true })
console.log(`Copied migrations: ${src} → ${dest}`)
