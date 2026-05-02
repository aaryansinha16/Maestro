// SQLite repositories for projects, sessions, quality gates, and per-project
// advisory locks. The conductor's "operational" data store. The .maestro/
// files in each managed repo remain the source of truth for project state
// (ADR-003); SQLite tracks runs, costs, and lock ownership.

import type Database from 'better-sqlite3'
import {
  ProjectSchema,
  SessionSchema,
  QualityGateRunSchema,
  JobSchema,
  ScheduledRunSchema,
  type Project,
  type ProjectAutonomyConfig,
  type Session,
  type SessionStatus,
  type TerminationCause,
  type QualityGateRun,
  type QualityGate,
  type QualityGateStatus,
  type Job,
  type JobSource,
  type JobStatus,
  type ScheduledRun,
  type ScheduledRunAction,
  type ScheduleSkipReason,
  MaestroError,
} from '@maestro/shared'

// ─── Projects ────────────────────────────────────────────────────────

interface ProjectRow {
  id: string
  slug: string
  repo_url: string
  autonomy_config_json: string
  created_at: string
  // Phase 2 — added by migration 003.
  scheduled_enabled: number
  auto_paused_at: string | null
  auto_pause_reason: string | null
}

export interface CreateProjectInput {
  id: string
  slug: string
  repoUrl: string
  autonomyConfig: ProjectAutonomyConfig
}

export class ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateProjectInput): Project {
    // The autonomy.json controls scheduledEnabled at the file level; the
    // row column mirrors it. Phase 2 ships every existing/new project at
    // scheduledEnabled=false (umbrella #17 hard requirement) so the
    // developer enables scheduling explicitly per project.
    const scheduledEnabled = input.autonomyConfig.scheduledEnabled ? 1 : 0
    const stmt = this.db.prepare(`
      INSERT INTO projects (id, slug, repo_url, autonomy_config_json, scheduled_enabled)
      VALUES (?, ?, ?, ?, ?)
    `)
    try {
      stmt.run(
        input.id,
        input.slug,
        input.repoUrl,
        JSON.stringify(input.autonomyConfig),
        scheduledEnabled,
      )
    } catch (err) {
      throw new MaestroError('CONFIG_VALIDATION_FAILED', {
        message: `Failed to insert project ${input.slug}`,
        cause: err,
        context: { slug: input.slug },
      })
    }
    const row = this.findBySlug(input.slug)
    if (!row) throw new MaestroError('INTERNAL_ERROR', { message: 'project insert succeeded but row missing' })
    return row
  }

  findBySlug(slug: string): Project | null {
    const row = this.db
      .prepare<[string], ProjectRow>('SELECT * FROM projects WHERE slug = ?')
      .get(slug)
    return row ? rowToProject(row) : null
  }

  findById(id: string): Project | null {
    const row = this.db
      .prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?')
      .get(id)
    return row ? rowToProject(row) : null
  }

  list(): Project[] {
    const rows = this.db
      .prepare<[], ProjectRow>('SELECT * FROM projects ORDER BY created_at DESC')
      .all()
    return rows.map(rowToProject)
  }

  /**
   * Phase 2: list only projects with scheduling enabled and not in an
   * auto-pause state. The scheduler reads this every poll cycle.
   */
  listSchedulable(): Project[] {
    const rows = this.db
      .prepare<[], ProjectRow>(
        `SELECT * FROM projects WHERE scheduled_enabled = 1 AND auto_paused_at IS NULL`,
      )
      .all()
    return rows.map(rowToProject)
  }

  setScheduledEnabled(slug: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE projects SET scheduled_enabled = ? WHERE slug = ?')
      .run(enabled ? 1 : 0, slug)
  }

  /**
   * Persist a config edit (e.g. schedule string change, priority bump).
   * Mirrors the autonomy.json file but only at the row level — the file
   * itself lives in the managed repo and is the source of truth (ADR-004).
   */
  updateAutonomyConfig(slug: string, config: ProjectAutonomyConfig): void {
    this.db
      .prepare(
        'UPDATE projects SET autonomy_config_json = ?, scheduled_enabled = ? WHERE slug = ?',
      )
      .run(JSON.stringify(config), config.scheduledEnabled ? 1 : 0, slug)
  }

  setAutoPause(slug: string, reason: string): void {
    this.db
      .prepare(
        'UPDATE projects SET auto_paused_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\'), auto_pause_reason = ? WHERE slug = ?',
      )
      .run(reason, slug)
  }

  clearAutoPause(slug: string): void {
    this.db
      .prepare(
        'UPDATE projects SET auto_paused_at = NULL, auto_pause_reason = NULL WHERE slug = ?',
      )
      .run(slug)
  }

  delete(slug: string): void {
    this.db.prepare('DELETE FROM projects WHERE slug = ?').run(slug)
  }
}

function rowToProject(row: ProjectRow): Project {
  return ProjectSchema.parse({
    id: row.id,
    slug: row.slug,
    repoUrl: row.repo_url,
    autonomyConfig: JSON.parse(row.autonomy_config_json) as unknown,
    createdAt: row.created_at,
    scheduledEnabled: row.scheduled_enabled === 1,
    autoPausedAt: row.auto_paused_at,
    autoPauseReason: row.auto_pause_reason,
  })
}

// ─── Sessions ────────────────────────────────────────────────────────

interface SessionRow {
  id: string
  project_id: string
  status: SessionStatus
  started_at: string
  ended_at: string | null
  cost_cents: number | null
  prompt_version: string
  model_used: string | null
  branch_name: string | null
  pr_number: number | null
  pr_url: string | null
  journal_path: string | null
  log_path: string | null
  termination_cause: TerminationCause | null
  is_fixup_turn: number
  parent_session_id: string | null
}

export interface CreateSessionInput {
  id: string
  projectId: string
  promptVersion: string
  isFixupTurn?: boolean
  parentSessionId?: string | null
}

export interface UpdateSessionInput {
  status?: SessionStatus
  endedAt?: string | null
  costCents?: number | null
  modelUsed?: string | null
  branchName?: string | null
  prNumber?: number | null
  prUrl?: string | null
  journalPath?: string | null
  logPath?: string | null
  terminationCause?: TerminationCause | null
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateSessionInput): Session {
    const startedAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, status, started_at, prompt_version, is_fixup_turn, parent_session_id)
         VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        startedAt,
        input.promptVersion,
        input.isFixupTurn ? 1 : 0,
        input.parentSessionId ?? null,
      )
    const row = this.findById(input.id)
    if (!row) throw new MaestroError('INTERNAL_ERROR', { message: 'session insert lost' })
    return row
  }

  update(id: string, patch: UpdateSessionInput): Session {
    const setParts: string[] = []
    const values: Array<string | number | null> = []
    const map: Record<string, keyof UpdateSessionInput> = {
      status: 'status',
      ended_at: 'endedAt',
      cost_cents: 'costCents',
      model_used: 'modelUsed',
      branch_name: 'branchName',
      pr_number: 'prNumber',
      pr_url: 'prUrl',
      journal_path: 'journalPath',
      log_path: 'logPath',
      termination_cause: 'terminationCause',
    }
    for (const column of Object.keys(map)) {
      const key = map[column]
      if (key === undefined) continue
      const value = patch[key]
      if (value === undefined) continue
      setParts.push(`${column} = ?`)
      values.push(value)
    }
    if (setParts.length === 0) {
      const existing = this.findById(id)
      if (!existing) throw new MaestroError('INTERNAL_ERROR', { message: `session ${id} missing` })
      return existing
    }
    values.push(id)
    this.db.prepare(`UPDATE sessions SET ${setParts.join(', ')} WHERE id = ?`).run(...values)
    const row = this.findById(id)
    if (!row) throw new MaestroError('INTERNAL_ERROR', { message: `session ${id} missing after update` })
    return row
  }

  findById(id: string): Session | null {
    const row = this.db
      .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
      .get(id)
    return row ? rowToSession(row) : null
  }

  list(opts: { projectId?: string; limit?: number; offset?: number } = {}): {
    sessions: Session[]
    total: number
  } {
    const where = opts.projectId ? 'WHERE project_id = ?' : ''
    const params = opts.projectId ? [opts.projectId] : []
    const total = (
      this.db
        .prepare<typeof params, { count: number }>(`SELECT COUNT(*) AS count FROM sessions ${where}`)
        .get(...params) as { count: number }
    ).count
    const limit = opts.limit ?? 50
    const offset = opts.offset ?? 0
    const rows = this.db
      .prepare<[...typeof params, number, number], SessionRow>(
        `SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
    return { sessions: rows.map(rowToSession), total }
  }
}

// ─── Aggregations (Phase 1.5 cost tracking) ─────────────────────────

export interface CostAggregations {
  /** Sum of cost_cents for completed sessions in the rolling 30 days. */
  monthCents: number
  /** Sum of cost_cents today (UTC). */
  todayCents: number
  /** Per-project breakdown for the rolling 30-day window. */
  perProject: Array<{
    projectId: string
    projectSlug: string
    sessionCount: number
    monthCents: number
    /** Sessions that produced a merged-style PR (status=completed && pr_number IS NOT NULL). */
    prCount: number
    /** Cost ÷ PRs (the "did Maestro earn its keep?" metric). null when no PRs. */
    centsPerPr: number | null
  }>
  /** 30 days of daily totals, oldest → newest. Includes zero-cost days. */
  dailySeries: Array<{ date: string; cents: number }>
}

interface PerProjectRow {
  project_id: string
  project_slug: string
  session_count: number
  month_cents: number
  pr_count: number
}

interface DailyRow {
  day: string
  cents: number
}

export class CostRepository {
  constructor(private readonly db: Database.Database) {}

  aggregate(): CostAggregations {
    const monthCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const todayCutoff = todayStart.toISOString()

    const monthCents =
      (
        this.db
          .prepare<[string], { sum: number | null }>(
            'SELECT COALESCE(SUM(cost_cents), 0) AS sum FROM sessions WHERE started_at >= ?',
          )
          .get(monthCutoff) as { sum: number | null }
      ).sum ?? 0

    const todayCents =
      (
        this.db
          .prepare<[string], { sum: number | null }>(
            'SELECT COALESCE(SUM(cost_cents), 0) AS sum FROM sessions WHERE started_at >= ?',
          )
          .get(todayCutoff) as { sum: number | null }
      ).sum ?? 0

    const perProjectRows = this.db
      .prepare<[string], PerProjectRow>(
        `SELECT
           p.id AS project_id,
           p.slug AS project_slug,
           COUNT(s.id) AS session_count,
           COALESCE(SUM(s.cost_cents), 0) AS month_cents,
           SUM(CASE WHEN s.pr_number IS NOT NULL THEN 1 ELSE 0 END) AS pr_count
         FROM projects p
         LEFT JOIN sessions s
           ON s.project_id = p.id AND s.started_at >= ?
         GROUP BY p.id, p.slug
         ORDER BY month_cents DESC`,
      )
      .all(monthCutoff)

    const perProject = perProjectRows.map((r) => ({
      projectId: r.project_id,
      projectSlug: r.project_slug,
      sessionCount: r.session_count,
      monthCents: r.month_cents,
      prCount: r.pr_count,
      centsPerPr: r.pr_count > 0 ? Math.round(r.month_cents / r.pr_count) : null,
    }))

    const dailyRows = this.db
      .prepare<[string], DailyRow>(
        `SELECT substr(started_at, 1, 10) AS day, COALESCE(SUM(cost_cents), 0) AS cents
         FROM sessions
         WHERE started_at >= ?
         GROUP BY day
         ORDER BY day`,
      )
      .all(monthCutoff)

    const dailySeries = padDailySeries(dailyRows, monthCutoff)

    return { monthCents, todayCents, perProject, dailySeries }
  }
}

function padDailySeries(
  rows: DailyRow[],
  cutoffIso: string,
): Array<{ date: string; cents: number }> {
  const byDay = new Map(rows.map((r) => [r.day, r.cents]))
  const result: Array<{ date: string; cents: number }> = []
  const cutoffDate = new Date(cutoffIso)
  cutoffDate.setUTCHours(0, 0, 0, 0)
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  for (let d = new Date(cutoffDate); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10)
    result.push({ date: key, cents: byDay.get(key) ?? 0 })
  }
  return result
}

function rowToSession(row: SessionRow): Session {
  return SessionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    costCents: row.cost_cents,
    promptVersion: row.prompt_version,
    modelUsed: row.model_used,
    branchName: row.branch_name,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    journalPath: row.journal_path,
    logPath: row.log_path,
    terminationCause: row.termination_cause,
    isFixupTurn: row.is_fixup_turn === 1,
    parentSessionId: row.parent_session_id,
  })
}

// ─── Quality gate runs ───────────────────────────────────────────────

interface QualityGateRow {
  id: number
  session_id: string
  gate_name: QualityGate
  status: QualityGateStatus
  output: string
  duration_ms: number | null
  ran_at: string
}

export interface RecordQualityGateInput {
  sessionId: string
  gateName: QualityGate
  status: QualityGateStatus
  output: string
  durationMs: number | null
}

export class QualityGateRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: RecordQualityGateInput): void {
    this.db
      .prepare(
        `INSERT INTO quality_gate_runs (session_id, gate_name, status, output, duration_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.sessionId, input.gateName, input.status, input.output, input.durationMs)
  }

  listForSession(sessionId: string): QualityGateRun[] {
    const rows = this.db
      .prepare<[string], QualityGateRow>(
        'SELECT * FROM quality_gate_runs WHERE session_id = ? ORDER BY ran_at',
      )
      .all(sessionId)
    return rows.map((row) =>
      QualityGateRunSchema.parse({
        id: String(row.id),
        sessionId: row.session_id,
        gateName: row.gate_name,
        status: row.status,
        output: row.output,
        ranAt: row.ran_at,
        durationMs: row.duration_ms ?? undefined,
      }),
    )
  }
}

// ─── Phase 2: job queue ──────────────────────────────────────────────

interface JobRow {
  id: string
  project_id: string
  source: JobSource
  priority: number
  status: JobStatus
  enqueued_at: string
  started_at: string | null
  ended_at: string | null
  session_id: string | null
  cancel_reason: string | null
}

export interface CreateJobInput {
  id: string
  projectId: string
  source: JobSource
  priority: number
}

export interface UpdateJobInput {
  status?: JobStatus
  startedAt?: string | null
  endedAt?: string | null
  sessionId?: string | null
  cancelReason?: string | null
}

export class JobQueueRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateJobInput): Job {
    this.db
      .prepare(
        `INSERT INTO job_queue (id, project_id, source, priority, status)
         VALUES (?, ?, ?, ?, 'queued')`,
      )
      .run(input.id, input.projectId, input.source, input.priority)
    const row = this.findById(input.id)
    if (!row) throw new MaestroError('INTERNAL_ERROR', { message: 'job insert lost' })
    return row
  }

  findById(id: string): Job | null {
    const row = this.db
      .prepare<[string], JobRow>('SELECT * FROM job_queue WHERE id = ?')
      .get(id)
    return row ? rowToJob(row) : null
  }

  /**
   * Job-queue ordering: status='queued' first, then by priority DESC,
   * then by enqueued_at ASC (FIFO within priority class). The scheduler
   * iterates this and picks the next eligible job.
   */
  listQueued(): Job[] {
    const rows = this.db
      .prepare<[], JobRow>(
        `SELECT * FROM job_queue WHERE status = 'queued'
         ORDER BY priority DESC, enqueued_at ASC`,
      )
      .all()
    return rows.map(rowToJob)
  }

  listRunning(): Job[] {
    const rows = this.db
      .prepare<[], JobRow>(`SELECT * FROM job_queue WHERE status = 'running'`)
      .all()
    return rows.map(rowToJob)
  }

  /** Sessions completed in the last `since` ms — used by the dashboard. */
  listRecent(since: Date): Job[] {
    const rows = this.db
      .prepare<[string], JobRow>(
        `SELECT * FROM job_queue
         WHERE ended_at IS NOT NULL AND ended_at >= ?
         ORDER BY ended_at DESC`,
      )
      .all(since.toISOString())
    return rows.map(rowToJob)
  }

  countQueuedForProject(projectId: string): number {
    return (
      this.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM job_queue WHERE project_id = ? AND status = 'queued'`,
        )
        .get(projectId) as { c: number }
    ).c
  }

  hasRunningForProject(projectId: string): boolean {
    return (
      (
        this.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM job_queue WHERE project_id = ? AND status = 'running'`,
          )
          .get(projectId) as { c: number }
      ).c > 0
    )
  }

  update(id: string, patch: UpdateJobInput): Job {
    const setParts: string[] = []
    const values: Array<string | null> = []
    const map: Record<string, keyof UpdateJobInput> = {
      status: 'status',
      started_at: 'startedAt',
      ended_at: 'endedAt',
      session_id: 'sessionId',
      cancel_reason: 'cancelReason',
    }
    for (const column of Object.keys(map)) {
      const key = map[column]
      if (key === undefined) continue
      const value = patch[key]
      if (value === undefined) continue
      setParts.push(`${column} = ?`)
      values.push(value)
    }
    if (setParts.length === 0) {
      const existing = this.findById(id)
      if (!existing) throw new MaestroError('INTERNAL_ERROR', { message: `job ${id} missing` })
      return existing
    }
    values.push(id)
    this.db.prepare(`UPDATE job_queue SET ${setParts.join(', ')} WHERE id = ?`).run(...values)
    const row = this.findById(id)
    if (!row) throw new MaestroError('INTERNAL_ERROR', { message: `job ${id} missing after update` })
    return row
  }

  /**
   * Crash recovery: any rows still in 'running' from a previous boot are
   * orphaned. Mark them cancelled with reason 'conductor-restart' so a
   * fresh boot doesn't think those slots are still occupied.
   * Returns the number of jobs reclaimed.
   */
  cancelStaleOnBoot(): number {
    const result = this.db
      .prepare(
        `UPDATE job_queue
           SET status = 'cancelled',
               ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               cancel_reason = 'conductor-restart'
         WHERE status = 'running'`,
      )
      .run()
    return result.changes
  }
}

function rowToJob(row: JobRow): Job {
  return JobSchema.parse({
    id: row.id,
    projectId: row.project_id,
    source: row.source,
    status: row.status,
    priority: row.priority,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sessionId: row.session_id,
    cancelReason: row.cancel_reason,
  })
}

// ─── Phase 2: scheduled-runs audit log ───────────────────────────────

interface ScheduledRunRow {
  id: number
  project_id: string
  scheduled_at: string
  fired_at: string
  action: ScheduledRunAction
  skip_reason: ScheduleSkipReason | null
  job_id: string | null
  notes: string | null
}

export interface RecordScheduledRunInput {
  projectId: string
  scheduledAt: string
  action: ScheduledRunAction
  skipReason?: ScheduleSkipReason | null
  jobId?: string | null
  notes?: string | null
}

export class ScheduledRunsRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: RecordScheduledRunInput): ScheduledRun {
    this.db
      .prepare(
        `INSERT INTO scheduled_runs (project_id, scheduled_at, action, skip_reason, job_id, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.scheduledAt,
        input.action,
        input.skipReason ?? null,
        input.jobId ?? null,
        input.notes ?? null,
      )
    const row = this.db
      .prepare<[], ScheduledRunRow>('SELECT * FROM scheduled_runs ORDER BY id DESC LIMIT 1')
      .get()
    if (!row) throw new MaestroError('INTERNAL_ERROR', { message: 'scheduled_runs insert lost' })
    return rowToScheduledRun(row)
  }

  recentForProject(projectId: string, limit = 20): ScheduledRun[] {
    const rows = this.db
      .prepare<[string, number], ScheduledRunRow>(
        `SELECT * FROM scheduled_runs WHERE project_id = ?
         ORDER BY fired_at DESC LIMIT ?`,
      )
      .all(projectId, limit)
    return rows.map(rowToScheduledRun)
  }

  /**
   * Counts of {scheduled, ran, skipped} from today (UTC) — feeds the
   * dashboard Overview stats card.
   */
  todaySummary(): { scheduled: number; enqueued: number; skipped: number } {
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const since = todayStart.toISOString()
    const total = (
      this.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM scheduled_runs WHERE fired_at >= ?`,
        )
        .get(since) as { c: number }
    ).c
    const enqueued = (
      this.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM scheduled_runs WHERE fired_at >= ? AND action = 'enqueued'`,
        )
        .get(since) as { c: number }
    ).c
    const skipped = (
      this.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM scheduled_runs WHERE fired_at >= ? AND action = 'skipped'`,
        )
        .get(since) as { c: number }
    ).c
    return { scheduled: total, enqueued, skipped }
  }
}

function rowToScheduledRun(row: ScheduledRunRow): ScheduledRun {
  return ScheduledRunSchema.parse({
    id: row.id,
    projectId: row.project_id,
    scheduledAt: row.scheduled_at,
    firedAt: row.fired_at,
    action: row.action,
    skipReason: row.skip_reason,
    jobId: row.job_id,
    notes: row.notes,
  })
}
