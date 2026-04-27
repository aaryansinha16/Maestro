// MaestroError — structured error with code + context, per AGENTS.md error
// handling pattern.
//
//   throw new MaestroError('SESSION_SPAWN_FAILED', {
//     cause: err,
//     context: { project: project.slug, timeBudget, attempt },
//   })

export type MaestroErrorCode =
  | 'SESSION_SPAWN_FAILED'
  | 'SESSION_TIMEOUT'
  | 'SESSION_KILLED'
  | 'STATE_PARSE_FAILED'
  | 'STATE_WRITE_FAILED'
  | 'CONTEXT_FILE_MISSING'
  | 'AUTONOMY_CONFIG_INVALID'
  | 'QUALITY_GATE_FAILED'
  | 'GIT_OPERATION_FAILED'
  | 'GITHUB_API_FAILED'
  | 'TELEGRAM_API_FAILED'
  | 'DB_MIGRATION_FAILED'
  | 'CONFIG_VALIDATION_FAILED'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_LOCKED'
  | 'INTERNAL_ERROR'

export interface MaestroErrorOptions {
  cause?: unknown
  context?: Record<string, unknown>
  message?: string
}

export class MaestroError extends Error {
  readonly code: MaestroErrorCode
  readonly context: Record<string, unknown>
  override readonly cause: unknown

  constructor(code: MaestroErrorCode, options: MaestroErrorOptions = {}) {
    const message = options.message ?? defaultMessageFor(code)
    super(message)
    this.name = 'MaestroError'
    this.code = code
    this.context = options.context ?? {}
    this.cause = options.cause
    // Restore prototype chain when targeting older runtimes that don't preserve
    // it through Error subclassing.
    Object.setPrototypeOf(this, new.target.prototype)
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      cause: serializeCause(this.cause),
      stack: this.stack,
    }
  }
}

function defaultMessageFor(code: MaestroErrorCode): string {
  switch (code) {
    case 'SESSION_SPAWN_FAILED':
      return 'Failed to spawn Claude Code session'
    case 'SESSION_TIMEOUT':
      return 'Session exceeded its time budget'
    case 'SESSION_KILLED':
      return 'Session was killed before completion'
    case 'STATE_PARSE_FAILED':
      return 'Failed to parse .maestro/state.md'
    case 'STATE_WRITE_FAILED':
      return 'Failed to write .maestro/ state file'
    case 'CONTEXT_FILE_MISSING':
      return '.maestro/context.md is missing'
    case 'AUTONOMY_CONFIG_INVALID':
      return '.maestro/autonomy.json failed validation'
    case 'QUALITY_GATE_FAILED':
      return 'One or more quality gates failed'
    case 'GIT_OPERATION_FAILED':
      return 'Git operation failed'
    case 'GITHUB_API_FAILED':
      return 'GitHub API request failed'
    case 'TELEGRAM_API_FAILED':
      return 'Telegram API request failed'
    case 'DB_MIGRATION_FAILED':
      return 'Database migration failed'
    case 'CONFIG_VALIDATION_FAILED':
      return 'Configuration failed validation'
    case 'PROJECT_NOT_FOUND':
      return 'Project not found'
    case 'PROJECT_LOCKED':
      return 'Project is locked by another running session'
    case 'INTERNAL_ERROR':
      return 'Internal error'
  }
}

function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack }
  }
  return cause
}

export function isMaestroError(err: unknown): err is MaestroError {
  return err instanceof MaestroError
}
