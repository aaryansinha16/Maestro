// Programmatic API surface for the conductor package.
//
// The CLI and tests import from `@maestro/conductor`. The actual server
// bootstrap lives in `index.ts` and is invoked via `node dist/index.js`,
// not via package import — so this barrel can re-export server pieces
// without triggering `main()`.

export * from './config.js'
export * from './db.js'
export * from './logger.js'
export * from './locks.js'
export * from './repositories.js'
export * from './state-manager.js'
export * from './stack-detector.js'
export * from './quality-gates.js'
export * from './claude-runner.js'
export * from './context-scaffolder.js'
export * from './pr-manager.js'
export * from './worker.js'
export { buildServer, type ServerDeps } from './server.js'
