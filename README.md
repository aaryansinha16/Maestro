# Maestro

> **Conductor for your codebases.** An autonomous project management system that
> runs your GitHub projects while you sleep — making meaningful progress, opening
> PRs for your review, and keeping every project moving forward in parallel.

Maestro is a server-side orchestration layer that turns Claude Code from an
interactive tool into an autonomous workforce. Schedule sessions across
multiple repositories, enforce quality gates before any commit reaches a PR,
and review the work each morning through a web dashboard.

It is not a CI/CD tool. It is not a noise-commit generator. It is an opinionated
system for solo developers managing 4–5 active projects in parallel, designed
around a single principle: **quality over activity**.

---

## Contents

- [Why Maestro](#why-maestro)
- [How it works](#how-it-works)
- [Features](#features)
- [Quick start](#quick-start)
- [Onboarding a project](#onboarding-a-project)
- [The `.maestro/` contract](#the-maestro-contract)
- [Autonomy levels](#autonomy-levels)
- [Quality gates](#quality-gates)
- [Scheduling](#scheduling)
- [Commands](#commands)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Future plans](#future-plans)
- [Documentation](#documentation)
- [Status](#status)
- [License](#license)

---

## Why Maestro

A solo developer running 4–5 active projects faces an impossible scheduling
problem. Each project demands attention. Context-switching between projects
costs hours. Some projects inevitably stagnate while others get focus. Days go
by without progress on important work — not because the developer is lazy, but
because attention is finite.

Existing AI coding tools (Claude Code, Cursor, Copilot) are designed for
*active* sessions. They require the developer to be present, choose the
project, and drive the conversation. None of them work autonomously across
multiple projects.

Maestro fills that gap: an orchestration layer that turns AI coding assistants
from interactive tools into autonomous agents that work on your projects in
parallel. The developer reviews PRs, makes high-level decisions, and merges.
Maestro handles the rest.

### Operating principles

These are non-negotiable. Every architectural decision respects them.

1. **Quality over activity.** If there is nothing meaningful to do on a
   project, the agent does nothing and reports back. Empty days are acceptable.
   Noise commits are not.
2. **Time-bounded autonomy.** Each session is bounded (default 45 minutes).
   The agent makes decisions within that window, then stops, commits, and
   reports.
3. **PR-first workflow.** The agent never pushes directly to main. It creates
   feature branches and opens PRs. The developer reviews and merges (with an
   opt-in `level: full` mode that auto-squash-merges once gates pass).
4. **Quality gates before PR.** Tests, lint, and types must pass before a PR
   opens. If gates fail, the work commits to a branch flagged "needs review"
   but no PR is opened.
5. **The state file is the truth.** Every project has a `.maestro/` directory
   with state, journal, and decisions. The git repo is the canonical store.
   No machine-specific state.
6. **Daily review is mandatory.** The system is designed assuming the
   developer reviews briefings and PRs within 24 hours.
7. **The developer is the contributor.** All commits use the developer's git
   identity. The agent is a tool. The developer reviews, approves, and ships.

---

## How it works

```
                    Railway VPS (or any Linux host)

    ┌────────────────────────────────────────────────────┐
    │                  Maestro Conductor                   │
    │                                                       │
    │  ┌──────────┐   ┌────────────┐   ┌──────────────┐  │
    │  │ Scheduler│   │ Skip rules │   │  Auto-pause  │  │
    │  │ node-cron│ → │ (6 layered)│ → │ (5 strikes)  │  │
    │  └──────────┘   └────────────┘   └──────────────┘  │
    │       │                                              │
    │       ▼                                              │
    │  ┌────────────────────────────────────────────────┐│
    │  │     Job queue (FIFO + priority + concurrency)   ││
    │  └────────────────────────────────────────────────┘│
    │       │                                              │
    │       ▼                                              │
    │  ┌────────────────────────────────────────────────┐│
    │  │              Session worker pool                ││
    │  │                                                  ││
    │  │  clone → read .maestro/ → spawn claude -p →     ││
    │  │  monitor budget → run quality gates →           ││
    │  │  commit → push → open PR → (auto-merge)         ││
    │  └────────────────────────────────────────────────┘│
    │                                                       │
    │  ┌──────────┐   ┌────────────┐   ┌──────────────┐  │
    │  │  SQLite  │   │  Hono API  │   │  Dashboard   │  │
    │  │  (WAL)   │   │  /api/*    │   │  Vite+React  │  │
    │  └──────────┘   └────────────┘   └──────────────┘  │
    └────────────────────────────────────────────────────┘
                          │
                          ├── GitHub API (PRs, issues, labels)
                          ├── Per-project working clones
                          └── Telegram bot (Phase 3)
```

### Session lifecycle

For each scheduled or manual session, the worker:

1. Acquires a per-project advisory lock (concurrency = 1 per project).
2. Refreshes the working clone under `MAESTRO_DATA_DIR/work/<slug>`.
3. Builds the prompt from `state.md`, `context.md`, and the last 3 journal
   entries.
4. Spawns `claude -p` with a sandboxed working dir and the configured budget.
5. At budget − 5 min sends SIGTERM (graceful wrap-up); at budget sends SIGTERM;
   at budget + 30s sends SIGKILL.
6. Verifies the agent committed work on a feature branch and updated
   `state.md` + journal.
7. Runs the project's quality gates (`pnpm test`, `pnpm lint`, `pnpm typecheck`,
   etc).
8. If a gate fails, spawns one fixup turn (15-minute budget) and re-runs gates.
9. If all gates pass, pushes the branch and opens a PR. In `level: full` mode,
   the PR is auto-squash-merged immediately. If branch protection blocks the
   merge, the PR is left open with a note in the session results.
10. If gates still fail, pushes the branch with a `quality-gates-failed` label
    but does NOT open a PR.

The whole session is logged to `MAESTRO_DATA_DIR/logs/sessions/<id>.log`.

---

## Features

**Shipped (Phases 0 → 2):**

- Multi-project monorepo with strict TypeScript everywhere
- `maestro` CLI for project init, add, run, inspect, doctor, gc, pause/resume
- Per-project working clones, isolated under the data directory
- Time-bounded sessions with three-stage termination (SIGTERM, SIGTERM, SIGKILL)
- Stack auto-detection for Node, Python, Rust — gates inferred from manifests
- Quality gates: `test`, `lint`, `typecheck`, `build` — configurable per project
- One-shot fixup turn when a gate fails
- GitHub PR creation via Octokit, with retry/backoff for rate limits
- `level: full` auto-squash-merge with graceful fallback when blocked
- Cron-driven scheduling with hot-reload (30s reconcile loop)
- 6 layered skip rules: auto-pause, manual-pause, skip-day, max-sessions/day,
  failure-backoff, cost-throttle, developer-recently-active
- 5-strike auto-pause with manual-trigger override and clean-restart recovery
- In-memory job queue with SQLite persistence, FIFO + priority + concurrency
- Cost tracking from Claude session output, with monthly budget enforcement
- React dashboard: Overview, Sessions, Session detail, Schedule, Queue, PRs,
  Project detail
- REST API surface (`/api/projects`, `/api/sessions`, `/api/queue`,
  `/api/schedule`, `/api/trigger`)
- SQLite migrations system with crash-safe boot recovery
- Structured logging with Pino, scoped per session

**Coming next** — see [Future plans](#future-plans).

---

## Quick start

### Prerequisites

- Node 22+ (the repo ships an `.nvmrc` — run `nvm use`)
- pnpm 10+
- `claude` CLI on PATH, authenticated via `claude /login`
- A fine-grained GitHub PAT with read/write access to the repos you'll manage

### Install and boot

```bash
git clone https://github.com/aaryansinha16/Maestro.git
cd Maestro
nvm use                # picks up Node 22 from .nvmrc
pnpm install
cp .env.example .env   # fill in DEVELOPER_NAME, GITHUB_TOKEN, etc.
pnpm dev               # boots conductor + dashboard concurrently
```

Once running:

- **Conductor** — `http://localhost:3000/api/health`
- **Dashboard** — `http://localhost:5173`

### Onboarding a project

```bash
# 1. Initialise .maestro/ inside the project
maestro init /path/to/your/project

# 2. Commit .maestro/ to the project's repo
cd /path/to/your/project
git add .maestro && git commit -m "chore: maestro init" && git push

# 3. Register with the conductor
maestro add https://github.com/<owner>/<repo>

# 4. Dry-run to inspect the prompt
maestro run <slug> --dry-run

# 5. Real first session (orientation-only by default for new projects)
maestro run <slug>

# 6. Once a few manual sessions look good, enable scheduling
maestro schedule enable <slug>
```

The full walkthrough lives in [`docs/PROJECT_ONBOARDING.md`](./docs/PROJECT_ONBOARDING.md).

---

## The `.maestro/` contract

Every managed project has a `.maestro/` directory at its root. This is the
most critical part of the system — it travels with the code, surviving across
machines and developers.

```
.maestro/
├── state.md          # Current focus, what's next, what's blocked
├── context.md        # Long-lived project context (rarely changes)
├── decisions.md      # Significant choices and rationale
├── autonomy.json     # This project's settings
└── journal/
    ├── 2026-04-15-08-00.md   # One file per session, UTC timestamped
    ├── 2026-04-14-22-00.md
    └── ...
```

The agent reads `state.md` and `context.md` every session. The journal is
append-only — it preserves the chain of reasoning across sessions and gives
the next agent (or you) full context on what was attempted, what worked, and
what didn't.

Both your active editor sessions and Maestro's autonomous sessions read the
same files. There is no machine-specific state.

---

## Autonomy levels

Configured in each project's `.maestro/autonomy.json`.

| Level | Behavior |
|---|---|
| `pr-only` | Agent opens regular PRs, developer merges. **Default for most projects.** |
| `draft-only` | Agent opens draft PRs that explicitly need review. For high-risk projects (anything financial, anything in production). |
| `full` | Agent opens a PR and auto-squash-merges it once gates pass. Branch protection failures leave the PR open with a note. Reserved for low-risk projects. |
| `paused` | Maestro doesn't touch this project until unpaused. |

---

## Quality gates

Configured per-project in `autonomy.json`. Common gates:

- **`test`** — `pnpm test` or equivalent. Must exit 0.
- **`lint`** — project's lint command. Must exit 0.
- **`typecheck`** — `tsc --noEmit` or equivalent. Must exit 0.
- **`build`** — production build. Must exit 0.

If any gate fails, the agent gets one fixup turn (15-minute budget). If still
failing, the work commits to the branch but no PR opens — the session report
flags it as `quality-gate-failed` and the dashboard surfaces it for manual
review.

---

## Scheduling

Scheduling is **opt-in per project**. New projects start with
`scheduledEnabled: false` even if their `autonomy.json` has a cron string.
This is intentional: the "first few manual sessions prove the project is
healthy" rule is what separates scheduled sessions producing PRs you'd merge
from scheduled sessions producing noise.

Once a few manual sessions look good:

```bash
maestro schedule enable <slug>
```

The scheduler reconciles every 30 seconds, so schedule edits hot-reload.

### Skip rules (cheapest-first)

| # | Rule | Reason code |
|---|------|-------------|
| D | Project is auto-paused (5 consecutive failures) | `auto-paused` |
| — | Project is manually paused (`autonomy.json level=paused`) | `manual-paused` |
| C | Today is in `skipDays` | `skip-day` |
| B | `maxSessionsPerDay` cap reached | `max-sessions-per-day` |
| F | 3+ consecutive failed sessions | `failure-backoff` |
| E | Cost throttle: ≥80% → skip low-priority; ≥95% → skip everything | `cost-throttle-*` |
| A | Developer committed in last `MAESTRO_DEVELOPER_ACTIVITY_WINDOW_HOURS` (default 4) | `developer-recently-active` |

Manual triggers (`maestro run <slug>`, dashboard "trigger now") bypass all
skip rules and jump ahead of any queued scheduled jobs.

The full reference, including the auto-pause behavior and a troubleshooting
guide, is in [`docs/SCHEDULING.md`](./docs/SCHEDULING.md).

---

## Commands

```bash
maestro init <path>                    # scaffold .maestro/ interactively
maestro add <repo-url>                 # register a project with the conductor
maestro list                           # registered projects
maestro run <slug> [--dry-run]         # trigger a session (or print the prompt)
maestro inspect <session-id>           # session details + log tail
maestro doctor [<slug>]                # health check
maestro reset <slug>                   # blow away the working clone
maestro gc                             # garbage-collect stale clones

maestro schedule enable <slug>         # enable cron scheduling
maestro schedule disable <slug>        # unregister the cron job
maestro schedule list                  # registered schedules + next-run times

maestro pause <slug> [--reason "..."]  # block scheduled and auto runs
maestro resume <slug>                  # clear pause / auto-pause
maestro queue                          # running / queued / completed jobs
maestro skips <slug>                   # audit log per project
maestro status                         # conductor health
```

---

## Configuration

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `DEVELOPER_NAME` | (required) | Used for git commits made on the developer's behalf |
| `DEVELOPER_EMAIL` | (optional) | Same |
| `DEVELOPER_GITHUB_USERNAME` | (required) | Same |
| `GITHUB_TOKEN` | (optional in Phase 0) | Required to open PRs. Fine-grained PAT preferred |
| `MAESTRO_DATA_DIR` | `./data` | Where SQLite + working clones live. **Resolved against the `.env` file's directory**, not `cwd` |
| `MAESTRO_PORT` | `3000` | Hono server port |
| `MAESTRO_MAX_PARALLEL` | `2` | Global ceiling on concurrent sessions |
| `MAESTRO_TZ` | `UTC` | Timezone for cron expressions |
| `MAESTRO_DEVELOPER_ACTIVITY_WINDOW_HOURS` | `4` | Skip rule A window |
| `MAESTRO_BUDGET_USD` | `50` | Monthly Anthropic spend cap (rule E) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | (optional) | Daily briefing — Phase 3 |
| `ANTHROPIC_API_KEY` | (optional) | Only if direct API calls become necessary; the default path uses the local `claude` CLI |

### Per-project `autonomy.json`

```json
{
  "level": "pr-only",
  "schedule": "0 */6 * * *",
  "scheduledEnabled": false,
  "timeBudget": 2700,
  "qualityGates": ["test", "lint", "typecheck"],
  "branches": { "base": "main", "prefix": "maestro/" },
  "github": { "prLabels": ["maestro"], "draftByDefault": false },
  "skipDays": ["saturday", "sunday"],
  "maxSessionsPerDay": 6,
  "priority": "normal"
}
```

---

## Project layout

```
maestro/
├── packages/
│   ├── shared/      # Domain types, Zod schemas, prompt templates, constants
│   ├── api/         # Route schemas (Zod) — single source of truth for API shapes
│   ├── conductor/   # Hono server, SQLite, scheduler, worker, PR manager
│   └── dashboard/   # Vite + React + Tailwind UI
├── scripts/
│   ├── cli.ts       # `maestro` CLI entry point
│   └── cli/         # Subcommand implementations
├── docs/            # Deployment, onboarding, scheduling, learnings
└── *.md             # Vision, decisions, agents, prompts (read these)
```

---

## Future plans

The roadmap below sequences the most-impactful work first. Items behind a
flag are experiments — they ship behind `autonomy.json` toggles so we can
A/B against the established baseline.

### A. PR feedback loop
When you (or a code-review agent) leave a review comment on a Maestro PR,
the next session pulls those comments via the GitHub API and folds them into
the prompt. Turns one-shot PRs into a real conversation without manual
translation back into `state.md`.

### I. Session continuation until budget
Today the prompt instructs the agent to do ONE task and stop. With
`autonomy.json.continueUntilBudget: true`, after a successful PR is opened
(or auto-merged in `level: full`), the worker re-spawns Claude on the
updated `state.md` if there's enough budget left for another task slice.
Pairs naturally with A — together they convert a session from one-shot to
a real loop.

### B. Telegram daily briefing
A daily digest of yesterday's work across projects: PRs awaiting review,
blockers, cost summary, with quick-action buttons ("merge all", "pause X",
"reply to question Y"). The infra is already wired in `package.json`; the
glue isn't.

### C. PR previews
- **C1** — consume Vercel/Netlify preview-deployment links from PR comments
  and surface them in the dashboard.
- **C2** — Playwright-based screenshot or screencast on PR open, attached
  via PR comment. Opt-in via `autonomy.json.previewCommand`.

### D. Reviewer-agent experiment
A fresh-context Claude session reads the diff before the PR opens. Outputs
a structured review pasted into the PR body, with an optional `should-block`
flag that converts the PR to draft. Behind a flag.

### E. Cost & observability surface
The cost data already exists in SQLite; the dashboard doesn't graph it yet.
Add per-project spend, forecast vs. budget, and expensive-session alerts.

### F. Production hardening
- Dashboard auth (magic link or basic auth)
- SQLite WAL backup + restore script
- Log rotation under `MAESTRO_DATA_DIR/logs`

### G. Planner-agent experiment
A fast planning pass before coding starts decomposes a fuzzy `state.md`
task into 2–3 concrete sub-tasks with file pointers. The coding session
takes one. Pair with D as a "two-pass" mode behind a flag.

### H. Multi-project intelligence
A `maestro suggest` CLI / endpoint that ranks projects by recent activity,
blocker count, days-since-last-PR, and answers "what should I work on this
morning?" via the briefing or the dashboard.

---

## Documentation

- [`CLAUDE.md`](./CLAUDE.md) — architecture, conventions, the `.maestro/` contract
- [`PRODUCT_VISION.md`](./PRODUCT_VISION.md) — problem, solution, target user, brand
- [`AGENTS.md`](./AGENTS.md) — patterns for AI coding on the Maestro codebase
- [`DECISIONS.md`](./DECISIONS.md) — architectural decision log (ADR-001 onward)
- [`PROJECT_CONFIG.md`](./PROJECT_CONFIG.md) — per-project autonomy decisions
- [`docs/PROJECT_ONBOARDING.md`](./docs/PROJECT_ONBOARDING.md) — how to add a project
- [`docs/SCHEDULING.md`](./docs/SCHEDULING.md) — scheduling, skip rules, troubleshooting
- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — Railway / VPS deployment
- [`docs/REAL_PROJECT_LEARNINGS.md`](./docs/REAL_PROJECT_LEARNINGS.md) — notes from onboarding the first real project

---

## Status

Phase 2 complete (scheduling and parallelism). The single-project execution
loop is verified end-to-end on a real project. Phase 3 (PR feedback loop,
session continuation, Telegram briefing, dashboard polish) is the active
focus — see [Future plans](#future-plans).

This is a personal project of [@aaryansinha16](https://github.com/aaryansinha16),
built first for one developer's workflow before generalizing. Feedback,
issues, and PRs welcome — but expect opinionated answers about scope.

---

## License

TBD. The repo is currently source-available for review and discussion;
licensing terms will be set when v1 ships.
