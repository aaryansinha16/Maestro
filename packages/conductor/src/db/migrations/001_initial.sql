-- Maestro initial schema.
--
-- See ADR-003: SQLite is for operational state (which sessions ran, when, what
-- they cost). The .maestro/ files in each managed repo are the source of truth
-- for project state — never duplicate that here.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- Projects registered with Maestro.
CREATE TABLE IF NOT EXISTS projects (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,
  repo_url             TEXT NOT NULL,
  autonomy_config_json TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Sessions: one per Claude Code spawn.
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN (
                    'pending','running','completed','completed-no-changes',
                    'quality-gate-failed','timed-out','failed','cancelled'
                  )),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  cost_cents      INTEGER,
  prompt_version  TEXT NOT NULL,
  branch_name     TEXT,
  pr_number       INTEGER,
  journal_path    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_started
  ON sessions(project_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_status
  ON sessions(status);

-- Quality gate runs, one row per gate per session.
CREATE TABLE IF NOT EXISTS quality_gate_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  gate_name   TEXT NOT NULL CHECK (gate_name IN ('test','lint','typecheck','build')),
  status      TEXT NOT NULL CHECK (status IN ('passed','failed','skipped')),
  output      TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  ran_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_quality_gates_session
  ON quality_gate_runs(session_id);

-- Daily briefings sent to Telegram.
CREATE TABLE IF NOT EXISTS briefings (
  id             TEXT PRIMARY KEY,
  sent_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  content        TEXT NOT NULL,
  tg_message_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_briefings_sent_at
  ON briefings(sent_at DESC);
