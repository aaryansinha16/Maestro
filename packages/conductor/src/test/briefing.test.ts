// Phase 5 / Sub 5.4 — briefing generation, dedupe, telegram client.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type DbHandle } from '../db.js'
import {
  BriefingRepository,
  PrFeedbackRepository,
  ProjectRepository,
  SessionRepository,
} from '../repositories.js'
import { generateBriefing, sendDailyBriefing } from '../briefing.js'
import { escapeHtml, sendTelegramMessage } from '../telegram.js'
import { DEFAULT_AUTONOMY_CONFIG } from '@maestro/shared'
import type { Config } from '../config.js'

interface Harness {
  db: DbHandle
  root: string
}
let h: Harness | null = null

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-brief-'))
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

const CONFIG_NO_TG: Config = {
  port: 0,
  dataDir: '/tmp/x',
  developerName: 'Tester',
  developerGithubUsername: 'tester',
  briefingTime: '08:00',
  nodeEnv: 'test',
}

function seedProject(slug: string, opts: { paused?: boolean } = {}): string {
  if (!h) throw new Error('harness missing')
  const id = randomUUID()
  const projects = new ProjectRepository(h.db.db)
  projects.insert({
    id,
    slug,
    repoUrl: `https://github.com/example/${slug}`,
    autonomyConfig: { ...DEFAULT_AUTONOMY_CONFIG },
  })
  if (opts.paused) projects.setAutoPause(slug, 'test pause')
  return id
}

function seedSession(projectId: string, opts: { prNumber?: number; failed?: boolean } = {}) {
  if (!h) throw new Error('harness missing')
  const sessions = new SessionRepository(h.db.db)
  const id = randomUUID()
  sessions.insert({ id, projectId, promptVersion: '1.2.0' })
  sessions.update(id, {
    status: opts.failed ? 'failed' : 'completed',
    endedAt: new Date().toISOString(),
    prNumber: opts.prNumber ?? null,
    costCents: 12,
  })
}

describe('generateBriefing', () => {
  it('renders per-project lines with sessions, PRs, feedback, pauses, spend', () => {
    if (!h) throw new Error('harness missing')
    const active = seedProject('active-app')
    seedSession(active, { prNumber: 42 })
    seedSession(active, { failed: true })
    const paused = seedProject('paused-app', { paused: true })
    void paused
    new PrFeedbackRepository(h.db.db).upsert({
      projectId: active,
      prNumber: 42,
      prBranch: 'maestro/active-app/x',
      commentId: 1,
      commentBody: 'rename this',
      commentAuthor: 'tester',
      postedAt: new Date().toISOString(),
    })

    const out = generateBriefing({ db: h.db.db })
    expect(out.text).toContain('active-app')
    expect(out.text).toContain('PR #42')
    expect(out.text).toContain('1 failed')
    expect(out.text).toContain('1 feedback pending')
    expect(out.text).toContain('paused-app')
    expect(out.text).toContain('⏸ paused')
    expect(out.text).toContain('💰 $0.24 this month')
    expect(out.summary).toMatchObject({
      projects: 2,
      sessions24h: 2,
      prsOpened24h: 1,
      pendingFeedback: 1,
      pausedProjects: 1,
      monthCents: 24,
    })
  })

  it('handles an empty database', () => {
    if (!h) throw new Error('harness missing')
    const out = generateBriefing({ db: h.db.db })
    expect(out.text).toContain('No projects registered yet.')
    expect(out.summary.projects).toBe(0)
  })
})

describe('sendDailyBriefing', () => {
  it('records without telegram config, then dedupes the same UTC day', async () => {
    if (!h) throw new Error('harness missing')
    const first = await sendDailyBriefing({ db: h.db.db, config: CONFIG_NO_TG })
    expect(first.status).toBe('recorded-no-telegram')
    const second = await sendDailyBriefing({ db: h.db.db, config: CONFIG_NO_TG })
    expect(second.status).toBe('skipped-already-sent')
    // force bypasses dedupe
    const third = await sendDailyBriefing({ db: h.db.db, config: CONFIG_NO_TG, force: true })
    expect(third.status).toBe('recorded-no-telegram')
    expect(new BriefingRepository(h.db.db).latest()).not.toBeNull()
  })

  it('sends via telegram when configured and stores the message id', async () => {
    if (!h) throw new Error('harness missing')
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const result = await sendDailyBriefing({
      db: h.db.db,
      config: { ...CONFIG_NO_TG, telegramBotToken: 'bot-token', telegramChatId: '12345' },
      fetchImpl,
      dashboardUrl: 'https://maestro.example.com',
    })
    expect(result).toEqual({ status: 'sent', messageId: '777' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('api.telegram.org/botbot-token/sendMessage')
    const body = calls[0]?.body as {
      chat_id: string
      parse_mode: string
      reply_markup: { inline_keyboard: Array<Array<{ text: string; url: string }>> }
    }
    expect(body.chat_id).toBe('12345')
    expect(body.parse_mode).toBe('HTML')
    expect(body.reply_markup.inline_keyboard[0]?.map((b) => b.text)).toEqual([
      'Open dashboard',
      'PRs',
      'Costs',
    ])
    expect(new BriefingRepository(h.db.db).latest()?.tgMessageId).toBe('777')
  })
})

describe('sendTelegramMessage', () => {
  it('throws TELEGRAM_API_FAILED on a non-ok response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    await expect(
      sendTelegramMessage({
        botToken: 't',
        chatId: 'c',
        text: 'hello',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'TELEGRAM_API_FAILED' })
  })
})

describe('escapeHtml', () => {
  it('escapes the parse-mode-sensitive characters', () => {
    expect(escapeHtml('a <b> & c')).toBe('a &lt;b&gt; &amp; c')
  })
})
