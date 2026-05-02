# Scheduling

How Phase 2 makes Maestro autonomous — and how to tell it when you don't
want it to fire.

## Lifecycle

A scheduled session goes through this pipeline:

```
cron tick                         skip rules               job queue           worker
   │                                  │                       │                  │
   ▼                                  ▼                       ▼                  ▼
register node-cron job   evaluateSkipRules(ctx)   enqueue source=schedule   runSession()
on scheduledEnabled=true                                                      ▲
projects                                                                      │
                                  ┌─────────┴─────────┐                       │
                                  ▼                   ▼                       │
                            scheduled_runs   `skipped` reason         per-project lock
                            (enqueued / skipped / failed-to-fire)     concurrency=1
                                                                              ▲
                                                                              │
                                                                       global concurrency
                                                                       MAESTRO_MAX_PARALLEL
```

Components:

- **Scheduler** (`packages/conductor/src/scheduler.ts`) — registers a
  node-cron job per `scheduledEnabled = true` project. Reconciles the
  registered set against the DB every `SCHEDULER_POLL_INTERVAL_MS`
  (30 s by default), so schedule edits hot-reload.
- **Skip rules** (`packages/conductor/src/skip-rules.ts`) — six pure
  functions that decide whether a tick should produce a queued job.
- **Job queue** (`packages/conductor/src/job-queue.ts`) — in-memory
  queue with SQLite persistence. Per-project concurrency = 1 (ADR-008);
  global concurrency = `MAESTRO_MAX_PARALLEL` (default 2).
- **Audit log** (`scheduled_runs` table) — every cron tick records a
  row with `action ∈ {enqueued, skipped, failed-to-fire}` and a typed
  `skip_reason` when relevant.

## Opt-in by project

Scheduling is **opt-in per project**. New projects added via
`maestro add` start with `scheduledEnabled: false`. The developer
enables it explicitly when ready:

```bash
maestro schedule enable <slug>
```

This is on purpose — see umbrella issue #17 and ADR-020. The "first few
manual sessions prove the project is healthy" rule from
`PROJECT_ONBOARDING.md` is what makes the difference between scheduled
sessions producing PRs you'd merge and scheduled sessions producing
noise.

## Skip rules

Layered cheapest-first so a tick on an auto-paused project doesn't pay
for a `git log` probe.

| # | Rule | Reason code | Cost |
|---|------|-------------|------|
| D | Project is auto-paused (`projects.auto_paused_at` set) | `auto-paused` | DB lookup |
| — | Project is manually paused (`autonomy.json level=paused`) | `manual-paused` | autonomy field |
| C | Today is in `skipDays` | `skip-day` | date math |
| B | `maxSessionsPerDay` cap reached | `max-sessions-per-day` | one indexed COUNT |
| F | 3+ consecutive failed sessions | `failure-backoff` | one indexed SELECT |
| E | Cost throttle: ≥80% → skip `priority: low`; ≥95% → skip everything | `cost-throttle-low-priority` / `cost-throttle-budget-exceeded` | reuses CostRepository.aggregate() |
| A | Developer committed in last `MAESTRO_DEVELOPER_ACTIVITY_WINDOW_HOURS` (default 4) | `developer-recently-active` | `git log` on the working clone |

Manual triggers (`maestro run <slug>`, dashboard "trigger now",
`POST /api/projects/:slug/trigger`) bypass all skip rules. They get
`source='manual'` and `priority=100`, so they jump ahead of any queued
scheduled jobs.

## Auto-pause

After `AUTO_PAUSE_FAILURE_THRESHOLD` (5) consecutive failed sessions,
the project is set to `auto_paused_at = now()` and the scheduler stops
firing it (Rule D). Manual triggers still work; a successful manual
session clears the auto-pause.

A "failed" session for this purpose means:
- `status !== 'completed'`, OR
- `status === 'completed'` but `pr_number IS NULL` after a
  non-orientation session.

`completed-no-changes` and orientation sessions don't count as
failures.

## Job queue

In-memory FIFO with priority override:

```
priority DESC, enqueued_at ASC
```

Source defaults: `manual=100`, `retry=50`, `schedule=0`.

The picker walks the entire queue and returns the first job whose
project isn't already in flight. So project A with 5 queued jobs can't
starve project B's 1 queued job — when a slot opens, the picker walks
past A's stack and finds B.

On boot, the queue calls `cancelStaleOnBoot()`, which marks any rows
still in `running` from a previous boot as `cancelled` with reason
`conductor-restart`. This means a crash mid-session doesn't leave a
permanently-occupied slot — the scheduler can fire again on the next
tick.

## Configuration

### `autonomy.json`

```json
{
  "scheduledEnabled": false,    // opt-in flag
  "schedule": "0 */6 * * *",    // standard cron expression
  "skipDays": ["saturday", "sunday"],
  "maxSessionsPerDay": 6,
  "priority": "normal",         // 'high' | 'normal' | 'low'
  // … plus the existing Phase 1 fields
}
```

### Environment variables

| Var | Default | Effect |
|---|---|---|
| `MAESTRO_MAX_PARALLEL` | 2 | Global ceiling on concurrent sessions |
| `MAESTRO_TZ` | `UTC` | Timezone for cron expressions |
| `MAESTRO_DEVELOPER_ACTIVITY_WINDOW_HOURS` | 4 | Rule A window |
| `MAESTRO_BUDGET_USD` | 50 | Monthly budget for cost throttling (rule E) |

## Troubleshooting

### "Why didn't Maestro fire this morning?"

```bash
maestro skips <slug>
```

shows the last 20 `scheduled_runs` rows with action + `skip_reason`.
The dashboard's ProjectDetail Scheduling panel surfaces the same.

If the skip reason is:

- `auto-paused` — the project crossed the failure threshold. Run
  `maestro resume <slug>` after fixing the underlying issue.
- `manual-paused` — `autonomy.json level=paused`. Edit the file or run
  `maestro schedule enable <slug>` once unpaused.
- `skip-day` — today is in `skipDays`. By design.
- `max-sessions-per-day` — already ran `maxSessionsPerDay` times today.
- `failure-backoff` — last 3 sessions failed; backing off until a
  successful manual run resets the counter.
- `cost-throttle-*` — monthly budget threshold reached. Increase
  `MAESTRO_BUDGET_USD` or wait for the rolling 30-day window to roll.
- `developer-recently-active` — you committed in the last 4 hours;
  Maestro deferred to you.

### "Schedule edit doesn't seem to take effect"

The scheduler reconciles every 30 s by default. The API endpoint and
CLI both call `scheduler.reconcileNow()` so changes through those paths
are immediate. If you edited the SQLite row directly (don't), wait up
to `SCHEDULER_POLL_INTERVAL_MS`.

### "I want to stop everything fast"

```bash
maestro pause <slug>           # one project
# or
maestro schedule disable <slug>  # one project, more permanent
```

Send SIGTERM to the conductor to drain in-flight jobs and exit cleanly:

```bash
kill -TERM $(pgrep -f 'node .*conductor/dist/index.js')
```

Crash recovery on the next boot will mark any in-flight jobs as
`cancelled` with reason `conductor-restart`.
