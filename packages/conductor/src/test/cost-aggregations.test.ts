// Phase 1.5 cost aggregations: confirms the SQL layer rolls up costs
// correctly across the rolling 30-day window and produces a daily series
// padded with zero-cost days.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type DbHandle } from '../db.js'
import {
  CostRepository,
  ProjectRepository,
  SessionRepository,
} from '../repositories.js'
import { DEFAULT_AUTONOMY_CONFIG } from '@maestro/shared'

let h: { db: DbHandle; root: string } | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-cost-'))
  const db = openDatabase({ dataDir: root })
  h = { db, root }
})

afterEach(async () => {
  if (h) {
    h.db.close()
    await rm(h.root, { recursive: true, force: true })
    h = null
  }
})

describe('CostRepository.aggregate()', () => {
  it('rolls up monthly + today + per-project + daily series', () => {
    if (!h) throw new Error('harness missing')
    const projects = new ProjectRepository(h.db.db)
    const sessions = new SessionRepository(h.db.db)
    const costs = new CostRepository(h.db.db)

    const projA = projects.insert({
      id: randomUUID(),
      slug: 'project-a',
      repoUrl: 'https://github.com/example/a',
      autonomyConfig: DEFAULT_AUTONOMY_CONFIG,
    })
    const projB = projects.insert({
      id: randomUUID(),
      slug: 'project-b',
      repoUrl: 'https://github.com/example/b',
      autonomyConfig: DEFAULT_AUTONOMY_CONFIG,
    })

    // Today: project-a, $0.50, with PR
    const todayId = randomUUID()
    sessions.insert({ id: todayId, projectId: projA.id, promptVersion: '1.1.0' })
    sessions.update(todayId, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      costCents: 50,
      prNumber: 1,
      branchName: 'maestro/a/today',
    })

    // 5 days ago: project-a, $0.20, no PR
    h.db.db.prepare(
      `UPDATE sessions SET started_at = ?, cost_cents = ?, status = 'completed' WHERE id = ?`,
    )
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString()
    const oldA = randomUUID()
    sessions.insert({ id: oldA, projectId: projA.id, promptVersion: '1.1.0' })
    h.db.db
      .prepare(
        'UPDATE sessions SET started_at = ?, cost_cents = ?, status = ? WHERE id = ?',
      )
      .run(fiveDaysAgo, 20, 'completed', oldA)

    // Yesterday: project-b, $0.80, with PR
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const oldB = randomUUID()
    sessions.insert({ id: oldB, projectId: projB.id, promptVersion: '1.1.0' })
    h.db.db
      .prepare(
        'UPDATE sessions SET started_at = ?, cost_cents = ?, status = ?, pr_number = ? WHERE id = ?',
      )
      .run(yesterday, 80, 'completed', 7, oldB)

    // > 30 days ago: should be excluded
    const ancientId = randomUUID()
    sessions.insert({ id: ancientId, projectId: projA.id, promptVersion: '1.1.0' })
    h.db.db
      .prepare(
        'UPDATE sessions SET started_at = ?, cost_cents = ?, status = ? WHERE id = ?',
      )
      .run(
        new Date(Date.now() - 60 * 86_400_000).toISOString(),
        9999,
        'completed',
        ancientId,
      )

    const agg = costs.aggregate()

    // Month total: 50 + 20 + 80 = 150 (ancient excluded)
    expect(agg.monthCents).toBe(150)
    // Today total: 50
    expect(agg.todayCents).toBe(50)

    // Per-project: a=70 (1 PR), b=80 (1 PR), with prCount + centsPerPr
    const a = agg.perProject.find((p) => p.projectSlug === 'project-a')
    const b = agg.perProject.find((p) => p.projectSlug === 'project-b')
    expect(a?.monthCents).toBe(70)
    expect(a?.prCount).toBe(1)
    expect(a?.centsPerPr).toBe(70)
    expect(b?.monthCents).toBe(80)
    expect(b?.prCount).toBe(1)
    expect(b?.centsPerPr).toBe(80)

    // Daily series spans the full 30-day window with zeroes filled.
    expect(agg.dailySeries.length).toBeGreaterThanOrEqual(30)
    const today = new Date().toISOString().slice(0, 10)
    const todayBucket = agg.dailySeries.find((d) => d.date === today)
    expect(todayBucket?.cents).toBe(50)
  })

  it('returns zeros when the database is empty', () => {
    if (!h) throw new Error('harness missing')
    const costs = new CostRepository(h.db.db)
    const agg = costs.aggregate()
    expect(agg.monthCents).toBe(0)
    expect(agg.todayCents).toBe(0)
    expect(agg.perProject).toEqual([])
    expect(agg.dailySeries.every((d) => d.cents === 0)).toBe(true)
  })
})
