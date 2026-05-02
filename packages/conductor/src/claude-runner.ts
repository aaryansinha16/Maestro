// Spawns the `claude` CLI in non-interactive mode for a single autonomous
// session, enforces the time budget, and streams output to a session log
// file.
//
// Time-budget choreography (ADR-007):
//   T = 0                : spawn `claude -p ...`
//   T = budget − 5 min   : send SIGTERM with a graceful note (the prompt
//                          tells the agent to wrap up at this point)
//   T = budget           : SIGTERM again — we expect Claude Code to honour
//                          the wrap-up and exit
//   T = budget + 30 s    : SIGKILL — the nuclear backstop
//
// Output handling: we use --output-format stream-json + --include-partial-
// messages to get one JSON object per line. The very last object is a
// `result` event with usage and the final text; we extract token counts
// for cost tracking and surface the model used. The full raw stream goes
// to the session log file unchanged.
//
// Auth: we deliberately DO NOT pass --bare. Bare mode bypasses the
// keychain and forces ANTHROPIC_API_KEY, which contradicts ADR-001 (the
// conductor uses the developer's Pro/Max OAuth credentials).

import { execa, type ResultPromise } from 'execa'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  KILL_GRACE_SECONDS,
  WRAP_UP_GRACE_SECONDS,
  MaestroError,
  type TerminationCause,
} from '@maestro/shared'
import { logger } from './logger.js'

// ─── Public API ──────────────────────────────────────────────────────

export interface ClaudeRunInput {
  /** Working directory for the agent. Sandbox boundary. */
  cwd: string
  /** The constructed system+user prompt, fully baked. */
  prompt: string
  /** Hard kill ceiling in seconds. */
  timeBudgetSeconds: number
  /** Absolute path to the session log file (will be created). */
  logPath: string
  /** Allowed-tools list passed to claude --allowedTools. */
  allowedTools?: string[]
  /** Backstop dollar cap on the API spend, passed via --max-budget-usd. */
  maxBudgetUsd?: number
  /**
   * Override the binary. Used by tests to point at a mock script, never in
   * production.
   */
  claudeBin?: string
  /** Whitelisted env vars to forward to the agent. PATH/HOME are auto. */
  extraEnv?: NodeJS.ProcessEnv
}

export interface ClaudeRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  terminationCause: TerminationCause
  durationMs: number
  /** Best-effort: parsed from the final `result` line of stream-json. */
  modelUsed: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  /** Estimated cost in cents from the parsed token counts. */
  costCents: number | null
}

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']

export async function runClaudeSession(input: ClaudeRunInput): Promise<ClaudeRunResult> {
  await mkdir(dirname(input.logPath), { recursive: true })
  const logStream = createWriteStream(input.logPath, { flags: 'w' })

  const args = buildArgs(input)
  const start = Date.now()

  logger.info(
    {
      cwd: input.cwd,
      timeBudget: input.timeBudgetSeconds,
      logPath: input.logPath,
      argv: redactArgs(args),
    },
    'spawning claude session',
  )

  const child = execa(input.claudeBin ?? 'claude', args, {
    cwd: input.cwd,
    env: claudeEnv(input.extraEnv),
    input: input.prompt,
    reject: false,
    // We pipe stdin ourselves above. stdout/stderr go to the log file.
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const captured: string[] = []
  pipeWithCapture(child.stdout, logStream, captured, 'stdout')
  pipeWithCapture(child.stderr, logStream, captured, 'stderr')

  const timers = scheduleBudgetSignals(child, input.timeBudgetSeconds)
  let terminationCause: TerminationCause | null = null

  const result = await child.catch((err: unknown) => err as Error)
  for (const t of timers.list) clearTimeout(t)

  if (timers.cause) terminationCause = timers.cause
  await flushAndClose(logStream)

  const durationMs = Date.now() - start
  const exitInfo = extractExit(result)

  if (!terminationCause) {
    if (exitInfo.exitCode === 0) terminationCause = 'exit-clean'
    else if (exitInfo.signal) terminationCause = 'killed-by-signal'
    else terminationCause = 'failed'
  }

  const meta = parseFinalResultLine(captured.join(''))

  return {
    exitCode: exitInfo.exitCode,
    signal: exitInfo.signal,
    terminationCause,
    durationMs,
    modelUsed: meta.model,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    cacheReadTokens: meta.cacheReadTokens,
    cacheWriteTokens: meta.cacheWriteTokens,
    costCents: meta.costCents,
  }
}

// ─── Internals ───────────────────────────────────────────────────────

function buildArgs(input: ClaudeRunInput): string[] {
  const tools = (input.allowedTools ?? DEFAULT_ALLOWED_TOOLS).join(' ')
  const args = [
    '-p',
    '--permission-mode',
    'bypassPermissions',
    '--allowedTools',
    tools,
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose', // stream-json requires --verbose
    '--add-dir',
    input.cwd,
  ]
  if (input.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(input.maxBudgetUsd))
  }
  // The prompt comes from stdin; passing as an arg risks exceeding ARG_MAX
  // for long context. Claude Code reads stdin when no positional prompt is
  // provided alongside `-p`. We confirm via tests in mock-claude.
  return args
}

function pipeWithCapture(
  source: NodeJS.ReadableStream | null | undefined,
  sink: WriteStream,
  buffer: string[],
  channel: 'stdout' | 'stderr',
): void {
  if (!source) return
  source.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString()
    buffer.push(text)
    sink.write(channel === 'stderr' ? `[stderr] ${text}` : text)
  })
}

interface BudgetTimers {
  list: NodeJS.Timeout[]
  cause: TerminationCause | null
}

function scheduleBudgetSignals(
  child: ResultPromise<{ reject: false }>,
  budgetSeconds: number,
): BudgetTimers {
  const state: BudgetTimers = { list: [], cause: null }
  const sigtermAtBudget = budgetSeconds * 1000
  const sigkillAt = sigtermAtBudget + KILL_GRACE_SECONDS * 1000

  // Only schedule the graceful wrap-up signal when there's enough headroom
  // for it to be useful. For very short budgets (tests, fast iteration)
  // we skip directly to the at-budget SIGTERM so we don't kill the agent
  // before it's even started.
  if (budgetSeconds > WRAP_UP_GRACE_SECONDS + 30) {
    const wrapUpAt = (budgetSeconds - WRAP_UP_GRACE_SECONDS) * 1000
    state.list.push(
      setTimeout(() => {
        logger.warn(
          { budgetSeconds, deadlineSeconds: WRAP_UP_GRACE_SECONDS },
          'budget − 5min: SIGTERM (graceful wrap-up)',
        )
        try {
          child.kill('SIGTERM')
          if (!state.cause) state.cause = 'graceful'
        } catch {
          /* already exited */
        }
      }, wrapUpAt),
    )
  }

  state.list.push(
    setTimeout(() => {
      logger.warn({ budgetSeconds }, 'budget reached: SIGTERM')
      try {
        child.kill('SIGTERM')
        state.cause = 'sigterm-timeout'
      } catch {
        /* already exited */
      }
    }, sigtermAtBudget),
  )

  state.list.push(
    setTimeout(() => {
      logger.error({ budgetSeconds }, 'budget + 30s: SIGKILL')
      try {
        child.kill('SIGKILL')
        state.cause = 'sigkill-timeout'
      } catch {
        /* already exited */
      }
    }, sigkillAt),
  )

  return state
}

interface ExitInfo {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

function extractExit(result: unknown): ExitInfo {
  if (result && typeof result === 'object') {
    const r = result as { exitCode?: number; signal?: NodeJS.Signals }
    return {
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
      signal: r.signal ?? null,
    }
  }
  return { exitCode: null, signal: null }
}

interface ParsedResultMeta {
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  costCents: number | null
}

/**
 * Walk the captured stream-json output backward to find the final
 * `result` event. Robust to partial-message lines being interleaved.
 */
function parseFinalResultLine(captured: string): ParsedResultMeta {
  const empty: ParsedResultMeta = {
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costCents: null,
  }
  if (!captured) return empty
  const lines = captured.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line || !line.startsWith('{')) continue
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj['type'] === 'result' || obj['type'] === 'session_result') {
        return readUsage(obj)
      }
    } catch {
      // Not a complete JSON object (likely a partial-message frame). Skip.
    }
  }
  return empty
}

function readUsage(obj: Record<string, unknown>): ParsedResultMeta {
  const usage = (obj['usage'] ?? null) as Record<string, unknown> | null
  const model = typeof obj['model'] === 'string' ? (obj['model'] as string) : null
  const input = numOrNull(usage?.['input_tokens'])
  const output = numOrNull(usage?.['output_tokens'])
  const cacheRead = numOrNull(usage?.['cache_read_input_tokens'])
  const cacheWrite = numOrNull(usage?.['cache_creation_input_tokens'])

  // Per the rate card surfaced by `claude --help` / docs:
  //   $3   per 1M input
  //   $15  per 1M output
  //   $3.75 per 1M cache write
  //   $0.30 per 1M cache read
  // Compute as cents (integer).
  const costCents =
    input !== null && output !== null
      ? Math.round(
          ((input ?? 0) * 0.0003 +
            (output ?? 0) * 0.0015 +
            (cacheRead ?? 0) * 0.00003 +
            (cacheWrite ?? 0) * 0.000375) /
            10,
        )
      : null

  return {
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    costCents,
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function redactArgs(args: string[]): string[] {
  return args.map((a) => (a.length > 200 ? `${a.slice(0, 100)}…` : a))
}

function flushAndClose(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(resolve)
  })
}

/** Whitelisted env for the agent. Mirrors quality-gates.cleanEnv. */
function claudeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR']
  const out: NodeJS.ProcessEnv = {}
  for (const key of allow) {
    const value = process.env[key]
    if (value !== undefined) out[key] = value
  }
  if (process.env['CI']) out['CI'] = process.env['CI']
  // ANTHROPIC_API_KEY only forwarded if explicitly opted-in via extraEnv.
  Object.assign(out, extra ?? {})
  return out
}

/** Throws if the `claude` binary cannot be located. */
export async function ensureClaudeAvailable(claudeBin = 'claude'): Promise<void> {
  try {
    const r = await execa(claudeBin, ['--version'], { reject: false, timeout: 5000 })
    if (r.exitCode !== 0) {
      throw new Error(`claude --version exit ${r.exitCode}`)
    }
  } catch (err) {
    throw new MaestroError('SESSION_SPAWN_FAILED', {
      message:
        'Claude Code CLI not found or not authenticated. Install it and run `claude /login` once.',
      cause: err,
      context: { claudeBin },
    })
  }
}
