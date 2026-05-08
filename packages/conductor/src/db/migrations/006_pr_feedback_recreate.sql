-- Phase 4 / Sub 1 hotfix: recreate pr_feedback with pr_branch.
--
-- During Sub 1 development (PR #48) migration 004_pr_feedback.sql was edited
-- mid-implementation to add the `pr_branch` column. Databases that applied
-- the earlier shape now have 004 marked done in `schema_migrations`, so the
-- updated file never re-runs. Their `pr_feedback` table is missing
-- `pr_branch` and the worker's INSERT fails with
-- "table pr_feedback has no column named pr_branch".
--
-- SQLite has no `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, so the cleanest
-- fix is to drop and recreate. Both tables only hold transient sync state;
-- there is nothing user-visible to preserve.
--
-- Idempotent on databases where 004 already had the right shape: DROP + the
-- IF NOT EXISTS in the CREATEs make this a no-op-equivalent (table is
-- recreated with the same definition).

DROP TABLE IF EXISTS pr_feedback;
DROP TABLE IF EXISTS pr_feedback_sync;

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

CREATE TABLE IF NOT EXISTS pr_feedback_sync (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_number     INTEGER NOT NULL,
  last_synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, pr_number)
);
