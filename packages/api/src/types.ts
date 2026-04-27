// Types derived from the Zod schemas in ./routes.ts. Import these on the
// dashboard side for static checking; the conductor uses .parse() at runtime.

import type { z } from 'zod'
import type {
  HealthResponseSchema,
  ErrorResponseSchema,
  ListProjectsResponseSchema,
  GetProjectParamsSchema,
  GetProjectResponseSchema,
  ListSessionsQuerySchema,
  ListSessionsResponseSchema,
  ListPullRequestsQuerySchema,
  ListPullRequestsResponseSchema,
} from './routes.js'

export type HealthResponse = z.infer<typeof HealthResponseSchema>
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>
export type GetProjectParams = z.infer<typeof GetProjectParamsSchema>
export type GetProjectResponse = z.infer<typeof GetProjectResponseSchema>

export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>

export type ListPullRequestsQuery = z.infer<typeof ListPullRequestsQuerySchema>
export type ListPullRequestsResponse = z.infer<typeof ListPullRequestsResponseSchema>
