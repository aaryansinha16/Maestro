#!/usr/bin/env node
// Mock `claude` binary for tests. The real Claude Code CLI is heavy and
// non-deterministic; here we simulate exactly the side effects a session
// would have:
//   - apply a fixture diff in cwd
//   - update .maestro/state.md
//   - append a journal entry
//   - make a git commit on a feature branch
//   - emit a stream-json `result` line so the runner can parse usage
//
// Driven by env:
//   MAESTRO_MOCK_FIXTURE  → path to JSON file describing actions
//   MAESTRO_MOCK_INLINE   → JSON string (overrides _FIXTURE)
//
// Fixture shape:
//   {
//     "exitCode": 0,
//     "delayMs": 0,
//     "files": { "path/in/cwd.txt": "contents" },
//     "branch": "maestro/<slug>/<short>",
//     "commitMessage": "subject\n\nbody",
//     "stateBody": "new state.md body",
//     "journalFilename": "2026-04-15-08-00.md",
//     "journalBody": "...",
//     "result": { "model": "...", "usage": { "input_tokens": ..., ... } },
//     "stdoutPrelude": "...",
//     "stderrPrelude": "..."
//   }

import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function loadFixture() {
  if (process.env.MAESTRO_MOCK_INLINE) {
    return JSON.parse(process.env.MAESTRO_MOCK_INLINE)
  }
  if (process.env.MAESTRO_MOCK_FIXTURE) {
    return JSON.parse(readFileSync(process.env.MAESTRO_MOCK_FIXTURE, 'utf-8'))
  }
  return {}
}

function git(cwd, ...args) {
  return execSync(`git ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim()
}

function writeFile(cwd, relPath, content) {
  const full = join(cwd, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

async function main() {
  const fixture = loadFixture()
  const cwd = process.cwd()

  if (fixture.stdoutPrelude) process.stdout.write(fixture.stdoutPrelude)
  if (fixture.stderrPrelude) process.stderr.write(fixture.stderrPrelude)

  if (fixture.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, fixture.delayMs))
  }

  // 1. apply file changes
  if (fixture.files) {
    for (const [path, content] of Object.entries(fixture.files)) {
      writeFile(cwd, path, content)
    }
  }

  // 2. update state.md
  if (typeof fixture.stateBody === 'string') {
    writeFile(cwd, '.maestro/state.md', fixture.stateBody)
  }

  // 3. append journal entry
  if (fixture.journalFilename && typeof fixture.journalBody === 'string') {
    writeFile(cwd, `.maestro/journal/${fixture.journalFilename}`, fixture.journalBody)
  }

  // 4. branch + commit
  if (fixture.branch || fixture.commitMessage) {
    const branchName = fixture.branch ?? `mock-claude/${Date.now()}`
    try {
      git(cwd, 'checkout', '-b', branchName)
    } catch {
      // branch may already exist if the test reuses a working dir; switch
      git(cwd, 'checkout', branchName)
    }
    git(cwd, 'add', '-A')
    const status = git(cwd, 'status', '--porcelain')
    if (status.length > 0) {
      const message = fixture.commitMessage ?? 'mock-claude commit'
      git(cwd, 'commit', '-m', message)
    }
  }

  // 5. stream-json result line
  const resultLine = {
    type: 'result',
    session_id: 'mock-session',
    model: fixture.result?.model ?? 'claude-opus-4-7-20250219',
    usage: fixture.result?.usage ?? {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }
  process.stdout.write(JSON.stringify(resultLine) + '\n')

  // Read and discard stdin so the runner's input pipe doesn't block.
  // Don't actually require it — `process.stdin` may be already closed.
  if (process.stdin.readable) {
    try {
      let _bytes = 0
      for await (const chunk of process.stdin) _bytes += chunk.length
      void _bytes
    } catch {
      /* ignore */
    }
  }

  process.exit(fixture.exitCode ?? 0)
}

main().catch((err) => {
  process.stderr.write(`mock-claude: ${err}\n`)
  process.exit(1)
})

// macOS may emit a deprecation about closing stdin if we exit fast.
process.on('SIGTERM', () => process.exit(0))
