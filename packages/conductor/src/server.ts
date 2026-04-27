// Hono application setup. Routes return shapes defined in @maestro/api so the
// dashboard always agrees with the conductor on types.
//
// Phase 0 routes are read-only stubs; Phase 1+ wires them to real data.

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import {
  ListProjectsResponseSchema,
  ListSessionsResponseSchema,
  HealthResponseSchema,
} from '@maestro/api'
import { isMaestroError } from '@maestro/shared'
import { logger } from './logger.js'

export interface ServerDeps {
  /** Best-effort uptime baseline for the /health response. */
  startedAt: number
  /** Package version surfaced in /health. */
  version: string
}

export function buildServer(deps: ServerDeps): Hono {
  const app = new Hono()

  app.use('*', honoLogger((msg) => logger.debug(msg)))
  app.use('/api/*', cors({ origin: '*' }))

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    if (isMaestroError(err)) {
      logger.error({ err }, 'request failed with MaestroError')
      return c.json(
        {
          error: { code: err.code, message: err.message, context: err.context },
        },
        500,
      )
    }
    logger.error({ err }, 'unhandled error')
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      500,
    )
  })

  app.get('/api/health', (c) => {
    const body = HealthResponseSchema.parse({
      status: 'ok',
      version: deps.version,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    })
    return c.json(body)
  })

  app.get('/api/projects', (c) => {
    const body = ListProjectsResponseSchema.parse({ projects: [] })
    return c.json(body)
  })

  app.get('/api/sessions', (c) => {
    const body = ListSessionsResponseSchema.parse({ sessions: [], total: 0 })
    return c.json(body)
  })

  app.get('/api/prs', (c) => c.json({ pullRequests: [] }))

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `No route for ${c.req.path}` } }, 404),
  )

  return app
}
