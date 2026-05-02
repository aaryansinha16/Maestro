// Generates a rich `.maestro/context.md` for a real codebase by spawning
// a one-shot `claude -p` invocation with a focused prompt. This is what
// makes Phase 1.5's `maestro init` useful on real projects — the Phase 1
// version's hand-written stub barely scratched the surface of a real repo.
//
// The scaffolder is opt-in (CLI flag) because:
//   - it spawns Claude Code, which costs tokens and OAuth credit
//   - on a 100k-LOC project it can take 30-60 seconds
// The fallback is the cheap manual scrape in scripts/cli/init.ts.

import { execa } from 'execa'
import { MaestroError } from '@maestro/shared'
import { logger } from './logger.js'

export interface ScaffoldContextInput {
  /** Absolute path to the project working tree. */
  projectRoot: string
  /** Override the binary. Used by tests. */
  claudeBin?: string
  /** Hard kill ceiling, seconds. Default 240 (4 min). */
  timeoutSeconds?: number
}

export interface ScaffoldContextResult {
  contextMd: string
  durationMs: number
  costCents: number | null
  modelUsed: string | null
}

const SCAFFOLDER_PROMPT = `You are generating a Maestro \`.maestro/context.md\` file for the codebase
in your current working directory. The file is read by autonomous coding
agents at the start of every session, so it must be accurate and durable.

Read enough of the codebase to write a 200-300 line context.md that
follows this structure:

# Project Context — <project name>

## Stack
- Languages, runtimes, framework versions (with concrete numbers from
  manifests, not vague claims)
- Test/lint/typecheck/build tools that are actually wired up
- Deployment target if obvious

## Architecture
- 5-10 sentence overview of how the system is laid out
- Key entry points (file paths)
- The most important modules / packages and what each does

## Conventions
- Code style observations (semicolons? quote style? imports?)
- Commit message format observed in git log
- Test file patterns
- File / folder naming patterns

## Notable dependencies
- Top dependencies with one-line "what we use this for"

## Top-level layout
- A tree of the top 1-2 levels with one-line annotations

## CI / quality gates
- If \`.github/workflows\` exists, summarise the matrix
- Note any gates that are present but non-functional (script in
  package.json with no config)

## Project-specific NEVER list
- Things the agent must not modify without explicit state.md instruction.
  Anything that touches money, auth, prod migrations, secrets handling,
  CI config. Be concrete (file paths or directory names).

## Gotchas / context the next agent will wish they knew
- Anything that surprised you while exploring

Output ONLY the markdown. No preamble, no closing remarks. The file is
written verbatim to \`.maestro/context.md\`.

Constraints:
- Do not modify any files. This is read-only orientation.
- Do not exceed 400 lines. Aim for 200-300.
- Be specific. "Uses TypeScript" is useless; "TypeScript 5.7 strict mode
  with noUncheckedIndexedAccess" is useful.
- If the project is multi-package (monorepo), describe both the root and
  each package.
`

export async function scaffoldContextMd(
  input: ScaffoldContextInput,
): Promise<ScaffoldContextResult> {
  const start = Date.now()
  const timeoutMs = (input.timeoutSeconds ?? 240) * 1000

  logger.info({ cwd: input.projectRoot }, 'scaffolding context.md via claude')

  const child = execa(input.claudeBin ?? 'claude', argsForScaffolder(input.projectRoot), {
    cwd: input.projectRoot,
    input: SCAFFOLDER_PROMPT,
    timeout: timeoutMs,
    reject: false,
    env: claudeScaffolderEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  child.stdout?.on('data', (c: Buffer | string) => stdoutChunks.push(c.toString()))
  child.stderr?.on('data', (c: Buffer | string) => stderrChunks.push(c.toString()))

  const result = await child
  const durationMs = Date.now() - start

  if (result.failed && !result.timedOut) {
    throw new MaestroError('SESSION_SPAWN_FAILED', {
      message: 'context scaffolder failed',
      context: {
        exitCode: result.exitCode,
        signal: result.signal,
        stderrTail: tail(stderrChunks.join(''), 30),
      },
    })
  }

  const captured = stdoutChunks.join('')
  const parsed = parseStreamJsonResult(captured)
  if (!parsed.text || parsed.text.trim().length < 100) {
    throw new MaestroError('SESSION_SPAWN_FAILED', {
      message: 'context scaffolder returned no usable output',
      context: {
        capturedBytes: captured.length,
        stderrTail: tail(stderrChunks.join(''), 30),
      },
    })
  }

  return {
    contextMd: ensureTrailingNewline(parsed.text),
    durationMs,
    costCents: parsed.costCents,
    modelUsed: parsed.model,
  }
}

function argsForScaffolder(cwd: string): string[] {
  return [
    '-p',
    '--permission-mode',
    'bypassPermissions',
    // Read-only is enforced by our prompt + bypassPermissions on a
    // sandboxed dir. We still allow Read/Glob/Grep/Bash so the agent
    // can use ripgrep, ls, cat — Edit/Write are deliberately omitted
    // so a misbehaving agent can't mutate the working tree.
    '--allowedTools',
    'Read Glob Grep Bash',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--add-dir',
    cwd,
  ]
}

function claudeScaffolderEnv(): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR']
  const out: NodeJS.ProcessEnv = {}
  for (const key of allow) {
    const v = process.env[key]
    if (v !== undefined) out[key] = v
  }
  return out
}

interface ParsedScaffolder {
  text: string | null
  model: string | null
  costCents: number | null
}

/**
 * Walk the captured stream-json output for the final `result` event,
 * which carries the full text response and usage metadata.
 */
function parseStreamJsonResult(captured: string): ParsedScaffolder {
  if (!captured) return { text: null, model: null, costCents: null }
  const lines = captured.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line || !line.startsWith('{')) continue
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj['type'] === 'result' || obj['type'] === 'session_result') {
        const text =
          typeof obj['result'] === 'string'
            ? (obj['result'] as string)
            : typeof obj['text'] === 'string'
              ? (obj['text'] as string)
              : null
        const model = typeof obj['model'] === 'string' ? (obj['model'] as string) : null
        const usage = obj['usage'] as Record<string, unknown> | undefined
        const input = numOrNull(usage?.['input_tokens'])
        const output = numOrNull(usage?.['output_tokens'])
        const costCents =
          input !== null && output !== null
            ? Math.round(((input ?? 0) * 0.0003 + (output ?? 0) * 0.0015) / 10)
            : null
        return { text, model, costCents }
      }
    } catch {
      /* ignore partial frames */
    }
  }
  return { text: null, model: null, costCents: null }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function tail(s: string, lines: number): string {
  const arr = s.split('\n')
  return arr.length <= lines ? s : arr.slice(-lines).join('\n')
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n'
}
