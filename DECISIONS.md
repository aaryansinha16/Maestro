# Maestro — Architectural Decision Log

Record every non-trivial technical decision here. Format: number, date, decision, reasoning, alternatives considered.

---

## ADR-001: Use Claude Code CLI Subscription, Not API

**Date**: 2026-04-28  
**Decision**: Maestro spawns Claude Code via the `claude` CLI on the VPS, authenticated to the developer's Pro/Max subscription, rather than calling the Anthropic API directly.

**Reasoning**: The developer has confirmed this usage is permitted under their subscription terms. Claude Code provides higher-level capabilities (project context loading, file editing, tool use) that would require significant reimplementation if calling the API directly. The CLI is also better-tested for autonomous coding work.

**Alternatives**:
- (a) Direct Anthropic API — would require building project context loading, file editing tools from scratch
- (b) Mix of both — adds complexity without clear benefit

**Implications**: 
- VPS must have Node 22+ and Claude Code installed
- VPS must complete OAuth flow once (interactive setup)
- Subscription rate limits apply
- Will need to monitor usage and back off if hitting limits

---

## ADR-002: Hono over Express

**Date**: 2026-04-28  
**Decision**: Use Hono as the HTTP server framework.

**Reasoning**: Smaller bundle, faster, modern TypeScript-first API, runs on Node and edge runtimes (gives us flexibility later). For a server with a few dozen endpoints, the simplicity is worth it.

**Alternatives**:
- (a) Express — mature but bloated, less type-safe by default
- (b) Fastify — fast but more complex
- (c) Bare Node http — too low-level

---

## ADR-003: SQLite for Persistence

**Date**: 2026-04-28  
**Decision**: better-sqlite3 for all conductor state (sessions, costs, briefings).

**Reasoning**: Single-user system on a single VPS. SQLite is fast, file-based, zero-config. Postgres would be overkill. The .maestro/ files in repos are the source of truth for project state — SQLite is just for operational state (what sessions ran, when, what they cost).

**Alternatives**:
- (a) Postgres — overkill, adds deployment complexity
- (b) JSON files — fine but no querying
- (c) DuckDB — interesting for analytics but unnecessary

---

## ADR-004: .maestro/ Directory Lives in Each Project

**Date**: 2026-04-28  
**Decision**: Project state (state.md, context.md, journal/, autonomy.json) lives in a `.maestro/` directory at the root of each managed project, committed to the repo.

**Reasoning**: This solves multiple problems at once:
- Cross-laptop context (the state travels with the code)
- Auditability (the developer can see exactly what context the agent had)
- Versioning (state changes are tracked in git)
- Recovery (if Maestro server dies, project state is intact)
- Self-documenting (anyone reading the repo understands the agent's perspective)

**Alternatives**:
- (a) State on the conductor only — single point of failure, doesn't sync to laptops
- (b) State in a separate "control" repo — extra complexity, syncing issues
- (c) State in a database only — opaque, not human-readable

**Implications**: 
- The .maestro/ directory should be in .gitignore for absolutely nothing — it's intentionally tracked
- Structure must be stable; format changes require migrations
- The agent reads and writes these files within its working directory each session

---

## ADR-005: PR-Only Default Autonomy

**Date**: 2026-04-28  
**Decision**: Default autonomy is `pr-only`. The agent never pushes to main. Direct pushes (`full` autonomy) require explicit per-project opt-in.

**Reasoning**: Code review is the proven mechanism for catching mistakes. The 30 seconds it takes to review a small PR is worth far more than the 30 minutes it takes to revert a bad direct push. PRs also create natural audit trails.

**Alternatives**:
- (a) `full` default — risky, contrary to system goals
- (b) Always `draft-only` — too friction-heavy for trusted projects

---

## ADR-006: Quality Gates Are Pre-PR, Not Pre-Commit

**Date**: 2026-04-28  
**Decision**: The agent commits work before running quality gates. Gates run after commit, before PR creation. If gates fail, the branch exists but no PR opens.

**Reasoning**: The agent's work has value even if it doesn't pass gates — it might be 90% there, just needing one fix. Committing first preserves the work. The branch with failing gates becomes a "work in progress" that the developer can fix manually if desired.

**Alternatives**:
- (a) Pre-commit gates that abort the work — loses partial progress
- (b) No gates at all — produces low-quality PRs

---

## ADR-007: Time Budget Enforced via Process Kill

**Date**: 2026-04-28  
**Decision**: Sessions have a hard time budget (default 45 min). At budget expiry, the Claude Code process is killed (SIGTERM, then SIGKILL after 30s).

**Reasoning**: Without a hard limit, sessions can run indefinitely on hard problems. Hard kill is harsh but correct — better to lose 5 minutes of work than to have one project consume the whole conductor.

**Alternatives**:
- (a) Soft budget with warnings — agent ignores warnings
- (b) Cooperative cancellation — Claude Code doesn't support it natively
- (c) Adaptive budgets — too complex for v1

**Implications**: The agent is told its budget upfront and is instructed to "wrap up cleanly with 5 minutes left." Most sessions self-terminate before kill.

---

## ADR-008: Sequential Sessions Per Project, Parallel Across Projects

**Date**: 2026-04-28  
**Decision**: Two sessions on the same project never run concurrently. Sessions on different projects can run in parallel up to a global concurrency limit.

**Reasoning**: Two agents on the same project would create merge conflicts and confused state. Different projects don't interfere with each other. Global limit prevents resource exhaustion.

**Alternatives**: 
- (a) Always sequential — wastes idle time
- (b) Always parallel — same-project conflicts

---

## ADR-009: GitHub-Only for v1

**Date**: 2026-04-28  
**Decision**: v1 supports only GitHub repositories. GitLab, Bitbucket, self-hosted Git deferred.

**Reasoning**: The developer uses GitHub. Octokit is mature. GitLab support is a future expansion, not v1 work.

---

## ADR-010: Telegram for Briefings, Web for Detail

**Date**: 2026-04-28  
**Decision**: Telegram bot for daily push briefings. Web dashboard for everything else.

**Reasoning**: Telegram has a great bot API, free, the developer already uses it. Push notifications work everywhere. The dashboard is for review and control — too complex for chat.

**Alternatives**:
- (a) Email briefings — pushy, less interactive
- (b) Slack — only relevant if developer uses Slack
- (c) Mobile app — overkill for v1

---

## ADR-011: Claude Code CLI invocation for autonomous sessions

**Date**: 2026-04-28
**Decision**: Spawn `claude -p "<prompt-via-stdin>"` with these flags for every Maestro session:

```
claude -p
  --permission-mode bypassPermissions
  --allowedTools "Read Edit Write Bash Glob Grep"
  --no-session-persistence
  --output-format stream-json
  --include-partial-messages
  --verbose
  --add-dir <working-dir>
```

The prompt itself is fed via stdin (not as a positional arg) to keep clear of `ARG_MAX` limits with long contexts.

**Reasoning**:
- `-p` is the documented non-interactive mode flag.
- `bypassPermissions` is the only mode that allows full file editing + bash without prompting. The agent's working directory is sandboxed under `MAESTRO_DATA_DIR/work/<slug>`, so the trust boundary is the directory, not the permission dialogue.
- `--allowedTools` is advisory under `bypassPermissions` but documents intent and limits damage if the mode flag changes.
- `--no-session-persistence` keeps each Maestro session isolated from the developer's interactive Claude history.
- `stream-json` + `--include-partial-messages` + `--verbose` gives one JSON object per line, with the final `result` object carrying `usage` for cost tracking.

**Things we deliberately AVOID**:
- `--bare` — bypasses the keychain and forces `ANTHROPIC_API_KEY`. Contradicts ADR-001 (Pro/Max OAuth subscription).
- `--continue`, `--resume` — load from the global session store; breaks isolation between projects.
- `--dangerously-skip-permissions` — alias for the `bypassPermissions` mode but suggests carelessness; we use the explicit mode flag.
- `--max-turns` — claimed by the documentation guide but doesn't actually appear in `claude --help` output as of v2.1.118; we don't pass it.

**Implications**:
- The conductor must run on a host where `claude` is on PATH and an interactive `claude /login` has been completed at least once.
- Cost is parsed from the final `result` line's `usage` object using the published rate card (input $3/M, output $15/M, cache write $3.75/M, cache read $0.30/M). Stored as integer cents on the session row.

---

## ADR-012: Per-project lock via SQLite row-with-pid

**Date**: 2026-04-28
**Decision**: Per-project advisory locks live in a SQLite `project_locks` table with `project_id` as the primary key. Lock acquisition is `INSERT OR ABORT` (atomic via the unique constraint) and the row records the holder's pid + session id.

On startup, the conductor releases any locks whose pid matches the current process — so a crashed conductor reclaims its own locks rather than leaving them stuck. On acquire, if a lock exists but the holder pid is dead (signal-0 probe), we steal it.

**Reasoning**: SQLite has no native session locks. The alternative — a filesystem flock — works on a single machine but doesn't expose the holder identity to the dashboard, makes inspection harder, and would require a separate lockfile path scheme. Embedding the lock in the same SQLite file the rest of the operational state lives in keeps everything atomic and queryable.

**Implications**:
- The conductor is single-tenant per host. Running two conductors against the same SQLite file would still serialise correctly (SQLite's PRIMARY KEY is atomic), but the pid-staleness check assumes you're checking pids on the same host. That's fine for v1.
- ADR-008 (sequential per-project) is now enforced at the data layer, not just the application layer.

---

## ADR-013: Quality-gate-failed → exactly one fixup turn

**Date**: 2026-04-28
**Decision**: When quality gates fail after the agent's commit, Maestro spawns exactly one fixup turn with a 15-minute budget (`FIXUP_TURN_BUDGET_SECONDS`). If gates still fail after the fixup, the branch is pushed and labelled `quality-gates-failed` (when the GitHub client is configured) but no PR opens.

**Reasoning**: Repeated fixup turns turn into thrashing; the 15-minute budget is what PROMPT_DESIGN.md specified. One retry catches the common case (a missing import, a typo, a small logic error the test surfaced) while bounding cost.

**Alternatives**:
- (a) No fixup turn — wastes the agent's earlier work when a one-line fix would unblock it.
- (b) Multiple fixup turns — diminishing returns; if the first fixup didn't work the issue likely needs human review.

**Implications**: Each fixup turn is recorded as a separate session row with `is_fixup_turn = 1` and `parent_session_id` set. The dashboard shows the fixup as a child session.

---

## ADR-014: Whitelist environment for the agent process

**Date**: 2026-04-28
**Decision**: When spawning `claude` (and quality-gate processes), pass through only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`, and `CI`. The full conductor process environment is **not** forwarded.

**Reasoning**: The conductor's environment contains `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, future API keys, and developer dotfiles that would otherwise leak into agent shell sessions. The whitelist gives the agent enough to run tests and build tools without exposing operational secrets.

**Implications**: If a managed project's tests genuinely need an environment variable, the agent has to ask via state.md and the developer adds it explicitly to the conductor's allowlist. We accept that friction in exchange for the security boundary.

---

## ADR-015: Orientation mode replaces "first session is read-only"

**Date**: 2026-05-02
**Decision**: Phase 1.5 introduces an explicit "orientation mode" that activates only when both `.maestro/journal/` is empty and state.md has no concrete tasks. In that mode, the prompt instructs the agent to update only `.maestro/` files, and the worker skips quality gates and refuses to open a PR.

When state.md *does* have a concrete task, even on a brand-new project, the FIRST SESSION preamble defers to it: "you have permission to make code changes — the explicit task in state.md overrides any 'orientation only' intuition."

**Reasoning**: Phase 1's first real run surfaced a contradiction in PROMPT_DESIGN.md — the FIRST SESSION block said "don't make code changes" while YOUR TASK said "fix the broken function". The agent flagged it in its journal entry. Tying orientation to an empty task list (rather than to "is this the first session") removes the contradiction.

**Implications**:
- `PROMPT_VERSION` bumped to `1.1.0`
- `buildSessionPrompt` and the worker share `isOrientationModeFromContext` so they always agree
- Orientation sessions still validate the agent updated `.maestro/`; if not, they fail
- The prompt's "task" line is now empty (rather than "pick the most important") when state.md has none — that's the orientation signal

---

## ADR-016: Journal filenames carry seconds granularity

**Date**: 2026-05-02
**Decision**: Journal filenames are `YYYY-MM-DD-HH-MM-SS.md`. The legacy minute-only `YYYY-MM-DD-HH-MM.md` regex remains accepted on read; `state-manager.migrateJournalFilenames` renames legacy files to `…-00.md` on first read of any project.

**Reasoning**: Two sessions landing in the same minute would collide on the legacy format. Phase 2 introduces scheduling, which makes that more likely. Migrating in-place keeps existing repos working without a manual sweep.

**Alternatives**:
- (a) Switch to ISO timestamps (`2026-04-15T08:00:12Z.md`) — colon characters are awkward on filesystems; wouldn't sort lexicographically without escaping.
- (b) Use ULID/UUID — kills chronological sort.

**Implications**: The prompt explicitly tells the agent to use seconds-granularity. Existing test fixtures may need bumping when goldens are regenerated; the test harness handles legacy filenames transparently.

---

## ADR-017: Project-specific never-touch list flows from context.md

**Date**: 2026-05-02
**Decision**: The `projectSpecificNeverTouch` field on `SessionPromptContext` is now wired up. The worker parses it out of context.md by looking for `## Project-specific NEVER list` or `## Never Touch` (case-insensitive) and extracts each `-`/`*` bullet. Items render verbatim under rule #6 of the prompt.

**Reasoning**: The agent already reads context.md, but surfacing the never-touch list as a structured rule makes the boundary unmistakable — the agent cannot miss it by skimming. An empty list is fine (the global never-touch list still fires).

**Alternatives considered**:
- (a) Drop the field. Cleaner code but weaker guardrails for high-risk projects (AI-Trader, payment paths).
- (b) Require a separate `.maestro/never-touch.md`. More files = more friction; consolidating in context.md keeps the contract small.

**Implications**: Existing `.maestro/context.md` files seeded by `maestro init` already include a `## Project-specific NEVER list` section, so the change is backwards-compatible with Phase 1 onboardings.

---

## ADR-018: SIGTERM is the only "wrap up" signal

**Date**: 2026-05-02
**Decision**: We don't build a stdin pipe to deliver "5 minutes left" as text mid-session. SIGTERM at `budget − 5min` (and again at `budget`) is the entire signalling mechanism.

**Reasoning**: Claude Code handles SIGTERM gracefully in observed runs — the process commits in-flight work and exits cleanly. Adding a side-channel for textual reminders would mean either: (a) keeping the agent's stdin open after the prompt was delivered (tricky with `--print`), or (b) writing to a file the agent polls (forces every prompt to teach the agent to poll). Both add complexity for marginal benefit when the existing signal is reliable.

If a future agent implementation ignores SIGTERM, the `budget + 30s` SIGKILL still bounds wallclock. Cost is bounded by `--max-budget-usd` for paranoid projects.

**Implications**: The prompt's "at minute X-5, begin wrapping up" line is informational only — the SIGTERM does the actual deadline enforcement. We accept the small risk that Claude Code's signal handling regresses; we'd notice that quickly via session logs.

---

## ADR-019: Working dirs cache build artefacts across sessions

**Date**: 2026-05-02
**Decision**: After Phase 1 (which always reset working dirs to `origin/main` and `git clean -fdx`), Phase 1.5 changes the refresh policy: source files are reset to origin/main, but `node_modules/`, `target/`, `vendor/`, `.venv/`, `.next/`, `.turbo/`, and `__pycache__/` survive a refresh. They're regenerated only when explicitly cleared.

**Reasoning**: Real projects have multi-gigabyte `node_modules` that take 30–60s to install. Reinstalling them every session burns Claude Code budget on `pnpm install` instead of actual work. The build artefact directories aren't part of the source code — `git clean -fdx` is overkill.

**Implications**:
- New env var `MAESTRO_WORKDIR_GC_DAYS` (default 30) — directories untouched this long are blown away by `maestro gc`.
- `maestro reset <slug>` is the explicit "I want a truly fresh clone" escape hatch.
- The clean-reset path used by `prepareWorkingDir` switches from `git clean -fdx` to `git clean -fd` plus a `git reset --hard`, so tracked files come back but the cache directories remain.

---

## ADR-020: In-memory job queue, opt-in scheduling, no Redis/Bull in v1

**Date**: 2026-05-02
**Decision**: Phase 2 ships an in-memory `JobQueue` backed by a SQLite `job_queue` table for crash recovery. We deliberately do NOT introduce Redis/Bull/BullMQ. Scheduling is also opt-in per project: every existing and new project starts with `scheduledEnabled = false`.

**Reasoning**:
- Single-conductor, single-host topology (ADR-002 / ADR-012). A second process layer would buy queueing semantics we already get atomically from SQLite.
- The full v1 working set fits in memory (≤ 10 projects × handful of queued jobs). Redis would be a deployment burden disproportionate to the workload.
- Crash recovery is the one Redis/Bull benefit we genuinely need. We get it from the SQLite-backed queue: `cancelStaleOnBoot()` marks rows still in `running` after a previous boot as `cancelled` with reason `conductor-restart`. The next pump finds open slots immediately.
- Opt-in scheduling is a safety property. Phase 2 must work with zero projects registered (umbrella #17 hard requirement). Defaulting `scheduledEnabled = false` means we cannot accidentally fire scheduled sessions on a real project the developer hasn't explicitly enabled — even if they had `scheduled: "0 */6 * * *"` in their autonomy.json from Phase 1.

**Alternatives**:
- (a) BullMQ + Redis — production-ready queueing, but requires Redis on the VPS. Defer until we exceed the in-memory regime (>50 projects or multiple conductors).
- (b) Auto-enable scheduling on every project — too risky. The "first 2 weeks of any project are for building trust" rule from CLAUDE.md only works if the developer chooses when to flip the switch.

**Implications**:
- The queue's API is intentionally narrow (`enqueue / cancel / pump / snapshot / stop / hasInFlight`) so we can swap implementations later without touching the scheduler or worker.
- `MAESTRO_MAX_PARALLEL` (default 2) is the only knob; per-project concurrency stays at 1 enforced by `project_locks` (ADR-012).

---

## ADR-021: Skip rules as a layered, audited stack

**Date**: 2026-05-02
**Decision**: The six Phase 2 skip rules run in a deterministic, cheapest-first order. Each returns a typed `SkipDecision` (`reason: ScheduleSkipReason`, optional `notes`) or `null`. The first rule that fires short-circuits the chain. Every cron tick — fired or skipped — writes a row to `scheduled_runs` with the action and reason. The audit log is the answer to "why didn't Maestro fire this morning?".

Order:

1. D — `auto-paused` (DB lookup, free)
2. manual-paused (`autonomy.level === 'paused'`, free)
3. C — skip-day (date math)
4. B — max-sessions-per-day (one indexed COUNT)
5. F — failure-backoff (one indexed SELECT, 3+ consecutive failures → skip)
6. E — cost-throttle-low-priority / -budget-exceeded (uses `CostRepository.aggregate()`)
7. A — developer-recently-active (shells out to `git log`)

**Reasoning**: A 1-3 cost-ordered chain pays the 5 ms `git log` only when the cheaper rules let the tick through. The audit log makes skip decisions debuggable — without it, "Maestro didn't run" looks like a system bug instead of a designed behaviour. Typed `ScheduleSkipReason` enums let the dashboard label rows precisely.

**Implications**:
- Adding a rule means adding a new `ScheduleSkipReason` enum value, a function in `skip-rules.ts`, and a position in the chain.
- Manual triggers bypass the chain entirely (they go through `JobQueue.enqueue` with `source: 'manual'`, not through the scheduler).
- Auto-pause is its own state in `projects` (ADR-022) so its detection is O(1) — Rule D doesn't have to walk the failure history every tick.

---

## ADR-022: Hot reload via 30-second polling

**Date**: 2026-05-02
**Decision**: The scheduler reconciles its registered cron jobs against the projects table by polling every `SCHEDULER_POLL_INTERVAL_MS` (30 s) rather than via a SQLite trigger / WAL hook / event bus. The HTTP API and CLI also call `scheduler.reconcileNow()` after writes so changes made through those paths are instant.

**Reasoning**:
- 30 s is an acceptable maximum lag for a developer adjusting their own schedules. The two paths that *can* skip the lag (API, CLI) already do via `reconcileNow()`.
- SQLite triggers can't easily call back into the application layer (would need a cross-process notify channel — Pusher, NOTIFY, etc.).
- A dedicated event bus (e.g. an EventEmitter exposed from the repositories) would couple every write site to the scheduler and grow more complex as more subsystems subscribe.
- Polling is observable: a single setInterval, a single `reconcileNow()` method, easy to test deterministically.

**Alternatives**:
- (a) SQLite WAL-based notify (e.g. `update_hook` from better-sqlite3). Real-time but requires the scheduler to disambiguate which projects changed and re-enter the reconciler in a non-trivial way.
- (b) In-process EventEmitter on every repository write. Simple but spreads coupling across the codebase.

**Implications**:
- Schedules written via direct SQL (or a future migration tool) take up to 30 s to take effect. Documented in `docs/SCHEDULING.md`.
- The poll is unref'd so it doesn't keep the process alive past graceful shutdown.

---

## ADR-023: PR feedback loop fetches GitHub comments into the next session

**Date**: 2026-05-02
**Decision**: Phase 4 / Sub 1 turns reviewer comments on Maestro-opened PRs into structured prompt input. Before each session, the worker calls `syncPendingFeedback`, which lists the project's open PRs whose branch matches the configured prefix, fetches comments via Octokit, filters via an allowlist (default `[config.developerGithubUsername]`), and persists new ones to the `pr_feedback` table. The session prompt grows a `== FEEDBACK ON RECENT PRs ==` section (PROMPT_VERSION 1.2.0) when any rows are pending. After the session, the worker reads the agent's new journal entry and marks rows processed for any PR the agent acknowledged ("addressed PR #42 feedback").

**Reasoning**: The developer just onboarded their first real project. Without this loop, every PR critique requires manually editing `state.md` — exactly the friction the PR-only workflow was supposed to remove. The journal-based heuristic is intentionally simple: false negatives just mean the same comment surfaces in the next session, which is acceptable. Far harsher to mark a comment processed when the agent didn't actually address it (false positive) than to surface the same one twice.

**Subscription cost impact**:
- **+0 Claude calls per session.** The fetch is HTTP-only and uses the existing `GITHUB_TOKEN`.
- **+~250–500 prompt tokens per pending comment.** When a session runs with 3 pending comments, the prompt grows by ~1.5k tokens — well within budget for the Pro/Max subscription.
- The 5-minute per-PR cooldown stops a tight loop of failed sessions from hammering the GitHub rate limit.

**Alternatives considered**:
- (a) Webhook-driven ingest. Lower latency than polling, but requires the conductor to expose a public endpoint with signed-payload validation — a Phase 5 deployment problem, not a Phase 4 feature problem.
- (b) Auto-rewrite `state.md` from comments instead of adding a prompt section. The agent would lose the original wording and provenance of the comment; folding into the prompt preserves both.

**Implications**:
- `PROMPT_VERSION` bumped to `1.2.0`. Sessions are grouped by version on the dashboard so we can A/B observe whether feedback-equipped sessions land merge-able PRs more often.
- `pendingPrFeedback` is opt-in at the prompt level — empty by default, only the worker passes a populated array. Tests, dry runs, and the orientation flow all see the unchanged template.
- Bot accounts (`vercel[bot]`, `github-actions[bot]`, etc.) are excluded by a hard-coded deny list plus a `*[bot]` suffix rule, regardless of allowlist contents. The agent never reacts to CI noise.
- Adding new commenters (e.g. a future co-developer) means adding their login to the allowlist, currently configured by env var (`MAESTRO_FEEDBACK_ALLOWLIST` deferred to Sub 4 once the API has auth).

---

## ADR-024: Opt-in session continuation until budget exhausted

**Date**: 2026-05-02
**Decision**: Phase 4 / Sub 2 adds two `autonomy.json` fields — `continueUntilBudget` (default `false`) and `minTimeForContinuation` (default 900 s) — that turn one logical session into a chain of "turns" against the same `MAESTRO_DATA_DIR/work/<slug>` clone. Each turn opens its own PR. The session row's `pr_number` reflects the most recent turn; per-turn detail lives in a new `session_turns` table.

After turn N completes successfully, the worker:
1. Re-reads `.maestro/state.md` (the agent updated it on N's branch).
2. If there are more "Next Concrete Tasks" AND `total_budget − elapsed − overhead ≥ minTimeForContinuation`, calls `softResetForNextTurn(workingRoot, base)`:
   - Snapshots `.maestro/` from N's branch tip
   - `git fetch origin <base>`, checkout, hard-reset to `origin/<base>`
   - Restores the snapshotted `.maestro/` over the clean base — uncommitted, ready to be carried into N+1's branch by the agent's first commit.
3. Spawns Claude with a fresh budget = `remaining − CONTINUATION_TURN_OVERHEAD_SECONDS` and a CONTINUATION preamble in the prompt naming the turn number and previous PR numbers.
4. Records the new turn in `session_turns`. Loops until the predicate fails.

The chain stops when:
- the last turn's status is anything other than `completed`,
- the last turn produced no PR (orientation, no-changes),
- the next turn's budget would fall below `minTimeForContinuation`,
- the agent removed the last task from `state.md` (heuristic via `deriveTaskFromState`),
- or `softResetForNextTurn` fails (e.g. base branch missing).

**Reasoning**: Phase 1 sessions used 10–20 % of their 45-minute budget and stopped. The "ONE task per session" rule from PROMPT_DESIGN.md is correct for review hygiene, but it conflates "one task per *commit*" with "one task per *budget window*". With `level: full` already auto-merging each turn's PR (ADR-023), each turn lands as its own squash commit on main, so review hygiene is preserved even when a budget produces three PRs back-to-back. Continuation is the natural next step.

**Why opt-in**: Multi-turn sessions multiply token consumption against the developer's Pro/Max subscription. The default is `false` so existing projects do not silently start consuming N× more. The developer flips it on per project once they trust the loop.

**Why the soft-reset dance**: The agent's `state.md` updates live on its feature branch, not main. If we just reset to main between turns, the next turn would re-read the OLD state.md (with the task we just completed). The agent would then either redo the same task or get confused. Snapshotting `.maestro/` and restoring it on main is the smallest possible change that preserves the agent's reasoning thread across the boundary.

**Subscription cost impact**:
- Per logical session with N turns: ~N× input tokens (each turn re-reads context.md, state.md, journals, plus Sub 1's feedback section).
- Output tokens scale with the work each turn does (typically smaller than input).
- Each fixup turn within a turn (ADR-013) also re-spawns Claude. So a session with two turns and one gate failure consumes three Claude invocations.
- Recommendation in `docs/PROJECT_ONBOARDING.md`: enable on one project first, monitor rate-limit dashboard for a week, then expand.

**Alternatives considered**:
- (a) **Single-turn, longer budget** — increase `timeBudget` instead of multi-turn. Rejected because Claude Code's reliability degrades on very long single sessions and the agent doesn't naturally chunk work into PR-sized units without an explicit prompt boundary.
- (b) **Cherry-pick `.maestro/` commits across turns** instead of snapshot-restore. Rejected as more fragile (requires turn 1's commits to be cleanly separable, which we can't guarantee).
- (c) **Force the agent to commit `.maestro/` to main directly** (not a feature branch). Rejected — contradicts ADR-005 (PR-only default) and would split state changes from code changes in confusing ways.

**Implications**:
- New table `session_turns`. Existing single-turn sessions will have exactly one row in this table going forward; pre-existing sessions have none, which the dashboard handles by falling back to the parent `sessions` row.
- The session's `pr_number` continues to reflect "the latest PR" so existing dashboards keep working. The per-turn drill-down lives in `/api/sessions/:id` once the dashboard surfaces it (Sub 7 territory).
- `PROMPT_VERSION` is unchanged at `1.2.0` — the CONTINUATION preamble is opt-in via the prompt context, doesn't affect single-turn sessions.

---

## ADR-025: Claude Code baked into the image, OAuth persisted on the volume

**Date**: 2026-05-18
**Decision**: The runtime Docker image installs `@anthropic-ai/claude-code` globally and sets `CLAUDE_CONFIG_DIR=/data/claude`, so OAuth credentials live on the persistent volume and survive redeploys. Bootstrap is a one-time interactive step on the deploy host (`railway shell` → `claude /login`). A new `GET /api/health/claude` endpoint reports `{installed, version, authenticated, credentialsAt, configDir}`, and the dashboard shows a warning banner when the CLI is missing or unauthenticated.

**Reasoning**: ADR-001 committed to the subscription-backed CLI rather than API keys. The open question was where the CLI lives for a hosted deploy. Baking it into the image with volume-persisted config keeps ADR-001 intact: same auth model, same invocation pattern (ADR-011), zero code changes in the worker. The alternative — `ANTHROPIC_API_KEY` — would change billing (pay-per-token), require a claude-runner refactor, and contradict ADR-001 for no operational gain.

**Known risks**:
- OAuth token rotation/expiry requires re-running the bootstrap. The health endpoint + dashboard banner make this visible before sessions start failing silently.
- `authenticated` detection reads the credentials file under `CLAUDE_CONFIG_DIR`; on macOS the token lives in the Keychain, so the endpoint reports `null` ("unknown") there rather than a false negative.
- If Railway's interactive shell access regresses, the fallback is a plain VPS (documented in DEPLOYMENT.md) — the image works identically anywhere Docker runs.

**Subscription note**: heavy multi-project automation can hit Pro/Max weekly caps. The existing throttles (`maxSessionsPerDay`, cost-throttle skip rule, opt-in `continueUntilBudget`) are the mitigations; the health endpoint is the observability hook.

---

*Add new decisions above this line. Keep them numbered sequentially.*
