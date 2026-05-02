# Maestro — Architectural Decision Log

Record every non-trivial technical decision here. Format: number, date, decision, reasoning, alternatives considered.

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

## ADR-002: Hono over Express

**Date**: 2026-04-28  
**Decision**: Use Hono as the HTTP server framework.

**Reasoning**: Smaller bundle, faster, modern TypeScript-first API, runs on Node and edge runtimes (gives us flexibility later). For a server with a few dozen endpoints, the simplicity is worth it.

**Alternatives**:
- (a) Express — mature but bloated, less type-safe by default
- (b) Fastify — fast but more complex
- (c) Bare Node http — too low-level

## ADR-003: SQLite for Persistence

**Date**: 2026-04-28  
**Decision**: better-sqlite3 for all conductor state (sessions, costs, briefings).

**Reasoning**: Single-user system on a single VPS. SQLite is fast, file-based, zero-config. Postgres would be overkill. The .maestro/ files in repos are the source of truth for project state — SQLite is just for operational state (what sessions ran, when, what they cost).

**Alternatives**:
- (a) Postgres — overkill, adds deployment complexity
- (b) JSON files — fine but no querying
- (c) DuckDB — interesting for analytics but unnecessary

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

## ADR-005: PR-Only Default Autonomy

**Date**: 2026-04-28  
**Decision**: Default autonomy is `pr-only`. The agent never pushes to main. Direct pushes (`full` autonomy) require explicit per-project opt-in.

**Reasoning**: Code review is the proven mechanism for catching mistakes. The 30 seconds it takes to review a small PR is worth far more than the 30 minutes it takes to revert a bad direct push. PRs also create natural audit trails.

**Alternatives**:
- (a) `full` default — risky, contrary to system goals
- (b) Always `draft-only` — too friction-heavy for trusted projects

## ADR-006: Quality Gates Are Pre-PR, Not Pre-Commit

**Date**: 2026-04-28  
**Decision**: The agent commits work before running quality gates. Gates run after commit, before PR creation. If gates fail, the branch exists but no PR opens.

**Reasoning**: The agent's work has value even if it doesn't pass gates — it might be 90% there, just needing one fix. Committing first preserves the work. The branch with failing gates becomes a "work in progress" that the developer can fix manually if desired.

**Alternatives**:
- (a) Pre-commit gates that abort the work — loses partial progress
- (b) No gates at all — produces low-quality PRs

## ADR-007: Time Budget Enforced via Process Kill

**Date**: 2026-04-28  
**Decision**: Sessions have a hard time budget (default 45 min). At budget expiry, the Claude Code process is killed (SIGTERM, then SIGKILL after 30s).

**Reasoning**: Without a hard limit, sessions can run indefinitely on hard problems. Hard kill is harsh but correct — better to lose 5 minutes of work than to have one project consume the whole conductor.

**Alternatives**:
- (a) Soft budget with warnings — agent ignores warnings
- (b) Cooperative cancellation — Claude Code doesn't support it natively
- (c) Adaptive budgets — too complex for v1

**Implications**: The agent is told its budget upfront and is instructed to "wrap up cleanly with 5 minutes left." Most sessions self-terminate before kill.

## ADR-008: Sequential Sessions Per Project, Parallel Across Projects

**Date**: 2026-04-28  
**Decision**: Two sessions on the same project never run concurrently. Sessions on different projects can run in parallel up to a global concurrency limit.

**Reasoning**: Two agents on the same project would create merge conflicts and confused state. Different projects don't interfere with each other. Global limit prevents resource exhaustion.

**Alternatives**: 
- (a) Always sequential — wastes idle time
- (b) Always parallel — same-project conflicts

## ADR-009: GitHub-Only for v1

**Date**: 2026-04-28  
**Decision**: v1 supports only GitHub repositories. GitLab, Bitbucket, self-hosted Git deferred.

**Reasoning**: The developer uses GitHub. Octokit is mature. GitLab support is a future expansion, not v1 work.

## ADR-010: Telegram for Briefings, Web for Detail

**Date**: 2026-04-28  
**Decision**: Telegram bot for daily push briefings. Web dashboard for everything else.

**Reasoning**: Telegram has a great bot API, free, the developer already uses it. Push notifications work everywhere. The dashboard is for review and control — too complex for chat.

**Alternatives**:
- (a) Email briefings — pushy, less interactive
- (b) Slack — only relevant if developer uses Slack
- (c) Mobile app — overkill for v1

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

## ADR-012: Per-project lock via SQLite row-with-pid

**Date**: 2026-04-28
**Decision**: Per-project advisory locks live in a SQLite `project_locks` table with `project_id` as the primary key. Lock acquisition is `INSERT OR ABORT` (atomic via the unique constraint) and the row records the holder's pid + session id.

On startup, the conductor releases any locks whose pid matches the current process — so a crashed conductor reclaims its own locks rather than leaving them stuck. On acquire, if a lock exists but the holder pid is dead (signal-0 probe), we steal it.

**Reasoning**: SQLite has no native session locks. The alternative — a filesystem flock — works on a single machine but doesn't expose the holder identity to the dashboard, makes inspection harder, and would require a separate lockfile path scheme. Embedding the lock in the same SQLite file the rest of the operational state lives in keeps everything atomic and queryable.

**Implications**:
- The conductor is single-tenant per host. Running two conductors against the same SQLite file would still serialise correctly (SQLite's PRIMARY KEY is atomic), but the pid-staleness check assumes you're checking pids on the same host. That's fine for v1.
- ADR-008 (sequential per-project) is now enforced at the data layer, not just the application layer.

## ADR-013: Quality-gate-failed → exactly one fixup turn

**Date**: 2026-04-28
**Decision**: When quality gates fail after the agent's commit, Maestro spawns exactly one fixup turn with a 15-minute budget (`FIXUP_TURN_BUDGET_SECONDS`). If gates still fail after the fixup, the branch is pushed and labelled `quality-gates-failed` (when the GitHub client is configured) but no PR opens.

**Reasoning**: Repeated fixup turns turn into thrashing; the 15-minute budget is what PROMPT_DESIGN.md specified. One retry catches the common case (a missing import, a typo, a small logic error the test surfaced) while bounding cost.

**Alternatives**:
- (a) No fixup turn — wastes the agent's earlier work when a one-line fix would unblock it.
- (b) Multiple fixup turns — diminishing returns; if the first fixup didn't work the issue likely needs human review.

**Implications**: Each fixup turn is recorded as a separate session row with `is_fixup_turn = 1` and `parent_session_id` set. The dashboard shows the fixup as a child session.

## ADR-014: Whitelist environment for the agent process

**Date**: 2026-04-28
**Decision**: When spawning `claude` (and quality-gate processes), pass through only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`, and `CI`. The full conductor process environment is **not** forwarded.

**Reasoning**: The conductor's environment contains `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, future API keys, and developer dotfiles that would otherwise leak into agent shell sessions. The whitelist gives the agent enough to run tests and build tools without exposing operational secrets.

**Implications**: If a managed project's tests genuinely need an environment variable, the agent has to ask via state.md and the developer adds it explicitly to the conductor's allowlist. We accept that friction in exchange for the security boundary.

---

*Add new decisions above this line. Keep them numbered sequentially.*
