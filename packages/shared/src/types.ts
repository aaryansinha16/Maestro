// Shared domain types. The Zod schemas in ./schemas.ts are the runtime source
// of truth for everything that crosses an external boundary (API requests,
// .maestro/ file contents, GitHub responses). Types here are derived from
// those schemas so the static and runtime views never drift.

import type {
  ProjectSchema,
  ProjectAutonomyConfigSchema,
  SessionSchema,
  SessionResultSchema,
  QualityGateRunSchema,
  JournalEntrySchema,
  ProjectStateSchema,
  PullRequestSchema,
  CostRecordSchema,
  BriefingSchema,
} from './schemas.js'
import type { z } from 'zod'

// ─── Autonomy ────────────────────────────────────────────────────────

export const PROJECT_AUTONOMY_LEVELS = ['full', 'pr-only', 'draft-only', 'paused'] as const
export type ProjectAutonomyLevel = (typeof PROJECT_AUTONOMY_LEVELS)[number]

export type ProjectAutonomyConfig = z.infer<typeof ProjectAutonomyConfigSchema>

// ─── Project ─────────────────────────────────────────────────────────

export type Project = z.infer<typeof ProjectSchema>

// ─── Sessions ────────────────────────────────────────────────────────

export const SESSION_STATUSES = [
  'pending',
  'running',
  'completed',
  'completed-no-changes',
  'quality-gate-failed',
  'timed-out',
  'failed',
  'cancelled',
] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

export type Session = z.infer<typeof SessionSchema>
export type SessionResult = z.infer<typeof SessionResultSchema>

// ─── Quality gates ───────────────────────────────────────────────────

export const QUALITY_GATE_NAMES = ['test', 'lint', 'typecheck', 'build'] as const
export type QualityGate = (typeof QUALITY_GATE_NAMES)[number]

export const QUALITY_GATE_STATUSES = ['passed', 'failed', 'skipped'] as const
export type QualityGateStatus = (typeof QUALITY_GATE_STATUSES)[number]

export type QualityGateRun = z.infer<typeof QualityGateRunSchema>

// ─── .maestro/ file contents ─────────────────────────────────────────

export type JournalEntry = z.infer<typeof JournalEntrySchema>
export type ProjectState = z.infer<typeof ProjectStateSchema>

// ─── Pull requests ───────────────────────────────────────────────────

export const PR_STATUSES = ['draft', 'open', 'merged', 'closed', 'needs-review'] as const
export type PRStatus = (typeof PR_STATUSES)[number]

export type PullRequest = z.infer<typeof PullRequestSchema>

// ─── Cost tracking ───────────────────────────────────────────────────

export type CostRecord = z.infer<typeof CostRecordSchema>

// ─── Briefing ────────────────────────────────────────────────────────

export type Briefing = z.infer<typeof BriefingSchema>
