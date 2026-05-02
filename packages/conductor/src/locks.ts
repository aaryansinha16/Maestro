// Per-project advisory locks (ADR-008). Two sessions for the same project
// must never run concurrently — that's the only way to keep the working
// directory and `.maestro/` state coherent.
//
// SQLite has no native session locks, so we model one with a row per
// project keyed on project_id. Acquire = INSERT; release = DELETE. The
// PRIMARY KEY on project_id makes acquire atomic.
//
// Locks include the holder's pid; if the conductor restarts mid-session
// we can reclaim a lock whose holder is gone.

import type Database from 'better-sqlite3'
import { MaestroError } from '@maestro/shared'

interface LockRow {
  project_id: string
  session_id: string
  acquired_at: string
  pid: number
}

export class ProjectLockManager {
  constructor(private readonly db: Database.Database) {}

  /**
   * Try to acquire the lock for `projectId`. Returns true on success.
   * Throws PROJECT_LOCKED if another live process holds the lock.
   */
  acquire(projectId: string, sessionId: string): void {
    const existing = this.peek(projectId)
    if (existing) {
      if (isProcessAlive(existing.pid)) {
        throw new MaestroError('PROJECT_LOCKED', {
          message: `Project is locked by session ${existing.session_id} (pid ${existing.pid})`,
          context: { projectId, holderSessionId: existing.session_id, pid: existing.pid },
        })
      }
      // Stale — the previous holder is gone. Reclaim.
      this.db.prepare('DELETE FROM project_locks WHERE project_id = ?').run(projectId)
    }
    try {
      this.db
        .prepare('INSERT INTO project_locks (project_id, session_id, pid) VALUES (?, ?, ?)')
        .run(projectId, sessionId, process.pid)
    } catch (err) {
      throw new MaestroError('PROJECT_LOCKED', {
        message: 'Race acquiring project lock',
        cause: err,
        context: { projectId, sessionId },
      })
    }
  }

  release(projectId: string, sessionId: string): void {
    this.db
      .prepare('DELETE FROM project_locks WHERE project_id = ? AND session_id = ?')
      .run(projectId, sessionId)
  }

  /**
   * Drop any locks held by THIS process. Used at startup so a crashed
   * conductor doesn't leave behind a permanently-held lock.
   */
  releaseAllForCurrentProcess(): number {
    const result = this.db.prepare('DELETE FROM project_locks WHERE pid = ?').run(process.pid)
    return result.changes
  }

  peek(projectId: string): LockRow | null {
    const row = this.db
      .prepare<[string], LockRow>('SELECT * FROM project_locks WHERE project_id = ?')
      .get(projectId)
    return row ?? null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is the standard "is this pid alive" probe on POSIX. Throws
    // if the pid doesn't exist; succeeds (with no signal sent) if it does.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
