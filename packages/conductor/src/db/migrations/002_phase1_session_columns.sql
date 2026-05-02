-- Phase 1 session columns.
--
-- Adds the fields the worker writes after a real session: which model the
-- agent ran, how it terminated, the on-disk log path, the PR URL (so the
-- dashboard can deep-link without rebuilding it from project + number),
-- and a parent_session_id link so a fixup turn references its parent.

ALTER TABLE sessions ADD COLUMN model_used        TEXT;
ALTER TABLE sessions ADD COLUMN pr_url            TEXT;
ALTER TABLE sessions ADD COLUMN log_path          TEXT;
ALTER TABLE sessions ADD COLUMN termination_cause TEXT
  CHECK (termination_cause IS NULL OR termination_cause IN (
    'exit-clean','graceful','sigterm-timeout','sigkill-timeout','failed','killed-by-signal'
  ));
ALTER TABLE sessions ADD COLUMN is_fixup_turn     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT
  REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_parent
  ON sessions(parent_session_id);

-- Per-project advisory locks. SQLite has no native session locks; we use a
-- table with a UNIQUE project_id and INSERT OR ABORT to acquire. ADR-008
-- guarantees per-project sequential execution.
CREATE TABLE IF NOT EXISTS project_locks (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  pid         INTEGER NOT NULL
);
