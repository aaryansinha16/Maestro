// HTTP route schemas. The conductor and the dashboard both import these so
// they cannot drift on request/response shapes. Each route gets:
//   - method, path constants
//   - input schema (params, query, body, as relevant)
//   - output schema
//
// Routes here are placeholders for Phase 0; concrete handlers live in the
// conductor and consume these schemas via .parse().

import { z } from 'zod'
import {
  ProjectSchema,
  SessionSchema,
  PullRequestSchema,
  QualityGateRunSchema,
  JobSchema,
  ScheduledRunSchema,
  WeekdaySchema,
  ProjectPrioritySchema,
  PrFeedbackSchema,
  AutonomyFileSchema,
} from '@maestro/shared'

// ─── Common ──────────────────────────────────────────────────────────

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string().datetime(),
})

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    context: z.record(z.unknown()).optional(),
  }),
})

// ─── /api/projects ───────────────────────────────────────────────────

export const ListProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema),
})

export const GetProjectParamsSchema = z.object({
  slug: z.string().min(1),
})

export const GetProjectResponseSchema = z.object({
  project: ProjectSchema,
})

// ─── /api/sessions ───────────────────────────────────────────────────

export const ListSessionsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
})

export const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionSchema),
  total: z.number().int().nonnegative(),
})

export const GetSessionParamsSchema = z.object({
  id: z.string().min(1),
})

export const GetSessionResponseSchema = z.object({
  session: SessionSchema,
  qualityGates: z.array(QualityGateRunSchema),
})

export const SessionLogResponseSchema = z.object({
  available: z.boolean(),
  truncated: z.boolean(),
  tail: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
})

// ─── /api/costs ──────────────────────────────────────────────────────

export const CostAggregationsResponseSchema = z.object({
  monthCents: z.number().int().nonnegative(),
  todayCents: z.number().int().nonnegative(),
  monthlyBudgetCents: z.number().int().nonnegative(),
  budgetFractionUsed: z.number().min(0),
  perProject: z.array(
    z.object({
      projectId: z.string(),
      projectSlug: z.string(),
      sessionCount: z.number().int().nonnegative(),
      monthCents: z.number().int().nonnegative(),
      prCount: z.number().int().nonnegative(),
      centsPerPr: z.number().int().nonnegative().nullable(),
    }),
  ),
  dailySeries: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      cents: z.number().int().nonnegative(),
    }),
  ),
})

// ─── /api/prs ────────────────────────────────────────────────────────

export const ListPullRequestsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  status: z.enum(['draft', 'open', 'merged', 'closed', 'needs-review']).optional(),
})

export const ListPullRequestsResponseSchema = z.object({
  pullRequests: z.array(PullRequestSchema),
})

// ─── Phase 2: scheduling + queue ─────────────────────────────────────

// One row per registered project on the schedule page. The dashboard
// renders these as a table with toggles for `scheduledEnabled`.
export const ScheduleEntrySchema = z.object({
  slug: z.string().min(1),
  scheduledEnabled: z.boolean(),
  schedule: z.string().min(1),
  skipDays: z.array(WeekdaySchema),
  maxSessionsPerDay: z.number().int().positive(),
  priority: ProjectPrioritySchema,
  autoPausedAt: z.string().datetime().nullable(),
  autoPauseReason: z.string().nullable(),
  /** Best-effort next-run time computed from the cron expression. */
  nextRunAt: z.string().datetime().nullable(),
})

export const ListScheduleResponseSchema = z.object({
  entries: z.array(ScheduleEntrySchema),
})

export const UpdateScheduleBodySchema = z.object({
  schedule: z.string().min(1).optional(),
  skipDays: z.array(WeekdaySchema).optional(),
  maxSessionsPerDay: z.number().int().positive().max(50).optional(),
  priority: ProjectPrioritySchema.optional(),
})

export const PauseProjectBodySchema = z.object({
  reason: z.string().min(1).max(500).optional(),
})

export const QueueResponseSchema = z.object({
  running: z.array(JobSchema),
  queued: z.array(JobSchema),
  recentlyCompleted: z.array(JobSchema),
})

export const ListSkipsResponseSchema = z.object({
  skips: z.array(ScheduledRunSchema),
})

// ─── PR feedback (Phase 4 / Sub 1) ───────────────────────────────────

export const GetProjectFeedbackResponseSchema = z.object({
  pending: z.array(PrFeedbackSchema),
  pendingCount: z.number().int().nonnegative(),
})

// ─── Autonomy editing (Phase 4.5 / Sub 4.5.3) ────────────────────────

// Fields editable via /api/projects/:slug/autonomy. Schedule-side fields
// (schedule, skipDays, maxSessionsPerDay, priority) and the
// scheduledEnabled flag are intentionally excluded — they go through
// /api/projects/:slug/schedule and /scheduling/{enable,disable}.
//
// `level: 'paused'` is accepted here for the "persistently paused"
// semantic; the pause endpoint at /pause is for transient pauses
// reflected in auto_paused_at.
export const UpdateAutonomyBodySchema = z.object({
  level: z.enum(['full', 'pr-only', 'draft-only', 'paused']).optional(),
  timeBudget: z.number().int().positive().optional(),
  qualityGates: z
    .array(z.enum(['test', 'lint', 'typecheck', 'build']))
    .optional(),
  branches: z
    .object({
      base: z.string().min(1).optional(),
      prefix: z.string().min(1).optional(),
    })
    .optional(),
  github: z
    .object({
      prLabels: z.array(z.string()).optional(),
      draftByDefault: z.boolean().optional(),
    })
    .optional(),
  continueUntilBudget: z.boolean().optional(),
  minTimeForContinuation: z.number().int().positive().optional(),
})

// ─── Project onboarding (Phase 4.5 / Sub 4.5.4) ──────────────────────

export const GithubProbeQuerySchema = z.object({
  repoUrl: z.string().url(),
})

export const GithubProbeResponseSchema = z.object({
  repoUrl: z.string(),
  projectName: z.string(),
  defaultBranch: z.string(),
  description: z.string().nullable(),
  /** True when .maestro/state.md already exists on the default branch. */
  hasMaestroDir: z.boolean(),
  /** Rendered seed context.md the wizard shows (and lets the user edit). */
  suggestedContext: z.string(),
})

export const InitProjectBodySchema = z.object({
  repoUrl: z.string().url(),
  focus: z.string().min(1),
  tasks: z.array(z.string()).default([]),
  /** Full autonomy config — the wizard merges its form over the defaults. */
  autonomy: AutonomyFileSchema,
  /** context.md body. When omitted the server re-probes and renders the seed. */
  context: z.string().optional(),
  /** false = commit straight to the default branch (no PR). Default true. */
  openAsPR: z.boolean().default(true),
})

export const InitProjectResponseSchema = z.object({
  branch: z.string(),
  prUrl: z.string().url().nullable(),
  prNumber: z.number().int().positive().nullable(),
})

export const RegisterProjectBodySchema = z.object({
  repoUrl: z.string().url(),
})

export const RegisterProjectResponseSchema = z.object({
  project: ProjectSchema,
})

// ─── Route registry ──────────────────────────────────────────────────

// A typed catalogue of every route, useful to the dashboard's fetch wrapper
// for path lookup and to the conductor for documentation. Add new entries
// here when adding routes.
export const ROUTES = {
  health: { method: 'GET', path: '/api/health' },
  listProjects: { method: 'GET', path: '/api/projects' },
  getProject: { method: 'GET', path: '/api/projects/:slug' },
  listSessions: { method: 'GET', path: '/api/sessions' },
  getSession: { method: 'GET', path: '/api/sessions/:id' },
  getSessionLog: { method: 'GET', path: '/api/sessions/:id/log' },
  getSessionPrompt: { method: 'GET', path: '/api/sessions/:id/prompt' },
  getSessionDiff: { method: 'GET', path: '/api/sessions/:id/diff' },
  listPullRequests: { method: 'GET', path: '/api/prs' },
  getCosts: { method: 'GET', path: '/api/costs' },
  // Phase 2.
  listSchedule: { method: 'GET', path: '/api/schedule' },
  updateSchedule: { method: 'POST', path: '/api/projects/:slug/schedule' },
  enableScheduling: { method: 'POST', path: '/api/projects/:slug/scheduling/enable' },
  disableScheduling: { method: 'POST', path: '/api/projects/:slug/scheduling/disable' },
  pauseProject: { method: 'POST', path: '/api/projects/:slug/pause' },
  resumeProject: { method: 'POST', path: '/api/projects/:slug/resume' },
  getQueue: { method: 'GET', path: '/api/queue' },
  listSkips: { method: 'GET', path: '/api/projects/:slug/skips' },
  triggerProject: { method: 'POST', path: '/api/projects/:slug/trigger' },
  // Phase 4 / Sub 1.
  getProjectFeedback: { method: 'GET', path: '/api/projects/:slug/feedback' },
  // Phase 4.5 / Sub 4.5.3.
  updateAutonomy: { method: 'POST', path: '/api/projects/:slug/autonomy' },
  // Phase 4.5 / Sub 4.5.4.
  githubProbe: { method: 'GET', path: '/api/github/probe' },
  initProject: { method: 'POST', path: '/api/projects/init' },
  registerProject: { method: 'POST', path: '/api/projects/register' },
  // Phase 5.
  adminBackup: { method: 'POST', path: '/api/admin/backup' },
} as const

export type RouteKey = keyof typeof ROUTES
