# Project Onboarding

How to bring a project under Maestro management. The onboarding flow is
deliberately friction-heavy — better to spend an hour setting a project up
well than to have weeks of bad agent commits (per `PROJECT_CONFIG.md`).

The CLI commands referenced here (`maestro init`, `maestro add`, `maestro run`)
are real as of Phase 1. Phase 2 will add scheduling on top.

## Pre-flight

You need:

- `claude` CLI on PATH, OAuth'd via `claude /login` (ADR-001).
- `GITHUB_TOKEN` in the conductor's environment with write access to the
  repos you'll manage. Fine-grained PATs are preferred.
- `DEVELOPER_NAME`, `DEVELOPER_EMAIL`, `DEVELOPER_GITHUB_USERNAME` set so
  the agent's commits use your identity.

## 1. Initialise `.maestro/` interactively

In your project's clean working tree:

```bash
maestro init /path/to/your/project
```

The CLI:

- Verifies the path is a git repo with a clean working tree.
- Scrapes a starter `context.md` from `package.json`/`pyproject.toml`/`Cargo.toml`,
  README excerpt, and top-level layout.
- Asks for your current focus (1–3 sentences) and the initial 3–5 concrete tasks.
- Asks for autonomy level, cron schedule, time budget (minutes), and quality gates.
- Writes `.maestro/{state,context,decisions,autonomy}.{md,json}` plus an empty
  `journal/.gitkeep`.
- Validates everything it just wrote with the Zod schemas in `@maestro/shared`.

The autonomy levels are described in `CLAUDE.md`:

- `pr-only` — agent opens regular PRs, you merge. Default for most projects.
- `draft-only` — agent opens draft PRs that explicitly need review.
- `full` — agent opens a PR and auto-merges it (squash) once gates pass.
  Reserved for low-risk projects. If branch protection blocks the merge, the
  PR is left open and the session notes record the reason.
- `paused` — Maestro doesn't touch this project until unpaused.

## 2. Edit `context.md` to taste

The scrape is just a starting point. Open `.maestro/context.md` and add:

- Architecture overview, key files, conventions
- Commit message format (the agent follows yours, not Maestro's)
- Project-specific NEVER list (financial code paths, auth, etc.)
- Anything that would surprise a fresh agent

Keep it ~200–500 lines. The agent reads this every session.

## 3. Commit `.maestro/` to your project repo

```bash
cd /path/to/your/project
git add .maestro
git commit -m "chore: maestro init"
git push
```

The directory travels with the code (ADR-004). Both your active editor
sessions and Maestro's autonomous sessions read the same files.

## 4. Register the project with Maestro

```bash
maestro add https://github.com/<owner>/<repo>
```

This clones the repo to a temp directory, validates `.maestro/`, and inserts
a `projects` row. The slug is derived from `<owner>-<repo>` lower-cased.

## 5. Dry-run the first session

```bash
maestro run <slug> --dry-run
```

This prints the exact prompt the agent will receive — without spawning Claude.
Read it. If anything looks off, the fix is almost always in `state.md` or
`context.md`, not in the agent.

## 6. The real first session

```bash
maestro run <slug>
```

The conductor:

1. Acquires the per-project lock.
2. Refreshes its working clone under `MAESTRO_DATA_DIR/work/<slug>`.
3. Builds the prompt from `state.md`, `context.md`, and recent journal.
4. Spawns `claude -p` with a sandboxed working dir and the configured budget.
5. At budget − 5 min sends SIGTERM (graceful wrap-up); at budget sends SIGTERM;
   at budget + 30s SIGKILL.
6. Verifies the agent committed work on a feature branch and updated
   `state.md` + journal.
7. Runs your quality gates (`pnpm test`, `pnpm lint`, `pnpm typecheck`, etc).
8. If a gate fails, spawns one fixup turn (15-minute budget) and re-runs gates.
9. If all gates pass, pushes the branch and opens a PR.
10. If gates still fail, pushes the branch with a `quality-gates-failed` label
    but does NOT open a PR.

The whole session is logged to `MAESTRO_DATA_DIR/logs/sessions/<id>.log`.

For a brand-new project the **first** session is intentionally
orientation-only (see the FIRST SESSION preamble in
`packages/shared/src/prompt-templates.ts`). The agent reads, explores, and
expands `context.md` and `state.md` — it does not write code. The next
session starts real work.

## 7. Inspect what happened

```bash
maestro inspect <session-id>
```

Or open the dashboard at `http://localhost:5173` (in dev) and click the
session.

## 8. Review the PR carefully

The first 2 weeks of any project are for building trust with the system.
Review every PR. When something is wrong, update `state.md` or `context.md`
rather than trying to "fix" the agent.

## 9. Enable the schedule (Phase 2)

## 9. Enable the schedule (Phase 2)

Phase 2 ships scheduling as an opt-in feature. Every project starts with
`scheduledEnabled: false` — even if you wrote a `schedule` string in
`autonomy.json`. The intentional friction is so a fresh project can't
accidentally start firing before you've validated it with manual sessions.

Once 3-5 manual sessions on the project produce PRs you'd merge:

```bash
maestro schedule enable <slug>
```

The scheduler picks up the change on its next reconcile (default 30 s).
You can verify the registration and next-run time at the dashboard's
`/schedule` page or via `maestro schedule list`.

To stop scheduled runs without uninstalling:

```bash
maestro pause <slug> [--reason "..."]   # blocks scheduled and auto runs
maestro schedule disable <slug>          # unregisters the cron job
```

See [`docs/SCHEDULING.md`](./SCHEDULING.md) for the skip rules, the
auto-pause behaviour, and the troubleshooting guide.

## Quick reference

```bash
maestro init <path>                    # scaffold .maestro/ interactively
maestro add <repo-url>                 # register with the conductor
maestro list                           # registered projects
maestro run <slug> --dry-run           # print the prompt only
maestro run <slug>                     # real session
maestro inspect <session-id>           # session details + log tail
maestro doctor [<slug>]                # health check
maestro reset <slug>                   # blow away the working clone
maestro gc                             # garbage-collect stale clones
maestro schedule {enable,disable,list} # Phase 2 scheduling
maestro pause <slug>                   # pause scheduled + auto runs
maestro resume <slug>                  # clear pause / auto-pause
maestro queue                          # running / queued / completed
maestro skips <slug>                   # audit log per project
maestro status                         # conductor health
```
