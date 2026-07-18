// Quality gate runners. ADR-006: gates run after the agent commits, before
// PR creation. If any gate fails, the branch is preserved but no PR opens
// (the worker may then spawn a fixup turn before giving up).
//
// Each gate is invoked via execa with explicit array args — never a shell
// string. This is security-critical because project slugs and branch
// names eventually flow through these calls.

import { execa, type ExecaError } from 'execa'
import {
  DEFAULT_QUALITY_GATE_TIMEOUT_SECONDS,
  QUALITY_GATE_OUTPUT_TAIL_LINES,
  type QualityGate,
  type QualityGateCommand,
  type QualityGateStatus,
} from '@maestro/shared'
import { detectStack } from './stack-detector.js'
import { logger } from './logger.js'

export interface RunGatesInput {
  /** Absolute path to the project working checkout. */
  projectRoot: string
  /** Sequence of gates to run. Order is respected. */
  gates: QualityGate[]
  /** Per-gate timeout in seconds. Default 5 min. */
  timeoutSeconds?: number
}

export interface SingleGateResult {
  gate: QualityGate
  status: QualityGateStatus
  /** Last N lines of combined stdout/stderr. */
  output: string
  /** Full output (stdout+stderr) for the session log. */
  fullOutput: string
  durationMs: number
  /** Argv used; useful for journal entries and debugging. */
  command: QualityGateCommand | null
}

export interface RunGatesResult {
  results: SingleGateResult[]
  allPassed: boolean
}

export async function runQualityGates(input: RunGatesInput): Promise<RunGatesResult> {
  const stack = await detectStack(input.projectRoot)
  const timeoutMs = (input.timeoutSeconds ?? DEFAULT_QUALITY_GATE_TIMEOUT_SECONDS) * 1000

  const results: SingleGateResult[] = []
  let allPassed = true

  for (const gate of input.gates) {
    const command = stack.gates[gate]
    if (!command) {
      // ENG-05: a gate the project explicitly configured but that resolves to
      // no runnable command must NOT silently pass — that reports false
      // confidence (CLAUDE.md: "NEVER skip quality gates"). Fail it with a
      // clear reason so the branch is held back from a PR until the developer
      // adds the command or drops the gate from qualityGates.
      logger.warn(
        { gate, stack: stack.stack, projectRoot: input.projectRoot },
        'configured quality gate has no runnable command — failing (ENG-05)',
      )
      results.push({
        gate,
        status: 'failed',
        output:
          `Quality gate "${gate}" is configured but no command could be resolved ` +
          `for stack "${stack.stack}". Add a matching script (e.g. a "${gate}" ` +
          `entry in package.json scripts) or remove "${gate}" from qualityGates ` +
          `in autonomy.json.`,
        fullOutput: '',
        durationMs: 0,
        command: null,
      })
      allPassed = false
      continue
    }
    const result = await runOneGate({ gate, command, cwd: input.projectRoot, timeoutMs })
    results.push(result)
    if (result.status === 'failed') allPassed = false
  }

  return { results, allPassed }
}

interface RunOneGateInput {
  gate: QualityGate
  command: QualityGateCommand
  cwd: string
  timeoutMs: number
}

async function runOneGate(input: RunOneGateInput): Promise<SingleGateResult> {
  const start = Date.now()
  let stdout = ''
  let stderr = ''
  let status: QualityGateStatus = 'passed'

  try {
    const sub = execa(input.command.command, input.command.args, {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      reject: false,
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    sub.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    sub.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    const result = await sub
    if (result.failed) status = 'failed'
    if (result.timedOut) status = 'failed'
  } catch (err) {
    status = 'failed'
    const execErr = err as ExecaError
    if (execErr.stderr) stderr += String(execErr.stderr)
    if (execErr.stdout) stdout += String(execErr.stdout)
  }

  const durationMs = Date.now() - start
  const fullOutput = stdout + (stderr ? `\n[stderr]\n${stderr}` : '')
  return {
    gate: input.gate,
    status,
    output: tail(fullOutput, QUALITY_GATE_OUTPUT_TAIL_LINES),
    fullOutput,
    durationMs,
    command: input.command,
  }
}

function tail(s: string, lines: number): string {
  if (!s) return ''
  const arr = s.split('\n')
  if (arr.length <= lines) return s
  return arr.slice(-lines).join('\n')
}

/**
 * The agent's working directory must NOT see the conductor's developer
 * shell — that's the path most likely to leak the GITHUB_TOKEN, dotfiles,
 * or other secrets. We pass through a small safe whitelist plus PATH so
 * tools like `pnpm`, `tsc`, etc. are findable.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR']
  const out: NodeJS.ProcessEnv = {}
  for (const key of allow) {
    const value = process.env[key]
    if (value !== undefined) out[key] = value
  }
  if (process.env['CI']) out['CI'] = process.env['CI']
  return out
}
