// Phase 5 / Sub 5.4 — minimal Telegram Bot API client.
//
// fetch-based, no SDK dependency: the briefing needs exactly one method
// (sendMessage with optional URL buttons). HTML parse mode because
// MarkdownV2's escaping rules are a bug farm; URL-only inline keyboards
// because callback buttons need a webhook + signature verification —
// deferred to Phase 6. Every action button is a dashboard deep link.

import { MaestroError } from '@maestro/shared'

export interface TelegramUrlButton {
  text: string
  url: string
}

export interface SendTelegramMessageInput {
  botToken: string
  chatId: string
  /** HTML-formatted body (parse_mode HTML). Escape user text with escapeHtml. */
  text: string
  urlButtons?: TelegramUrlButton[]
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export interface SendTelegramMessageResult {
  messageId: string
}

export async function sendTelegramMessage(
  input: SendTelegramMessageInput,
): Promise<SendTelegramMessageResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }
  if (input.urlButtons && input.urlButtons.length > 0) {
    body['reply_markup'] = {
      inline_keyboard: [input.urlButtons.map((b) => ({ text: b.text, url: b.url }))],
    }
  }

  const res = await fetchImpl(
    `https://api.telegram.org/bot${input.botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )

  const payload = (await res.json().catch(() => null)) as {
    ok?: boolean
    result?: { message_id?: number }
    description?: string
  } | null

  if (!res.ok || !payload?.ok) {
    throw new MaestroError('TELEGRAM_API_FAILED', {
      message: `Telegram sendMessage failed: ${payload?.description ?? res.statusText}`,
      context: { status: res.status },
    })
  }

  return { messageId: String(payload.result?.message_id ?? '') }
}

/** Escape the three characters HTML parse mode cares about. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
