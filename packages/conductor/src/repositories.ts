// SQLite repositories for projects, sessions, quality gates, and per-project
// advisory locks. The conductor's "operational" data store. The .maestro/
// files in each managed repo remain the source of truth for project state
// (ADR-003); SQLite tracks runs, costs, and lock ownership.

import type Database from 'better-sqlite3'
import {
  ProjectSchema,
  SessionSchema,
  QualityGateRunSchema,
  type Project,
  type ProjectAutonomyConfig,
  type Session,
  type SessionStatus,
  type TerminationCause,
  type QualityGateRun,
  type QualityGate,
  type QualityGateStatus,
  MaestroError,
} from '@maestro/shared'

// ─── Projects ────────────────────────────────────────────────────────

interface ProjectRow {
  id: string
  slug: string
  repo_url: string
  autonomy_config_json: string
  created_at: string
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
    const stmt = this.db.prepare(`
      INSERT INTO projects (id, slug, repo_url, autonomy_config_json)
      VALUES (?, ?, ?, ?)
    `)
    try {
      stmt.run(input.id, input.slug, input.repoUrl, JSON.stringify(input.autonomyConfig))
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
