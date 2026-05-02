// System-wide constants. Anything that's a tunable default for sessions, the
// scheduler, or quality gates lives here so it has one canonical home.

import type { ProjectAutonomyConfig, QualityGate } from './types.js'

// ─── Prompt versioning ───────────────────────────────────────────────

// The prompt template version. Bump on every meaningful change to
// SESSION_PROMPT_TEMPLATE_V1 in prompt-templates.ts. See PROMPT_DESIGN.md.
//
// 1.1.0 — Phase 1.5: split FIRST SESSION preamble into ORIENTATION MODE
//         (empty journal + empty tasks → no code changes, no gates, no PR)
//         vs FIRST SESSION (concrete task in state.md → proceed normally).
//         Wires context.md `## Never Touch` items into the prompt's rule #6.
// 1.2.0 — Phase 4 / Sub 1: adds the FEEDBACK ON RECENT PRs section. When
//         the worker fetches reviewer comments on the project's open Maestro
//         PRs, they are surfaced to the agent so it can address them in the
//         current session instead of waiting for state.md to be edited by hand.
export const PROMPT_VERSION = '1.2.0'

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
  // Phase 2: scheduling is opt-in. Defaults to false; the developer
  // enables per project after manual sessions prove the project is healthy.
  scheduledEnabled: false,
  priority: 'normal',
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

// ─── Working directories ─────────────────────────────────────────────

// Where per-project clones live, relative to MAESTRO_DATA_DIR.
export const WORK_SUBDIR = 'work'

// Where session log files live, relative to MAESTRO_DATA_DIR.
export const LOGS_SUBDIR = 'logs/sessions'

// ─── Quality gates ───────────────────────────────────────────────────

// Per-gate timeout (seconds). Default 5 minutes.
export const DEFAULT_QUALITY_GATE_TIMEOUT_SECONDS = 5 * 60

// Number of trailing output lines stored in the database for each gate
// run. The full output goes to the session log file.
export const QUALITY_GATE_OUTPUT_TAIL_LINES = 200

// ─── Project stacks ──────────────────────────────────────────────────

// Stacks Maestro can detect from the project root. Used to decide which
// commands to run for each quality gate when no explicit override exists.
export const PROJECT_STACKS = [
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'python-poetry',
  'python-pip',
  'rust-cargo',
  'go-mod',
  'unknown',
] as const

// ─── Sessions ────────────────────────────────────────────────────────

// Session log tail size returned to the dashboard. Bigger requests stream.
export const SESSION_LOG_TAIL_LINES = 500

// ─── Cost guardrails ─────────────────────────────────────────────────

// A single session that costs more than this triggers a warning log line.
// 1 USD = 100 cents.
export const COST_WARN_PER_SESSION_CENTS = 100

// Default monthly budget when MAESTRO_BUDGET_USD env var is unset.
export const DEFAULT_MONTHLY_BUDGET_USD = 50

// Threshold (fraction of monthly budget) at which the dashboard surfaces a
// "approaching budget" alert.
export const COST_WARN_BUDGET_FRACTION = 0.8

// ─── Phase 2: scheduling ─────────────────────────────────────────────

// Default global parallel-session ceiling. Overridable via
// MAESTRO_MAX_PARALLEL env var. Per-project concurrency is always 1
// (ADR-008) and enforced separately by the project_locks table.
export const DEFAULT_MAX_PARALLEL = 2

// How often the scheduler polls the projects table for hot-reload.
// 30 s is a pragmatic compromise — fast enough that schedule edits
// take effect mid-day without a restart, slow enough to be cheap.
export const SCHEDULER_POLL_INTERVAL_MS = 30_000

// Default window the "developer recently active" skip rule looks at.
// Overridable via MAESTRO_DEVELOPER_ACTIVITY_WINDOW_HOURS.
export const DEFAULT_DEVELOPER_ACTIVITY_WINDOW_HOURS = 4

// Cost throttle thresholds (fraction of monthly budget). Above LOW,
// `priority: low` projects are skipped. Above ALL, every scheduled run
// is skipped (manual triggers still work).
export const COST_THROTTLE_LOW_FRACTION = 0.8
export const COST_THROTTLE_ALL_FRACTION = 0.95

// Failed-session backoff: a project's nth scheduled run is skipped when
// the consecutive_failures counter reaches FAILURE_BACKOFF_THRESHOLD.
// We skip (count - threshold + 1) runs then try again.
export const FAILURE_BACKOFF_THRESHOLD = 3

// Auto-pause kicks in at this many consecutive failures. Distinct from
// the backoff threshold so the developer has a clear "stop scheduling"
// signal, with manual triggers still available.
export const AUTO_PAUSE_FAILURE_THRESHOLD = 5

// Manual triggers always have higher priority than scheduled ones.
// Higher number = jumps queue earlier.
export const JOB_PRIORITY_SCHEDULED = 0
export const JOB_PRIORITY_MANUAL = 100
export const JOB_PRIORITY_RETRY = 50

// Default polling interval for the dashboard /queue page.
export const QUEUE_POLL_INTERVAL_MS = 5_000
