// Helpers shared by the CLI subcommands. Centralises DB opening, env
// loading, and pretty error printing so each command focuses on its own
// flow.

import 'dotenv/config'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import kleur from 'kleur'
import { isMaestroError } from '@maestro/shared'

export function loadEnvFromRepoRoot(): void {
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
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

export function failWith(message: string, err?: unknown): never {
  console.error(kleur.red(`× ${message}`))
  if (err) {
    if (isMaestroError(err)) {
      console.error(kleur.red(`  code: ${err.code}`))
      if (err.message && err.message !== message) {
        console.error(kleur.red(`  ${err.message}`))
      }
      if (Object.keys(err.context).length > 0) {
        console.error(kleur.gray(`  context: ${JSON.stringify(err.context)}`))
      }
    } else if (err instanceof Error) {
      console.error(kleur.gray(`  ${err.message}`))
    } else {
      console.error(kleur.gray(`  ${String(err)}`))
    }
  }
  process.exit(1)
}

export function ok(message: string): void {
  console.log(kleur.green(`✓ ${message}`))
}

export function info(message: string): void {
  console.log(kleur.cyan(`→ ${message}`))
}

export function warn(message: string): void {
  console.warn(kleur.yellow(`! ${message}`))
}

export function pretty(label: string, value: string | number | null | undefined): string {
  return `${kleur.gray(label.padEnd(14))} ${value ?? kleur.gray('—')}`
}

export function expectEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    failWith(`Missing environment variable ${name}. See .env.example.`)
  }
  return value
}
