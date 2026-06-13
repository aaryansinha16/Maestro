// Runtime configuration loaded from environment variables. Validated with
// Zod at startup so the conductor refuses to boot with bad config.

import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { DEFAULT_DATA_DIR, DEFAULT_PORT, MaestroError } from '@maestro/shared'

// The directory containing the .env file we loaded — used as the
// resolution root for relative paths in env values like
// MAESTRO_DATA_DIR=./data. Without this, the same .env produces
// different absolute paths depending on whether the process was
// launched from the repo root (CLI) or from packages/conductor (`pnpm
// dev`), which silently splits one logical SQLite database into two
// (issue #34).
let envFileDir: string | null = null

// Walk up from cwd looking for a .env so that running the conductor from
// inside packages/conductor still picks up the repo-root .env in development.
loadEnvFile()

function loadEnvFile(): void {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env')
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate })
      envFileDir = dir
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
  // Phase 5 / Sub 5.2: when BOTH are set, the whole app (static + API,
  // minus /api/health) sits behind HTTP Basic Auth. Either missing →
  // auth disabled with a startup warning. Single-user v1; magic-link
  // deferred to Phase 6.
  authUser: z.string().min(1).optional(),
  authPassword: z.string().min(8).optional(),
  // Optional CORS allowlist origin. Unset → no CORS middleware at all
  // (same-origin only — correct once the conductor serves the dashboard).
  corsOrigin: z.string().optional(),
  // Phase 5 / Sub 5.4: HH:MM (24h) local to MAESTRO_TZ for the daily briefing.
  briefingTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')
    .default('08:00'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse({
    // MAESTRO_PORT is the explicit local override; PORT is the platform
    // convention (Railway/Heroku/etc. assign it and route the healthcheck
    // + public traffic to it). Preferring MAESTRO_PORT keeps local dev
    // stable while letting a hosted platform pick the port it routes to.
    port: process.env.MAESTRO_PORT ?? process.env.PORT,
    dataDir: process.env.MAESTRO_DATA_DIR,
    developerName: process.env.DEVELOPER_NAME,
    developerEmail: process.env.DEVELOPER_EMAIL || undefined,
    developerGithubUsername: process.env.DEVELOPER_GITHUB_USERNAME,
    githubToken: process.env.GITHUB_TOKEN || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    authUser: process.env.MAESTRO_AUTH_USER || undefined,
    authPassword: process.env.MAESTRO_AUTH_PASSWORD || undefined,
    corsOrigin: process.env.MAESTRO_CORS_ORIGIN || undefined,
    briefingTime: process.env.MAESTRO_BRIEFING_TIME || undefined,
    nodeEnv: process.env.NODE_ENV,
  })

  if (!parsed.success) {
    throw new MaestroError('CONFIG_VALIDATION_FAILED', {
      message: 'Environment variables failed validation. See .env.example.',
      context: { issues: parsed.error.issues },
    })
  }

  // Stabilise dataDir against the .env's directory rather than the
  // process cwd. Absolute paths pass through unchanged.
  const dataDir = resolveAgainstEnvFile(parsed.data.dataDir)

  return { ...parsed.data, dataDir }
}

/**
 * Resolve a relative path against the directory that contained the
 * `.env` we loaded (typically the repo root). Absolute paths are
 * returned unchanged. Falls back to the process cwd when no `.env`
 * was found — matches the pre-fix behaviour for that edge case.
 */
function resolveAgainstEnvFile(p: string): string {
  if (isAbsolute(p)) return p
  const base = envFileDir ?? process.cwd()
  return resolve(base, p)
}
