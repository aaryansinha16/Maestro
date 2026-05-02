-- Phase 4 / Sub 2: opt-in session continuation until budget exhausted.
--
-- One row per turn within a session. Turn 1 is the agent's initial work;
-- turn 2+ are continuation runs that fire when autonomy.continueUntilBudget
-- is true and budget remains. Each turn owns its own branch + PR. The parent
-- session row's pr_number column reflects the *last* successful turn so
-- existing dashboards keep working without joins.

CREATE TABLE IF NOT EXISTS session_turns (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_number        INTEGER NOT NULL CHECK (turn_number >= 1),
  branch_name        TEXT,
  pr_number          INTEGER,
  pr_url             TEXT,
  status             TEXT NOT NULL CHECK (status IN (
    'completed','completed-no-changes','quality-gate-failed','timed-out','failed','cancelled'
  )),
  cost_cents         INTEGER,
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  termination_cause  TEXT,
  notes              TEXT,
  UNIQUE (session_id, turn_number)
);

CREATE INDEX IF NOT EXISTS idx_session_turns_session
  ON session_turns(session_id, turn_number);
