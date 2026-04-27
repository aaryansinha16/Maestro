// System-wide constants. Anything that's a tunable default for sessions, the
// scheduler, or quality gates lives here so it has one canonical home.

import type { ProjectAutonomyConfig, QualityGate } from './types.js'

// ─── Prompt versioning ───────────────────────────────────────────────

// The prompt template version. Bump on every meaningful change to
// SESSION_PROMPT_TEMPLATE_V1 in prompt-templates.ts. See PROMPT_DESIGN.md.
export const PROMPT_VERSION = '1.0.0'

// ─── Time budgets (seconds) ──────────────────────────────────────────

// Default hard kill ceiling for a session. ADR-007. 45 min.
export const DEFAULT_TIME_BUDGET_SECONDS = 45 * 60

// Wrap-up grace period — the agent is told to start finishing this many
// seconds before the hard kill. Surfaces inside the prompt template.
export const WRAP_UP_GRACE_SECONDS = 5 * 60

// SIGTERM-to-SIGKILL window when killing a runaway process. ADR-007.
export const KILL_GRACE_SECONDS = 30

// Quality-gate-failed recovery turn budget. PROMPT_DESIGN.md "Special Cases".
export const FIXUP_TURN_BUDGET_SECONDS = 15 * 60

// ─── Defaults for new project autonomy config ────────────────────────

export const DEFAULT_QUALITY_GATES: QualityGate[] = ['test', 'lint', 'typecheck']

export const DEFAULT_AUTONOMY_CONFIG: ProjectAutonomyConfig = {
  level: 'pr-only',
  schedule: '0 */6 * * *',
  timeBudget: DEFAULT_TIME_BUDGET_SECONDS,
  qualityGates: DEFAULT_QUALITY_GATES,
  branches: {
    base: 'main',
    prefix: 'maestro/',
  },
  github: {
    prLabels: ['maestro'],
    draftByDefault: false,
  },
  skipDays: [],
  maxSessionsPerDay: 6,
}

// ─── Scheduling ──────────────────────────────────────────────────────

// Global ceiling on simultaneously-running sessions across all projects.
// Per-project concurrency is always 1 (ADR-008).
export const MAX_CONCURRENT_SESSIONS = 3

// ─── Layout ──────────────────────────────────────────────────────────

// Where the .maestro/ directory lives inside each managed project.
export const MAESTRO_DIR_NAME = '.maestro'

// Subpaths within .maestro/.
export const MAESTRO_PATHS = {
  state: 'state.md',
  context: 'context.md',
  decisions: 'decisions.md',
  autonomy: 'autonomy.json',
  journal: 'journal',
} as const

// How many recent journal entries to surface in a session prompt.
export const JOURNAL_LOOKBACK_ENTRIES = 3

// ─── HTTP ────────────────────────────────────────────────────────────

export const DEFAULT_PORT = 3000

export const DEFAULT_DATA_DIR = './data'
