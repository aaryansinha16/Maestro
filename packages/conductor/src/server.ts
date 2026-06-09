// Hono application setup. Routes return shapes defined in @maestro/api so the
// dashboard always agrees with the conductor on types.
//
// Phase 1: project + session lists return real data from SQLite. The
// session-detail and session-log routes power the dashboard's "what
// happened" view.

import { Hono, type Context } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve as resolvePath } from 'node:path'
import {
  CostAggregationsResponseSchema,
  GetProjectFeedbackResponseSchema,
  GithubProbeQuerySchema,
  GithubProbeResponseSchema,
  HealthResponseSchema,
  InitProjectBodySchema,
  InitProjectResponseSchema,
  ListProjectsResponseSchema,
  ListScheduleResponseSchema,
  ListSessionsResponseSchema,
  ListSkipsResponseSchema,
  PauseProjectBodySchema,
  QueueResponseSchema,
  RegisterProjectBodySchema,
  RegisterProjectResponseSchema,
  UpdateAutonomyBodySchema,
  UpdateScheduleBodySchema,
} from '@maestro/api'
import {
  AutonomyFileSchema,
  COST_WARN_BUDGET_FRACTION,
  DEFAULT_MONTHLY_BUDGET_USD,
  JOB_PRIORITY_MANUAL,
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
  createGitHubClient,
  parseRepoUrl,
  type GitHubClient,
} from './pr-manager.js'
import {
  buildMaestroFiles,
  renderContextMd,
  renderStateMd,
  seedFromPackageJson,
  type ContextSeed,
} from './project-init.js'
import { scaffoldOnGitHub } from './github-scaffolder.js'
import { registerProject } from './project-register.js'
import { runBackupNow } from './backup.js'
import { computeNextCronRun } from './cron-utils.js'
import type { JobQueue } from './job-queue.js'
import type { Scheduler } from './scheduler.js'
import {
  CostRepository,
  PrFeedbackRepository,
  ProjectRepository,
  QualityGateRepository,
  ScheduledRunsRepository,
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
  /**
   * Optional Phase 2 plumbing: when present, the schedule + queue + skips
   * endpoints come alive. Tests omit these and the endpoints fall back to
   * read-only DB lookups.
   */
  queue?: JobQueue
  scheduler?: Scheduler
  /** Optional cron timezone for next-run computation. Defaults to UTC. */
  schedulerTimezone?: string
  /**
   * Phase 4.5 / Sub 4.5.4: GitHub access for the onboarding endpoints
   * (probe / init / register). Tests inject `githubClient`; production
   * passes `githubToken` and the server constructs the client lazily.
   * When neither is present those endpoints return 503.
   */
  githubToken?: string
  githubClient?: GitHubClient
  /**
   * Phase 5 / Sub 5.1: absolute path to the dashboard's static build
   * (vite dist). When set and the directory exists, every non-/api GET
   * serves from it with an index.html SPA fallback. Unset in tests that
   * don't care and in dev (Vite serves the dashboard itself).
   */
  dashboardDir?: string
  /**
   * Phase 5 / Sub 5.2: HTTP Basic Auth. When BOTH are set, everything
   * except /api/health (the Railway healthcheck path) requires
   * credentials. Top-level navigation triggers the browser's native
   * dialog; same-origin fetches then carry the header automatically, so
   * no login page is needed for single-user v1.
   */
  authUser?: string
  authPassword?: string
  /** Optional CORS allow origin. Unset → no CORS middleware (same-origin only). */
  corsOrigin?: string
}

export function buildServer(deps: ServerDeps): Hono {
  const app = new Hono()
  const projects = new ProjectRepository(deps.db)
  const sessions = new SessionRepository(deps.db)
  const gates = new QualityGateRepository(deps.db)
  const costs = new CostRepository(deps.db)
  const scheduledRuns = new ScheduledRunsRepository(deps.db)
  const feedback = new PrFeedbackRepository(deps.db)

  // Phase 4.5 / Sub 4.5.4: GitHub access for onboarding endpoints.
  // Lazily constructed so tests can inject a fake and production only
  // builds an Octokit when the first onboarding request arrives.
  let githubClientMemo: GitHubClient | null | undefined
  const resolveGithub = (): GitHubClient | null => {
    if (githubClientMemo !== undefined) return githubClientMemo
    githubClientMemo =
      deps.githubClient ??
      (deps.githubToken ? createGitHubClient({ token: deps.githubToken }) : null)
    return githubClientMemo
  }
  const githubUnavailable = (c: Context) =>
    c.json(
      {
        error: {
          code: 'GITHUB_UNAVAILABLE',
          message: 'GITHUB_TOKEN not configured on the conductor',
        },
      },
      503,
    )

  // 60-second probe cache by repoUrl — the wizard re-renders its preview
  // on every step transition and shouldn't burn GitHub rate limit doing it.
  const probeCache = new Map<string, { at: number; body: unknown }>()
  const PROBE_CACHE_TTL_MS = 60_000

  app.use('*', honoLogger((msg) => logger.debug(msg)))
  // CORS only when an explicit origin allowlist is configured. The
  // production layout serves the dashboard same-origin (Sub 5.1) and the
  // dev layout proxies through Vite — neither needs CORS.
  if (deps.corsOrigin) {
    app.use('/api/*', cors({ origin: deps.corsOrigin }))
  }

  // Phase 5 / Sub 5.2: Basic Auth across static + API. /api/health stays
  // open for platform healthchecks (Railway probes it unauthenticated).
  if (deps.authUser && deps.authPassword) {
    const requireAuth = basicAuth({
      username: deps.authUser,
      password: deps.authPassword,
    })
    app.use('*', async (c, next) => {
      if (c.req.path === '/api/health') return next()
      return requireAuth(c, next)
    })
    logger.info({ user: deps.authUser }, 'basic auth enabled')
  } else if (deps.authUser || deps.authPassword) {
    logger.warn(
      'MAESTRO_AUTH_USER / MAESTRO_AUTH_PASSWORD: only one is set — auth DISABLED. Set both.',
    )
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    // ZodError → 400. Catches request-body validation failures from any
    // handler that calls Schema.parse() on user input (which is most of
    // them). Without this they bubble to the generic 500 below.
    if (err instanceof ZodError) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed',
            issues: err.issues,
          },
        },
        400,
      )
    }
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

  // Phase 5 / Sub 5.5: Claude CLI health. Surfaces "is the agent runtime
  // actually usable on this host" — the gating question for any deploy.
  // `authenticated` is best-effort: a credentials file under
  // CLAUDE_CONFIG_DIR (Linux/Docker) is checkable; the macOS keychain is
  // not, so we report null ("unknown") rather than guessing.
  app.get('/api/health/claude', async (c) => {
    const { execa } = await import('execa')
    const claudeBin = process.env['MAESTRO_CLAUDE_BIN'] ?? 'claude'
    const probe = await execa(claudeBin, ['--version'], {
      reject: false,
      timeout: 3000,
    })
    const installed = probe.exitCode === 0
    const version = installed ? (probe.stdout ?? '').trim() || null : null

    const configDir =
      process.env['CLAUDE_CONFIG_DIR'] ??
      join(process.env['HOME'] ?? '/root', '.claude')
    let credentialsAt: string | null = null
    let authenticated: boolean | null = null
    try {
      const info = await stat(join(configDir, '.credentials.json'))
      credentialsAt = info.mtime.toISOString()
      authenticated = true
    } catch {
      // No file ⇒ on Linux/Docker that means not logged in; on macOS the
      // keychain holds the OAuth token, so absence proves nothing.
      authenticated = process.platform === 'darwin' ? null : installed ? false : null
    }

    return c.json({
      installed,
      version,
      authenticated,
      credentialsAt,
      configDir,
    })
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

  app.get('/api/projects/:slug/feedback', (c) => {
    const project = projects.findBySlug(c.req.param('slug'))
    if (!project) {
      return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Unknown project' } }, 404)
    }
    const body = GetProjectFeedbackResponseSchema.parse({
      pending: feedback.pendingForProject(project.id),
      pendingCount: feedback.pendingCount(project.id),
    })
    return c.json(body)
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

  // ─── Phase 2: scheduling + queue ──────────────────────────────────

  app.get('/api/schedule', (c) => {
    const tz = deps.schedulerTimezone ?? 'UTC'
    const entries = projects.list().map((p) => ({
      slug: p.slug,
      scheduledEnabled: p.scheduledEnabled,
      schedule: p.autonomyConfig.schedule,
      skipDays: p.autonomyConfig.skipDays,
      maxSessionsPerDay: p.autonomyConfig.maxSessionsPerDay,
      priority: p.autonomyConfig.priority,
      autoPausedAt: p.autoPausedAt,
      autoPauseReason: p.autoPauseReason,
      nextRunAt: p.scheduledEnabled
        ? computeNextCronRun(p.autonomyConfig.schedule, tz)
        : null,
    }))
    const body = ListScheduleResponseSchema.parse({ entries })
    return c.json(body)
  })

  app.post('/api/projects/:slug/scheduling/enable', (c) => {
    const slug = c.req.param('slug')
    const project = projects.findBySlug(slug)
    if (!project) return notFoundProject(c, slug)
    const next = AutonomyFileSchema.parse({
      ...project.autonomyConfig,
      scheduledEnabled: true,
    })
    projects.updateAutonomyConfig(slug, next)
    deps.scheduler?.reconcileNow()
    return c.json({ ok: true })
  })

  app.post('/api/projects/:slug/scheduling/disable', (c) => {
    const slug = c.req.param('slug')
    const project = projects.findBySlug(slug)
    if (!project) return notFoundProject(c, slug)
    const next = AutonomyFileSchema.parse({
      ...project.autonomyConfig,
      scheduledEnabled: false,
    })
    projects.updateAutonomyConfig(slug, next)
    deps.scheduler?.reconcileNow()
    return c.json({ ok: true })
  })

  app.post('/api/projects/:slug/schedule', async (c) => {
    const slug = c.req.param('slug')
    const project = projects.findBySlug(slug)
    if (!project) return notFoundProject(c, slug)
    const raw = (await c.req.json().catch(() => ({}))) as unknown
    const body = UpdateScheduleBodySchema.parse(raw)
    const merged = AutonomyFileSchema.parse({
      ...project.autonomyConfig,
      ...body,
    })
    projects.updateAutonomyConfig(slug, merged)
    deps.scheduler?.reconcileNow()
    return c.json({ ok: true })
  })

  app.get('/api/github/probe', async (c) => {
    const query = GithubProbeQuerySchema.parse({ repoUrl: c.req.query('repoUrl') })
    const cached = probeCache.get(query.repoUrl)
    if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
      return c.json(cached.body as Record<string, unknown>)
    }
    const gh = resolveGithub()
    if (!gh) return githubUnavailable(c)
    const repo = parseRepoUrl(query.repoUrl)

    const info = await gh.getRepoInfo(repo)
    const [pkgJson, readme, maestroState] = await Promise.all([
      gh.getFileContent({ repo, path: 'package.json', ref: info.defaultBranch }),
      gh.getFileContent({ repo, path: 'README.md', ref: info.defaultBranch }),
      gh.getFileContent({ repo, path: '.maestro/state.md', ref: info.defaultBranch }),
    ])

    let seed: ContextSeed = { projectName: repo.repo }
    if (pkgJson) {
      seed = seedFromPackageJson(pkgJson, repo.repo) ?? seed
    } else {
      seed.stackNote = 'Stack not detected from package.json — describe it here.'
    }
    if (info.description && !seed.description) seed.description = info.description
    if (readme) {
      const excerpt = readme.split('\n').slice(0, 30).join('\n').trim()
      if (excerpt.length > 0) seed.readmeExcerpt = excerpt
    }

    const body = GithubProbeResponseSchema.parse({
      repoUrl: query.repoUrl,
      projectName: seed.projectName,
      defaultBranch: info.defaultBranch,
      description: info.description,
      hasMaestroDir: maestroState !== null,
      suggestedContext: renderContextMd(seed),
    })
    probeCache.set(query.repoUrl, { at: Date.now(), body })
    return c.json(body)
  })

  app.post('/api/projects/init', async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as unknown
    const body = InitProjectBodySchema.parse(raw)
    const gh = resolveGithub()
    if (!gh) return githubUnavailable(c)
    const repo = parseRepoUrl(body.repoUrl)

    const info = await gh.getRepoInfo(repo)

    // Render context: caller-supplied (wizard's edited preview) or a
    // fresh probe-derived seed.
    let context = body.context
    if (!context) {
      const pkgJson = await gh.getFileContent({
        repo,
        path: 'package.json',
        ref: info.defaultBranch,
      })
      const seed: ContextSeed = pkgJson
        ? (seedFromPackageJson(pkgJson, repo.repo) ?? { projectName: repo.repo })
        : { projectName: repo.repo, stackNote: 'Describe the stack here.' }
      context = renderContextMd(seed)
    }

    const files = buildMaestroFiles({
      state: renderStateMd({ focus: body.focus, tasks: body.tasks }),
      context,
      autonomy: body.autonomy,
    })

    const result = await scaffoldOnGitHub({
      client: gh,
      repo,
      files,
      branchName: 'maestro/init',
      baseBranch: info.defaultBranch,
      prTitle: 'chore: maestro init',
      prBody: [
        'Adds the `.maestro/` directory so Maestro can manage this project.',
        '',
        '- `state.md` — current focus + next concrete tasks',
        '- `context.md` — durable project context the agent reads every session',
        '- `decisions.md` — decision log',
        '- `autonomy.json` — schedule, time budget, quality gates, autonomy level',
        '',
        'Generated by the Maestro dashboard onboarding wizard. Merge, then',
        'register the project from the dashboard to start running sessions.',
      ].join('\n'),
      openAsPR: body.openAsPR,
      prLabels: body.autonomy.github.prLabels,
    })

    const responseBody = InitProjectResponseSchema.parse({
      branch: result.branch,
      prUrl: result.prUrl,
      prNumber: result.prNumber,
    })
    return c.json(responseBody)
  })

  app.post('/api/projects/register', async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as unknown
    const body = RegisterProjectBodySchema.parse(raw)
    try {
      const project = await registerProject({ db: deps.db, repoUrl: body.repoUrl })
      deps.scheduler?.reconcileNow()
      const responseBody = RegisterProjectResponseSchema.parse({ project })
      return c.json(responseBody)
    } catch (err) {
      if (isMaestroError(err) && /already registered/.test(err.message)) {
        return c.json(
          { error: { code: 'ALREADY_REGISTERED', message: err.message } },
          409,
        )
      }
      throw err
    }
  })

  app.post('/api/projects/:slug/autonomy', async (c) => {
    const slug = c.req.param('slug')
    const project = projects.findBySlug(slug)
    if (!project) return notFoundProject(c, slug)
    const raw = (await c.req.json().catch(() => ({}))) as unknown
    const body = UpdateAutonomyBodySchema.parse(raw)
    // Deep-merge: nested objects (branches, github) should patch, not
    // replace, so the caller can change just one nested field at a time.
    const merged = AutonomyFileSchema.parse({
      ...project.autonomyConfig,
      ...body,
      branches: {
        ...project.autonomyConfig.branches,
        ...(body.branches ?? {}),
      },
      github: {
        ...project.autonomyConfig.github,
        ...(body.github ?? {}),
      },
    })
    projects.updateAutonomyConfig(slug, merged)
    // The scheduler doesn't track these fields, but reconcileNow is cheap
    // and keeps cron-registration consistent if `level` flipped to
    // 'paused' (skip rule fires on the next tick regardless).
    deps.scheduler?.reconcileNow()
    return c.json({ ok: true })
  })

  app.post('/api/projects/:slug/pause', async (c) => {
    const slug = c.req.param('slug')
    const project = projects.findBySlug(slug)
    if (!project) return notFoundProject(c, slug)
    const raw = (await c.req.json().catch(() => ({}))) as unknown
    const body = PauseProjectBodySchema.parse(raw)
    projects.setAutoPause(slug, body.reason ?? 'manual pause')
    return c.json({ ok: true })
  })

  app.post('/api/projects/:slug/resume', (c) => {
    const slug = c.req.param('slug')
    if (!projects.findBySlug(slug)) return notFoundProject(c, slug)
    projects.clearAutoPause(slug)
    return c.json({ ok: true })
  })

  app.post('/api/projects/:slug/trigger', (c) => {
    const slug = c.req.param('slug')
    const project = projects.findBySlug(slug)
    if (!project) return notFoundProject(c, slug)
    if (!deps.queue) {
      return c.json(
        { error: { code: 'QUEUE_UNAVAILABLE', message: 'queue not wired into server' } },
        503,
      )
    }
    const job = deps.queue.enqueue({
      projectId: project.id,
      source: 'manual',
      priority: JOB_PRIORITY_MANUAL,
    })
    return c.json({ ok: true, jobId: job.id })
  })

  // Phase 5 / Sub 5.3: manual backup. Sits behind Basic Auth like every
  // other non-health route when auth is configured.
  app.post('/api/admin/backup', async (c) => {
    const result = await runBackupNow({ db: deps.db, dataDir: deps.dataDir })
    return c.json({ ok: true, path: result.path, prunedCount: result.prunedCount })
  })

  app.get('/api/queue', (c) => {
    if (!deps.queue) {
      return c.json(QueueResponseSchema.parse({ running: [], queued: [], recentlyCompleted: [] }))
    }
    const snap = deps.queue.snapshot()
    const body = QueueResponseSchema.parse(snap)
    return c.json(body)
  })

  app.get('/api/projects/:slug/skips', (c) => {
    const slug = c.req.param('slug')
    const project = projects.findBySlug(slug)
    if (!project) return notFoundProject(c, slug)
    const limit = parseInt(c.req.query('limit') ?? '20', 10)
    const skips = scheduledRuns.recentForProject(project.id, Number.isFinite(limit) ? limit : 20)
    const body = ListSkipsResponseSchema.parse({ skips })
    return c.json(body)
  })

  // ── Phase 5 / Sub 5.1: static dashboard ─────────────────────────────
  // Registered last so every /api route wins first. Any other GET serves
  // the vite build with an index.html SPA fallback. Unmatched /api GETs
  // still return JSON 404 (the guard below), never HTML.
  if (deps.dashboardDir && existsSync(deps.dashboardDir)) {
    const root = resolvePath(deps.dashboardDir)
    app.get('*', async (c) => {
      const path = c.req.path
      if (path.startsWith('/api')) {
        return c.json({ error: { code: 'NOT_FOUND', message: `No route for ${path}` } }, 404)
      }
      const served = await serveDashboardFile(root, path)
      if (!served) {
        return c.json({ error: { code: 'NOT_FOUND', message: `No route for ${path}` } }, 404)
      }
      return c.body(new Uint8Array(served.body), 200, {
        'content-type': served.contentType,
        'cache-control': served.immutable
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      })
    })
    logger.info({ dashboardDir: root }, 'serving static dashboard')
  }

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `No route for ${c.req.path}` } }, 404),
  )

  return app
}

// ─── Static dashboard helpers (Phase 5 / Sub 5.1) ────────────────────

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

interface ServedFile {
  body: Buffer
  contentType: string
  /** Vite emits content-hashed filenames under /assets — cache forever. */
  immutable: boolean
}

async function serveDashboardFile(root: string, urlPath: string): Promise<ServedFile | null> {
  // Normalize + contain within root. Anything that escapes (.. traversal,
  // encoded slashes) collapses to the SPA fallback or 404 — never a read
  // outside `root`.
  const decoded = decodeURIComponent(urlPath)
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const candidate = resolvePath(join(root, relative))
  if (!candidate.startsWith(root)) return null

  const tryRead = async (filePath: string): Promise<ServedFile | null> => {
    try {
      const info = await stat(filePath)
      if (!info.isFile()) return null
      const body = await readFile(filePath)
      const ext = extname(filePath).toLowerCase()
      return {
        body,
        contentType: STATIC_CONTENT_TYPES[ext] ?? 'application/octet-stream',
        immutable: filePath.includes(`${join(root, 'assets')}`) && ext !== '.html',
      }
    } catch {
      return null
    }
  }

  // Exact file (e.g. /assets/index-abc.js), else SPA fallback for
  // route-ish paths (no extension), else nothing.
  const exact = await tryRead(candidate === root ? join(root, 'index.html') : candidate)
  if (exact) return exact
  if (extname(decoded) === '') return tryRead(join(root, 'index.html'))
  return null
}

function notFoundProject(c: Context, slug: string): Response {
  return c.json(
    { error: { code: 'PROJECT_NOT_FOUND', message: `Unknown project: ${slug}` } },
    404,
  )
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
