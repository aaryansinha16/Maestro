-- Phase 2 scheduling schema.
--
-- Adds the columns and tables that the scheduler, job queue, and skip
-- rules need. No behaviour lives here yet — that lands in subsequent PRs.
-- Existing rows in `projects` get scheduled_enabled = 0 by default, so
-- enabling Phase 2 cannot accidentally start firing sessions on a real
-- project the developer hasn't explicitly opted in (per umbrella issue
-- #17 hard requirement).

ALTER TABLE projects ADD COLUMN scheduled_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (scheduled_enabled IN (0, 1));
ALTER TABLE projects ADD COLUMN auto_paused_at   TEXT;
ALTER TABLE projects ADD COLUMN auto_pause_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_scheduled_enabled
  ON projects(scheduled_enabled);

-- Persistent backing store for the in-memory JobQueue. On startup the
-- conductor marks any rows still in `running` as `cancelled` with reason
-- 'conductor-restart' so a crash doesn't leave a stuck slot.
CREATE TABLE IF NOT EXISTS job_queue (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('schedule', 'manual', 'retry')),
  priority     INTEGER NOT NULL DEFAULT 0, -- higher = jumps queue
  status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
                 DEFAULT 'queued',
  enqueued_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at   TEXT,
  ended_at     TEXT,
  session_id   TEXT,
  cancel_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_queue_status_priority_enqueued
  ON job_queue(status, priority DESC, enqueued_at ASC);
CREATE INDEX IF NOT EXISTS idx_job_queue_project_status
  ON job_queue(project_id, status);

-- The audit log behind "why didn't Maestro fire this morning?". One row
-- per cron tick, regardless of whether it produced a job. The `action`
-- column distinguishes "fired and queued" from "fired but skipped" from
-- "tried to fire but the schedule registration failed".
CREATE TABLE IF NOT EXISTS scheduled_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scheduled_at  TEXT NOT NULL,
  fired_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  action        TEXT NOT NULL CHECK (action IN ('enqueued', 'skipped', 'failed-to-fire')),
  skip_reason   TEXT,
  job_id        TEXT REFERENCES job_queue(id) ON DELETE SET NULL,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_project_fired
  ON scheduled_runs(project_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_action
  ON scheduled_runs(action);
