// Pino logger. Use `logger.child({ ... })` to attach structured context per
// session, project, or request. Never use console.log in conductor code.

import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'
const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info')

export const logger = pino({
  level,
  base: { service: 'maestro-conductor' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,service',
          },
        },
      }
    : {}),
})

export type Logger = typeof logger
