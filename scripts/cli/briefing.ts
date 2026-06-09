// `maestro briefing preview|send` — Phase 5 / Sub 5.4.
//
// preview: print today's digest without sending or recording.
// send:    send via Telegram (or record-only if Telegram isn't configured).
//          --force bypasses the once-per-day dedupe — useful for testing.

import {
  generateBriefing,
  loadConfig,
  openDatabase,
  sendDailyBriefing,
} from '@maestro/conductor'
import { failWith, info, ok } from './util.js'

export async function runBriefingPreview(): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const generated = generateBriefing({ db })
    // Strip the Telegram HTML tags for terminal display.
    process.stdout.write('\n' + generated.text.replace(/<\/?b>/g, '') + '\n\n')
    info(
      `projects=${generated.summary.projects} sessions24h=${generated.summary.sessions24h} prs=${generated.summary.prsOpened24h} feedback=${generated.summary.pendingFeedback}`,
    )
  } finally {
    close()
  }
}

export async function runBriefingSend(opts: { force?: boolean }): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const result = await sendDailyBriefing({
      db,
      config,
      force: opts.force ?? false,
    }).catch((err: unknown) => {
      failWith('Briefing send failed', err)
    })
    if (!result) failWith('sendDailyBriefing returned no value')
    switch (result.status) {
      case 'sent':
        ok(`briefing sent (telegram message ${result.messageId})`)
        break
      case 'recorded-no-telegram':
        ok('briefing recorded — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to deliver it')
        break
      case 'skipped-already-sent':
        info('a briefing was already sent today — rerun with --force to send another')
        break
    }
  } finally {
    close()
  }
}
