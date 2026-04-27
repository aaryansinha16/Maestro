// Runtime configuration loaded from environment variables. Validated with
// Zod at startup so the conductor refuses to boot with bad config.

import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { DEFAULT_DATA_DIR, DEFAULT_PORT, MaestroError } from '@maestro/shared'

// Walk up from cwd looking for a .env so that running the conductor from
// inside packages/conductor still picks up the repo-root .env in development.
loadEnvFile()

function loadEnvFile(): void {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env')
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate })
      return
    }
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(DEFAULT_PORT),
  dataDir: z.string().min(1).default(DEFAULT_DATA_DIR),
  developerName: z.string().min(1),
  developerEmail: z.string().email().optional(),
  developerGithubUsername: z.string().min(1),
  // Optional in Phase 0; required when their respective subsystems come online.
  githubToken: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse({
    port: process.env.MAESTRO_PORT,
    dataDir: process.env.MAESTRO_DATA_DIR,
    developerName: process.env.DEVELOPER_NAME,
    developerEmail: process.env.DEVELOPER_EMAIL || undefined,
    developerGithubUsername: process.env.DEVELOPER_GITHUB_USERNAME,
    githubToken: process.env.GITHUB_TOKEN || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    nodeEnv: process.env.NODE_ENV,
  })

  if (!parsed.success) {
    throw new MaestroError('CONFIG_VALIDATION_FAILED', {
      message: 'Environment variables failed validation. See .env.example.',
      context: { issues: parsed.error.issues },
    })
  }

  return parsed.data
}
