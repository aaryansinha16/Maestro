# Maestro

> **Conductor for your codebases.** An autonomous project management system that
> runs your GitHub projects while you sleep — making meaningful progress, opening
> PRs for your review, and keeping every project moving forward in parallel.

Maestro is a server-side orchestration layer that turns Claude Code from an
interactive tool into an autonomous workforce. Schedule sessions across
multiple repositories, enforce quality gates before any commit reaches a PR,
and review the work each morning through a web dashboard and Telegram brief.

## What it does

- **Scheduled work sessions** across every repository under management
- **Time-bounded autonomy** — each session has a hard kill ceiling (default 45m)
- **Quality gates** (test, lint, typecheck, build) run before any PR opens
- **PR-only by default** — the developer is always the one who merges
- **`.maestro/` directory** in each repo tracks state, journal, decisions
- **Daily briefing** via Telegram with merge / pause / continue actions

## Why

A solo developer with 4-5 active projects cannot give equal attention to all
of them. Some projects stagnate while others get focus. Maestro acts as a
parallel workforce so every project advances meaningfully — without becoming
the source of noise commits.

Read the full pitch in [`PRODUCT_VISION.md`](./PRODUCT_VISION.md).

## Quick start

```bash
# Install dependencies (pnpm 10+, Node 22+)
pnpm install

# Copy and fill in environment variables
cp .env.example .env

# Boot conductor + dashboard
pnpm dev
# → conductor:  http://localhost:3000/api/health
# → dashboard:  http://localhost:5173
```

The dashboard renders an empty Overview page (no projects registered yet).
Adding projects, running sessions, and review flow arrive in subsequent phases.

## Project layout

```
maestro/
├── packages/
│   ├── shared/      Shared types, schemas, prompt templates, constants
│   ├── api/         Route schemas (Zod) — single source of truth for API shapes
│   ├── conductor/   The Hono server, SQLite, scheduler, worker
│   └── dashboard/   Vite + React + Tailwind UI
├── scripts/cli.ts   `maestro` CLI entry point
├── docs/            Deployment + onboarding guides
└── *.md             Vision, decisions, agents, prompts (read these)
```

## Documentation

- [`CLAUDE.md`](./CLAUDE.md) — architecture, conventions, the `.maestro/` contract
- [`PRODUCT_VISION.md`](./PRODUCT_VISION.md) — what we're building and why
- [`AGENTS.md`](./AGENTS.md) — patterns for AI coding on the Maestro codebase
- [`DECISIONS.md`](./DECISIONS.md) — architectural decision log
- [`PROMPT_DESIGN.md`](./PROMPT_DESIGN.md) — the most important file in the system
- [`PROJECT_CONFIG.md`](./PROJECT_CONFIG.md) — developer's per-project autonomy
- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — Railway deployment guide
- [`docs/PROJECT_ONBOARDING.md`](./docs/PROJECT_ONBOARDING.md) — how to add a project

## Status

Phase 2 — scheduling and parallelism. Single-project session execution is
verified end-to-end (Phase 1). Phase 1.5 added orientation mode, the context
scaffolder, doctor / reset / gc, cost tracking, and the dashboard's
ProjectDetail / Costs / PRs pages. Phase 2 layered cron-driven scheduling
on top: the scheduler enqueues sessions on each project's cron tick, the
job queue runs them up to `MAESTRO_MAX_PARALLEL` (default 2) concurrently,
six skip rules suppress dumb decisions, and a 5-strike auto-pause stops
scheduling on a project that's failing repeatedly.

**Scheduling is opt-in per project.** New projects start with
`scheduledEnabled: false`. The developer enables explicitly via
`maestro schedule enable <slug>` once manual sessions prove the project is
healthy. See [`docs/SCHEDULING.md`](./docs/SCHEDULING.md).

### Phase 2 env vars

- `MAESTRO_MAX_PARALLEL` — global concurrency limit (default 2)
- `MAESTRO_TZ` — cron timezone (default `UTC`)
- `MAESTRO_DEVELOPER_ACTIVITY_WINDOW_HOURS` — Rule A window (default 4)

## License

TBD (this repo is private until v1).
