-- Phase 4 / Sub 1: PR feedback loop.
--
-- Stores reviewer comments fetched from open Maestro PRs so the next session
-- on that project can fold them into its prompt. processed_at + applied_in_session_id
-- track which session addressed each comment, so we don't loop forever showing
-- the same feedback.

CREATE TABLE IF NOT EXISTS pr_feedback (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_number             INTEGER NOT NULL,
  pr_branch             TEXT NOT NULL,
  comment_id            INTEGER NOT NULL,
  comment_body          TEXT NOT NULL,
  comment_author        TEXT NOT NULL,
  posted_at             TEXT NOT NULL,
  fetched_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at          TEXT,
  applied_in_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  UNIQUE (project_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_pr_feedback_project_unprocessed
  ON pr_feedback(project_id, processed_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pr_feedback_pr
  ON pr_feedback(project_id, pr_number);

-- Per-PR sync clock so we don't refetch faster than every 5 minutes (rate-limit
-- friendly). One row per PR; updated each time we successfully fetch comments.
CREATE TABLE IF NOT EXISTS pr_feedback_sync (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_number     INTEGER NOT NULL,
  last_synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, pr_number)
);
