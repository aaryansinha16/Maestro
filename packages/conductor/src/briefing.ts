// Phase 5 / Sub 5.4 — daily Telegram briefing.
//
// One digest per UTC day at MAESTRO_BRIEFING_TIME (default 08:00 in
// MAESTRO_TZ): last-24h sessions per project, PRs opened, pending PR
// feedback, paused projects, spend vs budget. Sent via the fetch-based
// telegram client with dashboard deep-link buttons (callback buttons are
// Phase 6). Dedupe across restarts comes from the briefings table —
// existsForUtcDay guards the cron tick, so a crash-loop can't spam.
//
// `maestro briefing preview|send` and the cron tick share generate/send.

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import cron from 'node-cron'
import type { Config } from './config.js'
import { logger } from './logger.js'
import {
  BriefingRepository,
  CostRepository,
  PrFeedbackRepository,
  ProjectRepository,
  SessionRepository,
} from './repositories.js'
import { escapeHtml, sendTelegramMessage } from './telegram.js'

// ─── Digest generation ───────────────────────────────────────────────

export interface GenerateBriefingInput {
  db: Database.Database
  /** Injectable clock for deterministic tests. */
  now?: () => Date
  /** Dashboard base URL for deep links (default localhost). */
  dashboardUrl?: string
}

export interface GeneratedBriefing {
  /** HTML for Telegram parse_mode=HTML. */
  text: string
  /** Counters the tests assert on and the log line reports. */
  summary: {
    projects: number
    sessions24h: number
    prsOpened24h: number
    pendingFeedback: number
    pausedProjects: number
    monthCents: number
  }
}

export function generateBriefing(input: GenerateBriefingInput): GeneratedBriefing {
  const now = (input.now ?? (() => new Date()))()
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  const projects = new ProjectRepository(input.db).list()
  const sessions = new SessionRepository(input.db)
  const feedback = new PrFeedbackRepository(input.db)
  const costs = new CostRepository(input.db).aggregate()

  const lines: string[] = []
  lines.push(`<b>Maestro briefing — ${now.toISOString().slice(0, 10)}</b>`)
  lines.push('')

  let sessions24h = 0
  let prsOpened24h = 0
  let pendingFeedback = 0
  let pausedProjects = 0

  if (projects.length === 0) {
    lines.push('No projects registered yet.')
  }

  for (const project of projects) {
    const recent = sessions
      .list({ projectId: project.id, limit: 50 })
      .sessions.filter((s) => s.startedAt >= cutoff && !s.isFixupTurn)
    const prs = recent.filter((s) => s.prNumber !== null)
    const failed = recent.filter(
      (s) => s.status !== 'completed' && s.status !== 'completed-no-changes',
    )
    const pending = feedback.pendingCount(project.id)
    const paused = project.autoPausedAt !== null || project.autonomyConfig.level === 'paused'

    sessions24h += recent.length
    prsOpened24h += prs.length
    pendingFeedback += pending
    if (paused) pausedProjects += 1

    const bits: string[] = []
    if (recent.length > 0) bits.push(`${recent.length} session${recent.length === 1 ? '' : 's'}`)
    if (prs.length > 0) {
      bits.push(
        `PR${prs.length === 1 ? '' : 's'} ${prs.map((s) => `#${s.prNumber}`).join(', ')}`,
      )
    }
    if (failed.length > 0) bits.push(`⚠ ${failed.length} failed`)
    if (pending > 0) bits.push(`💬 ${pending} feedback pending`)
    if (paused) bits.push('⏸ paused')
    if (bits.length === 0) bits.push('quiet')

    lines.push(`• <b>${escapeHtml(project.slug)}</b> — ${escapeHtml(bits.join(' · '))}`)
  }

  lines.push('')
  const spend = (costs.monthCents / 100).toFixed(2)
  // Same env skip-rule E reads; the repo layer is budget-agnostic.
  const budgetUsd = Number(process.env['MAESTRO_BUDGET_USD'] ?? 50)
  if (Number.isFinite(budgetUsd) && budgetUsd > 0) {
    const pct = Math.round((costs.monthCents / (budgetUsd * 100)) * 100)
    lines.push(`💰 $${spend} this month (${pct}% of $${budgetUsd} budget)`)
  } else {
    lines.push(`💰 $${spend} this month`)
  }

  return {
    text: lines.join('\n'),
    summary: {
      projects: projects.length,
      sessions24h,
      prsOpened24h,
      pendingFeedback,
      pausedProjects,
      monthCents: costs.monthCents,
    },
  }
}

// ─── Sending ─────────────────────────────────────────────────────────

export interface SendBriefingInput {
  db: Database.Database
  config: Config
  /** Send even if one already went out today. CLI `--force`. */
  force?: boolean
  now?: () => Date
  fetchImpl?: typeof fetch
  dashboardUrl?: string
}

export type SendBriefingResult =
  | { status: 'sent'; messageId: string }
  | { status: 'recorded-no-telegram' }
  | { status: 'skipped-already-sent' }

export async function sendDailyBriefing(
  input: SendBriefingInput,
): Promise<SendBriefingResult> {
  const now = (input.now ?? (() => new Date()))()
  const briefings = new BriefingRepository(input.db)
  const day = now.toISOString().slice(0, 10)

  if (!input.force && briefings.existsForUtcDay(day)) {
    logger.debug({ day }, 'briefing already sent today — skipping')
    return { status: 'skipped-already-sent' }
  }

  const generated = generateBriefing({
    db: input.db,
    ...(input.now ? { now: input.now } : {}),
    ...(input.dashboardUrl ? { dashboardUrl: input.dashboardUrl } : {}),
  })

  const { telegramBotToken, telegramChatId } = input.config
  if (!telegramBotToken || !telegramChatId) {
    // No Telegram configured: record the digest so history works and the
    // cron doesn't regenerate every tick — but make the gap visible.
    briefings.insert({ id: randomUUID(), content: generated.text, tgMessageId: null })
    logger.info(generated.summary, 'briefing generated (telegram not configured)')
    return { status: 'recorded-no-telegram' }
  }

  const dashboardUrl = (input.dashboardUrl ?? 'http://localhost:3000').replace(/\/$/, '')
  const sent = await sendTelegramMessage({
    botToken: telegramBotToken,
    chatId: telegramChatId,
    text: generated.text,
    urlButtons: [
      { text: 'Open dashboard', url: dashboardUrl },
      { text: 'PRs', url: `${dashboardUrl}/prs` },
      { text: 'Costs', url: `${dashboardUrl}/costs` },
    ],
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  })
  briefings.insert({ id: randomUUID(), content: generated.text, tgMessageId: sent.messageId })
  logger.info({ ...generated.summary, messageId: sent.messageId }, 'briefing sent')
  return { status: 'sent', messageId: sent.messageId }
}

// ─── Cron wiring ─────────────────────────────────────────────────────

export interface BriefingDeps {
  db: Database.Database
  config: Config
  cronImpl?: Pick<typeof cron, 'schedule'>
  fetchImpl?: typeof fetch
}

export interface BriefingHandle {
  stop(): void
}

export function startBriefing(deps: BriefingDeps): BriefingHandle {
  const time = deps.config.briefingTime
  const [hh = '08', mm = '00'] = time.split(':')
  const expr = `${Number(mm)} ${Number(hh)} * * *`
  const timezone = process.env['MAESTRO_TZ'] ?? 'UTC'
  const impl = deps.cronImpl ?? cron

  const task = impl.schedule(
    expr,
    () => {
      void sendDailyBriefing({
        db: deps.db,
        config: deps.config,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        dashboardUrl:
          process.env['MAESTRO_DASHBOARD_URL'] ?? `http://localhost:${deps.config.port}`,
      }).catch((err) => {
        logger.error({ err }, 'briefing tick failed')
      })
    },
    { timezone },
  )
  logger.info({ time, timezone }, 'briefing scheduled')
  return { stop: () => task.stop() }
}
