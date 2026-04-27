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

// ─── /api/prs ────────────────────────────────────────────────────────

export const ListPullRequestsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  status: z.enum(['draft', 'open', 'merged', 'closed', 'needs-review']).optional(),
})

export const ListPullRequestsResponseSchema = z.object({
  pullRequests: z.array(PullRequestSchema),
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
  listPullRequests: { method: 'GET', path: '/api/prs' },
} as const

export type RouteKey = keyof typeof ROUTES
