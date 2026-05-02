// Hono application setup. Routes return shapes defined in @maestro/api so the
// dashboard always agrees with the conductor on types.
//
// Phase 1: project + session lists return real data from SQLite. The
// session-detail and session-log routes power the dashboard's "what
// happened" view.

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import {
  HealthResponseSchema,
  ListProjectsResponseSchema,
  ListSessionsResponseSchema,
} from '@maestro/api'
import {
  SESSION_LOG_TAIL_LINES,
  isMaestroError,
} from '@maestro/shared'
import type Database from 'better-sqlite3'
import { logger } from './logger.js'
import { ProjectRepository, QualityGateRepository, SessionRepository } from './repositories.js'

export interface ServerDeps {
  /** Best-effort uptime baseline for the /health response. */
  startedAt: number
  /** Package version surfaced in /health. */
  version: string
  /** SQLite handle. */
  db: Database.Database
}

export function buildServer(deps: ServerDeps): Hono {
  const app = new Hono()
  const projects = new ProjectRepository(deps.db)
  const sessions = new SessionRepository(deps.db)
  const gates = new QualityGateRepository(deps.db)

  app.use('*', honoLogger((msg) => logger.debug(msg)))
  app.use('/api/*', cors({ origin: '*' }))

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    if (isMaestroError(err)) {
      logger.error({ err }, 'request failed with MaestroError')
      return c.json(
        { error: { code: err.code, message: err.message, context: err.context } },
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
    const body = ListProjectsResponseSchema.parse({ projects: projects.list() })
    return c.json(body)
  })

  app.get('/api/projects/:slug', (c) => {
    const project = projects.findBySlug(c.req.param('slug'))
    if (!project) {
      return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Unknown project' } }, 404)
    }
    return c.json({ project })
  })

  app.get('/api/sessions', (c) => {
    const projectId = c.req.query('projectId')
    const limit = parseInt(c.req.query('limit') ?? '50', 10)
    const offset = parseInt(c.req.query('offset') ?? '0', 10)
    const result = sessions.list({
      projectId,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    })
    const body = ListSessionsResponseSchema.parse(result)
    return c.json(body)
  })

  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id')
    const session = sessions.findById(id)
    if (!session) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } }, 404)
    }
    return c.json({
      session,
      qualityGates: gates.listForSession(id),
    })
  })

  app.get('/api/sessions/:id/log', async (c) => {
    const id = c.req.param('id')
    const session = sessions.findById(id)
    if (!session) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } }, 404)
    }
    if (!session.logPath || !existsSync(session.logPath)) {
      return c.json({ tail: '', truncated: false, available: false })
    }
    const tail = await readTail(session.logPath, SESSION_LOG_TAIL_LINES)
    return c.json({
      tail: tail.text,
      truncated: tail.truncated,
      available: true,
      sizeBytes: tail.sizeBytes,
    })
  })

  app.get('/api/prs', (c) => c.json({ pullRequests: [] }))

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `No route for ${c.req.path}` } }, 404),
  )

  return app
}

interface TailResult {
  text: string
  truncated: boolean
  sizeBytes: number
}

async function readTail(path: string, lines: number): Promise<TailResult> {
  const info = await stat(path)
  // Quick path for small files: just read it all.
  if (info.size < 256 * 1024) {
    return new Promise<TailResult>((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = createReadStream(path)
      stream.on('data', (chunk: string | Buffer) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      })
      stream.on('error', reject)
      stream.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        const split = text.split('\n')
        if (split.length <= lines) {
          resolve({ text, truncated: false, sizeBytes: info.size })
        } else {
          resolve({
            text: split.slice(-lines).join('\n'),
            truncated: true,
            sizeBytes: info.size,
          })
        }
      })
    })
  }
  // Larger file: read just the trailing slice (last 256KB) and tail it.
  const stream = createReadStream(path, { start: Math.max(0, info.size - 256 * 1024) })
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk as string) : (chunk as Buffer))
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  const split = text.split('\n').slice(-lines)
  return { text: split.join('\n'), truncated: true, sizeBytes: info.size }
}
