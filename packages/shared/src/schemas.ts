// Zod schemas — the runtime source of truth for every shape that crosses an
// external boundary. Validate every external input with these.
//
// Per AGENTS.md: never trust state from .maestro/ files, GitHub responses, or
// API payloads without parsing through one of these.

import { z } from 'zod'

// ─── Autonomy ────────────────────────────────────────────────────────

export const ProjectAutonomyLevelSchema = z.enum(['full', 'pr-only', 'draft-only', 'paused'])

export const QualityGateNameSchema = z.enum(['test', 'lint', 'typecheck', 'build'])

export const QualityGateStatusSchema = z.enum(['passed', 'failed', 'skipped'])

// Phase 2: priority hints used by the cost-throttling skip rule. `low`
// projects skip first when the monthly budget runs hot.
export const ProjectPrioritySchema = z.enum(['high', 'normal', 'low'])

// Phase 2: weekday names accepted in autonomy.json `skipDays`. Stored
// case-insensitively; normalised to lowercase by the scheduler.
export const WeekdaySchema = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
])

export const ProjectAutonomyConfigSchema = z.object({
  level: ProjectAutonomyLevelSchema,
  // Standard cron expression. Validated as a non-empty string here; the
  // scheduler validates parseability when it loads the config.
  schedule: z.string().min(1),
  // Hard kill ceiling for a session, in seconds. See ADR-007.
  timeBudget: z.number().int().positive(),
  qualityGates: z.array(QualityGateNameSchema),
  branches: z.object({
    base: z.string().min(1).default('main'),
    prefix: z.string().min(1).default('maestro/'),
  }),
  github: z.object({
    prLabels: z.array(z.string()).default([]),
    draftByDefault: z.boolean().default(false),
  }),
  skipDays: z.array(WeekdaySchema).default([]),
  maxSessionsPerDay: z.number().int().positive().default(6),
  // Phase 2: scheduled execution is opt-in per project. Defaults to
  // false so a project added via `maestro add` only fires from manual
  // triggers until the developer enables it explicitly. See ADR-020+.
  scheduledEnabled: z.boolean().default(false),
  // Phase 2: cost-throttling priority hint. See skip rule E.
  priority: ProjectPrioritySchema.default('normal'),
})

// ─── Project ─────────────────────────────────────────────────────────

export const ProjectSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  repoUrl: z.string().url(),
  autonomyConfig: ProjectAutonomyConfigSchema,
  createdAt: z.string().datetime(),
  // Phase 2: row-level scheduling state. `scheduledEnabled` is the
  // canonical "is scheduling on?" flag at the row level, mirroring the
  // autonomy.json field for fast queries. autoPausedAt is set when the
  // failure-tracker decides a project shouldn't auto-fire any more.
  scheduledEnabled: z.boolean().default(false),
  autoPausedAt: z.string().datetime().nullable().default(null),
  autoPauseReason: z.string().nullable().default(null),
})

// ─── Sessions & quality gates ────────────────────────────────────────

export const SessionStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'completed-no-changes',
  'quality-gate-failed',
  'timed-out',
  'failed',
  'cancelled',
])

export const QualityGateRunSchema = z.object({
  id: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  gateName: QualityGateNameSchema,
  status: QualityGateStatusSchema,
  output: z.string(),
  ranAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative().optional(),
})

export const TerminationCauseSchema = z.enum([
  'exit-clean',
  'graceful',
  'sigterm-timeout',
  'sigkill-timeout',
  'failed',
  'killed-by-signal',
])

export const SessionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  status: SessionStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  costCents: z.number().int().nonnegative().nullable(),
  promptVersion: z.string().min(1),
  modelUsed: z.string().nullable(),
  branchName: z.string().nullable(),
  prNumber: z.number().int().positive().nullable(),
  prUrl: z.string().url().nullable(),
  journalPath: z.string().nullable(),
  logPath: z.string().nullable(),
  terminationCause: TerminationCauseSchema.nullable(),
  isFixupTurn: z.boolean().default(false),
  parentSessionId: z.string().min(1).nullable(),
})

export const SessionResultSchema = z.object({
  sessionId: z.string().min(1),
  status: SessionStatusSchema,
  filesChanged: z.array(z.string()),
  commitSha: z.string().nullable(),
  branchName: z.string().nullable(),
  prNumber: z.number().int().positive().nullable(),
  qualityGates: z.array(QualityGateRunSchema),
  costCents: z.number().int().nonnegative().nullable(),
  journalPath: z.string().nullable(),
  notes: z.string().nullable(),
})

// ─── .maestro/ file contents ─────────────────────────────────────────

// state.md and context.md are markdown by convention; they're not parsed into
// strict structure by Maestro itself. The agent reads them, the developer
// writes them. We keep them as strings here.

export const ProjectStateSchema = z.object({
  // The full markdown body of state.md. Sections are convention, not enforced.
  raw: z.string(),
  // The path the file was read from, relative to the project root.
  path: z.string().default('.maestro/state.md'),
})

// Phase 1.5: filenames now carry seconds granularity. The legacy minute
// pattern is still accepted on read so existing journals don't reject —
// the worker migrates them via state-manager on first read.
export const JOURNAL_FILENAME_RE = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/
export const JOURNAL_FILENAME_LEGACY_RE = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/

export const JournalEntrySchema = z.object({
  // Filename like "2026-04-15-08-00-12.md" — ISO-ish timestamp slug to
  // seconds. Legacy minute-granularity filenames (no trailing seconds) are
  // also accepted on read.
  filename: z
    .string()
    .refine(
      (s) => JOURNAL_FILENAME_RE.test(s) || JOURNAL_FILENAME_LEGACY_RE.test(s),
      { message: 'must be YYYY-MM-DD-HH-MM-SS.md (or legacy YYYY-MM-DD-HH-MM.md)' },
    ),
  sessionId: z.string().min(1).nullable(),
  // ISO timestamp parsed from the filename.
  timestamp: z.string().datetime(),
  // The full markdown body.
  body: z.string(),
})

// ─── Pull requests ───────────────────────────────────────────────────

export const PRStatusSchema = z.enum(['draft', 'open', 'merged', 'closed', 'needs-review'])

export const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string().min(1),
  body: z.string(),
  status: PRStatusSchema,
  branchName: z.string().min(1),
  baseBranch: z.string().min(1),
  createdAt: z.string().datetime(),
  mergedAt: z.string().datetime().nullable(),
  sessionId: z.string().min(1).nullable(),
})

// ─── Cost tracking ───────────────────────────────────────────────────

export const CostRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  // Cents — integers avoid floating point issues. Convert at presentation time.
  costCents: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheWriteTokens: z.number().int().nonnegative().nullable(),
  recordedAt: z.string().datetime(),
})

// ─── Briefing ────────────────────────────────────────────────────────

export const BriefingSchema = z.object({
  id: z.string().min(1),
  sentAt: z.string().datetime(),
  content: z.string(),
  tgMessageId: z.string().nullable(),
})

// ─── autonomy.json on disk ───────────────────────────────────────────

// The shape stored at .maestro/autonomy.json in each managed project. Same
// content as ProjectAutonomyConfigSchema; isolated alias so we can evolve the
// on-disk format separately from the in-memory representation if needed.
export const AutonomyFileSchema = ProjectAutonomyConfigSchema

// ─── Phase 2: job queue + scheduled runs ─────────────────────────────

export const JobSourceSchema = z.enum(['schedule', 'manual', 'retry'])
export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])

export const JobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  source: JobSourceSchema,
  status: JobStatusSchema,
  priority: z.number().int(),
  enqueuedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  sessionId: z.string().min(1).nullable(),
  cancelReason: z.string().nullable(),
})

export const ScheduledRunActionSchema = z.enum([
  'enqueued',
  'skipped',
  'failed-to-fire',
])

// Typed reasons the scheduler may record on a `skipped` row. Encoded as
// strings so the audit log is human-readable in SQLite without a join.
export const ScheduleSkipReasonSchema = z.enum([
  'developer-recently-active',
  'max-sessions-per-day',
  'skip-day',
  'auto-paused',
  'manual-paused',
  'cost-throttle-low-priority',
  'cost-throttle-budget-exceeded',
  'failure-backoff',
  'project-disabled',
  'unknown',
])

export const ScheduledRunSchema = z.object({
  id: z.number().int(),
  projectId: z.string().min(1),
  scheduledAt: z.string().datetime(),
  firedAt: z.string().datetime(),
  action: ScheduledRunActionSchema,
  skipReason: ScheduleSkipReasonSchema.nullable(),
  jobId: z.string().nullable(),
  notes: z.string().nullable(),
})
