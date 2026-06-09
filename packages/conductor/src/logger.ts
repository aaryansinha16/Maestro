// Pino logger. Use `logger.child({ ... })` to attach structured context per
// session, project, or request. Never use console.log in conductor code.

import pino from 'pino'
import { join } from 'node:path'

const isDev = process.env.NODE_ENV !== 'production'
const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info')

// Phase 5 / Sub 5.3: opt-in rotating file logs. When MAESTRO_LOG_DIR is
// set, logs roll daily via pino-roll (newest 14 files kept, gzip'd).
// Default stays stdout: dev gets pino-pretty, and hosted platforms
// (Railway) capture stdout natively — file rotation there would just
// fill the volume twice.
const logDir = process.env.MAESTRO_LOG_DIR

function transportFor(): pino.TransportSingleOptions | undefined {
  if (logDir) {
    return {
      target: 'pino-roll',
      options: {
        file: join(logDir, 'conductor'),
        extension: '.log',
        frequency: 'daily',
        mkdir: true,
        limit: { count: 14 },
        compress: 'gzip',
      },
    }
  }
  if (isDev) {
    return {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname,service',
      },
    }
  }
  return undefined
}

const transport = transportFor()

export const logger = pino({
  level,
  base: { service: 'maestro-conductor' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(transport ? { transport } : {}),
})

export type Logger = typeof logger
