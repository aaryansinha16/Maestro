// `maestro backup` — snapshot the conductor's SQLite now and prune old
// backups. Same code path as the daily housekeeping cron and
// POST /api/admin/backup (Phase 5 / Sub 5.3).

import { loadConfig, openDatabase, runBackupNow } from '@maestro/conductor'
import { failWith, info, ok } from './util.js'

export async function runBackup(): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    info(`backing up ${config.dataDir}/maestro.db`)
    const result = await runBackupNow({ db, dataDir: config.dataDir }).catch(
      (err: unknown) => {
        failWith('Backup failed', err)
      },
    )
    if (!result) failWith('backup returned no value')
    ok(`backup written: ${result.path}`)
    if (result.prunedCount > 0) info(`pruned ${result.prunedCount} old backup(s)`)
  } finally {
    close()
  }
}
