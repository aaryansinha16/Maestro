# Maestro — CLAUDE.md

## Project Identity

**Maestro** is an autonomous project management system for solo developers managing multiple GitHub projects in parallel. It runs on a server, schedules background work sessions across projects, makes meaningful progress autonomously, and reports back through a web dashboard and daily briefings.

The core problem it solves: a solo developer with 4-5 active projects cannot give equal attention to all of them. Some projects stagnate while others get attention. Maestro acts as a parallel workforce — autonomous agents that work on each project on a schedule, advancing real tasks while the developer focuses on whichever project is most important *right now*.

**This is NOT a CI/CD tool. This is NOT a noise commit generator. This is a serious AI engineering system that produces code worth merging.**

## Core Operating Principles

These are non-negotiable. Every architectural decision must respect these.

1. **Quality over activity.** If there's nothing meaningful to do on a project, the agent does nothing and reports back. Empty days are acceptable. Noise commits are not.

2. **Time-bounded autonomy.** Each session is bounded (default 45 minutes). The agent makes its own decisions within that window, then stops, commits, and reports.

3. **PR-first workflow.** The agent never pushes directly to main. It creates feature branches and opens PRs. The developer reviews and merges.

4. **Quality gates before PR.** Before opening a PR, the agent must verify: tests pass, lint passes, types compile. If quality gates fail, it commits the work to a branch flagged "needs review" but doesn't open a PR.

5. **The state file is the truth.** Every project has a `.maestro/` directory. State, journal, and decisions live there. The git repo is the canonical store. No machine-specific state.

6. **Daily review is mandatory.** The developer reviews briefings within 24 hours. The system is designed assuming this happens.

7. **The developer is the contributor.** All commits use the developer's git identity. The agent is a tool. The developer reviews, approves, and ships.

## How It Works

### The Conductor (Brain)

A long-running Node.js service on the developer's Railway VPS. Responsible for:

- Maintaining a registry of managed projects with their schedules and autonomy levels
- Triggering work sessions per project on a schedule
- Spawning Claude Code sessions in isolated working directories
- Monitoring sessions for completion or timeout
- Validating output via quality gates
- Creating PRs via GitHub API
- Updating state files
- Sending daily briefings
- Serving the web dashboard

### The Worker (Executor)

For each scheduled session:

1. Clone or pull the project's repo into a working directory
2. Read `.maestro/state.md` for current focus
3. Read `.maestro/context.md` for project background
4. Read recent journal entries for continuity
5. Construct a focused task prompt
6. Spawn Claude Code with the prompt and time budget
7. Monitor the process; kill at timeout
8. Run quality gates on resulting changes
9. If passing: create branch, commit, push, open PR
10. If failing: commit to branch with "needs-review" label, no PR
11. Append session summary to journal
12. Update state.md
13. Push state changes to repo

### The Dashboard (Interface)

A web app served from the VPS. The developer's primary interface for:

- Seeing all projects at a glance with their current state
- Reviewing recent agent sessions per project
- Approving/merging pending PRs
- Adjusting project autonomy settings
- Triggering manual work sessions
- Reading and replying to briefings
- Cost and usage tracking

### The Briefing (Notification Layer)

Once daily, Maestro sends a digest via Telegram bot:

- Summary of yesterday's work across all projects
- PRs awaiting review
- Blockers requiring developer input
- Cost summary
- Quick-action buttons for common responses ("merge all", "pause project X", etc.)

## Architecture

```
                    Railway VPS
                    
    ┌─────────────────────────────────────────────┐
    │            Maestro Conductor                  │
    │  (Node.js service, always running)            │
    │                                                │
    │  ┌────────────┐  ┌────────────┐  ┌──────────┐│
    │  │  Scheduler │  │ State Sync │  │ Briefing ││
    │  │   (cron)   │  │  (per repo)│  │  (cron)  ││
    │  └─────┬──────┘  └────────────┘  └──────────┘│
    │        │                                       │
    │  ┌─────▼──────────────────────────────────┐  │
    │  │       Session Spawner (Worker Pool)     │  │
    │  │  - Clones repo into /work/<project>     │  │
    │  │  - Reads .maestro/ files                │  │
    │  │  - Spawns: claude --print "<prompt>"     │  │
    │  │  - Monitors, kills at timeout            │  │
    │  │  - Runs quality gates                    │  │
    │  │  - Commits, pushes, creates PR           │  │
    │  └─────────────────────────────────────────┘  │
    │                                                │
    │  ┌─────────────────────────────────────────┐  │
    │  │         SQLite (local persistence)       │  │
    │  │  - sessions, runs, costs, projects       │  │
    │  └─────────────────────────────────────────┘  │
    │                                                │
    │  ┌─────────────────────────────────────────┐  │
    │  │         Web Dashboard (Vite + React)     │  │
    │  │       Served at maestro.<domain>        │  │
    │  └─────────────────────────────────────────┘  │
    └─────────────────────────────────────────────┘
                          │
                          ├── GitHub API (PRs, issues)
                          ├── Telegram Bot API (briefings)
                          └── Per-project git repos
                              (which contain .maestro/ folder
                              that travels with the code)
```

## Tech Stack

- **Node.js 22+** with **TypeScript** (strict mode)
- **Hono** for the HTTP server (smaller and faster than Express, fits the VPS)
- **better-sqlite3** for local persistence (sessions, costs, schedules)
- **node-cron** for scheduling
- **simple-git** for git operations
- **@octokit/rest** for GitHub API (PRs, issues, labels)
- **node-telegram-bot-api** for briefings
- **Vite + React + Tailwind** for the dashboard
- **Zustand** for dashboard state
- **execa** for spawning Claude Code processes
- **Zod** for runtime validation
- **Claude Code CLI** must be installed on the VPS and authenticated to the developer's subscription

## Project Structure

```
maestro/
├── CLAUDE.md                  # This file
├── AGENTS.md                  # Behavior patterns for AI coding
├── DECISIONS.md               # Architectural decision log
├── PRODUCT_VISION.md          # Product vision and roadmap
├── PROJECT_CONFIG.md          # Per-project autonomy decisions
├── README.md                  # Public-facing readme
│
├── package.json               # Root with workspaces
├── tsconfig.json
│
├── packages/
│   ├── conductor/             # The main service
│   │   ├── src/
│   │   │   ├── index.ts       # Entry point
│   │   │   ├── scheduler.ts   # Cron scheduling
│   │   │   ├── worker.ts      # Spawns Claude Code sessions
│   │   │   ├── quality-gates.ts  # Tests, lint, types
│   │   │   ├── pr-manager.ts  # GitHub PR operations
│   │   │   ├── state-manager.ts  # Reads/writes .maestro/ files
│   │   │   ├── briefing.ts    # Telegram digest generator
│   │   │   ├── db.ts          # SQLite layer
│   │   │   └── types.ts
│   │   └── package.json
│   │
│   ├── dashboard/             # Web UI
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── pages/
│   │   │   │   ├── Overview.tsx       # All projects grid
│   │   │   │   ├── ProjectDetail.tsx  # Per-project view
│   │   │   │   ├── Sessions.tsx       # Session history
│   │   │   │   ├── PRs.tsx            # Approval queue
│   │   │   │   └── Settings.tsx       # Per-project autonomy
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   └── store/
│   │   ├── package.json
│   │   └── vite.config.ts
│   │
│   ├── api/                   # Shared REST API definitions
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   ├── schemas.ts     # Zod schemas
│   │   │   └── types.ts
│   │   └── package.json
│   │
│   └── shared/                # Shared types
│       ├── src/
│       │   ├── types.ts
│       │   ├── constants.ts
│       │   └── prompt-templates.ts  # The prompts that drive sessions
│       └── package.json
│
├── scripts/
│   ├── setup-vps.sh           # First-time VPS setup
│   ├── add-project.ts         # Add a new project to Maestro
│   ├── trigger-session.ts     # Manually trigger a session
│   └── dev.sh                 # Local development
│
└── docs/
    ├── DEPLOYMENT.md          # How to deploy to Railway
    ├── PROJECT_ONBOARDING.md  # How to add a project
    └── PROMPT_DESIGN.md       # The prompts that make sessions work
```

## The .maestro/ Directory Contract

Every managed project has a `.maestro/` directory at its root. This is the most critical part of the system. It travels with the code, surviving across machines.

```
.maestro/
├── state.md          # Current focus, what's next, what's blocked
├── context.md        # Long-lived project context (rarely changes)
├── decisions.md      # Significant choices and rationale
├── autonomy.json     # This project's settings
└── journal/
    ├── 2026-04-15-08-00.md   # One file per session, timestamped
    ├── 2026-04-14-22-00.md
    └── ...
```

### state.md format

```markdown
# Current State

## Focus
[1-3 sentences on what we're working toward right now]

## Next Concrete Tasks
- [ ] Task 1 (concrete, doable in 30-60 min)
- [ ] Task 2
- [ ] Task 3

## Blockers
- Blocker 1: needs developer decision on X
- Blocker 2: waiting for external dependency

## Recent Context
[2-3 sentences on what just happened, what was just attempted]

## Notes
[Any other relevant context]
```

### context.md format

Stable project context. Architecture, conventions, key files, gotchas. The agent reads this every session. Should be 200-500 lines max.

### autonomy.json

```json
{
  "level": "pr-only",
  "schedule": "0 */4 * * *",
  "timeBudget": 2700,
  "qualityGates": ["test", "lint", "typecheck"],
  "branches": {
    "base": "main",
    "prefix": "maestro/"
  },
  "github": {
    "prLabels": ["maestro"],
    "draftByDefault": false
  },
  "skipDays": [],
  "maxSessionsPerDay": 6
}
```

### Autonomy levels

- **`full`** — agent can commit directly to main. Reserved for low-risk projects (small experiments, dotfiles, etc.). Rare.
- **`pr-only`** — agent opens regular PRs, developer merges. Default for most projects.
- **`draft-only`** — agent opens draft PRs that explicitly need review. For high-risk projects (anything financial, anything in production).
- **`paused`** — Maestro doesn't touch this project until unpaused.

## Quality Gates

Before opening a PR, every session must pass these gates. Configured per-project in `autonomy.json`. Common gates:

- **`test`** — runs `npm test` or equivalent. Must exit 0.
- **`lint`** — runs the project's lint command. Must exit 0.
- **`typecheck`** — runs `tsc --noEmit` or equivalent. Must exit 0.
- **`build`** — runs the build. Must exit 0.

If any gate fails, the agent gets one chance to fix it (a "fixup turn"). If still failing, the work commits to the branch but no PR is opened. The session report flags it as "quality-gate-failed" and the dashboard surfaces it for manual review.

## Prompt Design (The Hardest Part)

The system prompt for each Claude Code session matters more than the architecture. Bad prompts → noise commits. Good prompts → meaningful contributions.

The prompt template lives in `packages/shared/src/prompt-templates.ts`. It includes:

1. **Role framing** — "You are an autonomous developer working on a focused task within a time budget."
2. **The state.md content** — current focus, blockers
3. **Selected journal entries** — last 3 sessions for continuity
4. **Today's specific task** — derived from state.md "Next Concrete Tasks"
5. **Time budget** — explicit deadline
6. **Quality gates** — the project's specific requirements
7. **Output expectations** — commit format, what to update in state.md, what to write to journal

The system prompt should explicitly tell the agent:
- "If you can't make meaningful progress, do nothing and explain why."
- "If the task as described doesn't make sense given the current code, push back in the journal entry."
- "Update state.md before finishing. Append to journal. Commit cleanly."

## Code Conventions

- **Strict TypeScript everywhere** — `"strict": true` in all tsconfig
- **No `any` types** — use `unknown` and narrow
- **Zod schemas** for all external input (API requests, file content, GitHub responses, Telegram updates)
- **Named exports only** except React components
- **Error handling** — every async function wrapped, errors logged with context
- **Conventional commits** for Maestro itself: `feat:`, `fix:`, `refactor:`
- **For agent commits in managed projects** — the agent follows the project's existing commit conventions (read from `context.md`)

## What NOT to Do

- NEVER store API keys or secrets in `.maestro/` files (those are in repos)
- NEVER push to main directly except in `full` autonomy mode
- NEVER open more than 1 PR per project per session
- NEVER use `--no-verify` or skip quality gates
- NEVER make commits without the developer's git identity configured
- NEVER continue a session past its time budget
- NEVER manage projects without explicit `autonomy.json` in their `.maestro/` folder
- NEVER write to a project repo from outside a sandboxed working directory
- NEVER trust state from `.maestro/` files without Zod validation
- NEVER let one project's session hold up another (use job queues)
- NEVER spawn Claude Code in a directory that has uncommitted changes from a previous session

## Security Boundaries

- The conductor runs as a non-root user on the VPS
- Each project's working directory is isolated under `/work/<project-slug>/`
- Claude Code sessions can only write within their working directory
- GitHub auth uses a fine-grained personal access token scoped to the developer's repos
- The Telegram bot token is in env vars, not files
- The dashboard requires HTTP basic auth or magic link sign-in (developer is the only user)
- Webhook endpoints (if any) verify signatures
