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
  CostAggregationsResponseSchema,
  HealthResponseSchema,
  ListProjectsResponseSchema,
  ListSessionsResponseSchema,
} from '@maestro/api'
import {
  COST_WARN_BUDGET_FRACTION,
  DEFAULT_MONTHLY_BUDGET_USD,
  SESSION_LOG_TAIL_LINES,
  buildSessionPrompt,
  isMaestroError,
} from '@maestro/shared'
import type Database from 'better-sqlite3'
import { execa } from 'execa'
import { logger } from './logger.js'
import { listRecentJournal, readMaestroDir } from './state-manager.js'
import { workingDirFor, parseNeverTouchSection } from './worker.js'
import {
  CostRepository,
  ProjectRepository,
  QualityGateRepository,
  SessionRepository,
} from './repositories.js'

export interface ServerDeps {
  /** Best-effort uptime baseline for the /health response. */
  startedAt: number
  /** Package version surfaced in /health. */
  version: string
  /** SQLite handle. */
  db: Database.Database
  /** Where working clones live. Used to compute prompts/diffs on demand. */
  dataDir: string
  /** Surfaced as the developer name in reconstructed prompts. */
  developerName: string
}

export function buildServer(deps: ServerDeps): Hono {
  const app = new Hono()
  const projects = new ProjectRepository(deps.db)
  const sessions = new SessionRepository(deps.db)
  const gates = new QualityGateRepository(deps.db)
  const costs = new CostRepository(deps.db)

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

  app.get('/api/sessions/:id/prompt', async (c) => {
    const id = c.req.param('id')
    const session = sessions.findById(id)
    if (!session) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } }, 404)
    }
    const project = projects.findById(session.projectId)
    if (!project) {
      return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project gone' } }, 404)
    }
    const wd = workingDirFor(deps.dataDir, project.slug)
    try {
      const m = await readMaestroDir(wd)
      const journal = await listRecentJournal(wd, 3)
      const prompt = buildSessionPrompt({
        projectName: project.slug,
        projectSlug: project.slug,
        timeBudgetSeconds: project.autonomyConfig.timeBudget,
        developerName: deps.developerName,
        context: m.context,
        state: m.state.raw,
        recentJournal: journal.map((j) => ({ filename: j.filename, body: j.body })),
        task: '',
        qualityGates: project.autonomyConfig.qualityGates,
        isFirstSession: journal.length === 0,
        projectSpecificNeverTouch: parseNeverTouchSection(m.context),
      })
      return c.json({ available: true, prompt })
    } catch (err) {
      logger.warn({ err, slug: project.slug }, 'cannot reconstruct prompt for session')
      return c.json({
        available: false,
        prompt: '',
        reason:
          'Working clone not present or .maestro/ unavailable. Re-run a session or run `maestro reset <slug>` first.',
      })
    }
  })

  app.get('/api/sessions/:id/diff', async (c) => {
    const id = c.req.param('id')
    const session = sessions.findById(id)
    if (!session) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } }, 404)
    }
    if (!session.branchName) {
      return c.json({ available: false, diff: '', reason: 'session produced no branch' })
    }
    const project = projects.findById(session.projectId)
    if (!project) {
      return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project gone' } }, 404)
    }
    const wd = workingDirFor(deps.dataDir, project.slug)
    try {
      const r = await execa(
        'git',
        ['log', '-p', '-1', '--no-color', `--format=fuller`, session.branchName],
        { cwd: wd, reject: false, timeout: 8000 },
      )
      if (r.exitCode === 0) {
        return c.json({ available: true, diff: r.stdout.toString() })
      }
      return c.json({ available: false, diff: '', reason: 'git log failed' })
    } catch (err) {
      return c.json({
        available: false,
        diff: '',
        reason: err instanceof Error ? err.message : 'unknown error',
      })
    }
  })

  app.get('/api/costs', (c) => {
    const agg = costs.aggregate()
    const monthlyBudgetUsd = Number(
      process.env['MAESTRO_BUDGET_USD'] ?? DEFAULT_MONTHLY_BUDGET_USD,
    )
    const monthlyBudgetCents = Math.round(monthlyBudgetUsd * 100)
    const fraction =
      monthlyBudgetCents > 0 ? agg.monthCents / monthlyBudgetCents : 0
    if (fraction >= COST_WARN_BUDGET_FRACTION) {
      logger.warn(
        { monthCents: agg.monthCents, monthlyBudgetCents, fraction },
        'monthly budget threshold reached',
      )
    }
    const body = CostAggregationsResponseSchema.parse({
      monthCents: agg.monthCents,
      todayCents: agg.todayCents,
      monthlyBudgetCents,
      budgetFractionUsed: fraction,
      perProject: agg.perProject,
      dailySeries: agg.dailySeries,
    })
    return c.json(body)
  })

  app.get('/api/prs', (c) => {
    // Fan out across projects with PRs from completed sessions.
    const projectMap = new Map(projects.list().map((p) => [p.id, p]))
    const list = sessions.list({ limit: 200 })
    const pulls = list.sessions
      .filter((s) => s.prNumber !== null)
      .map((s) => {
        const proj = projectMap.get(s.projectId)
        return {
          sessionId: s.id,
          projectSlug: proj?.slug ?? s.projectId,
          repoUrl: proj?.repoUrl ?? null,
          prNumber: s.prNumber,
          prUrl: s.prUrl,
          branchName: s.branchName,
          status: s.status,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          costCents: s.costCents,
        }
      })
    return c.json({ pullRequests: pulls })
  })

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
