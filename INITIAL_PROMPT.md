# Maestro — Initial Bootstrap Prompt

> **Usage**: Open Claude Code in the `maestro/` directory where CLAUDE.md, AGENTS.md, PRODUCT_VISION.md, PROJECT_CONFIG.md, DECISIONS.md, and PROMPT_DESIGN.md already exist. Paste this prompt to scaffold the project.

---

## The Bootstrap Prompt

```
Read CLAUDE.md, AGENTS.md, PRODUCT_VISION.md, PROJECT_CONFIG.md, DECISIONS.md, 
and PROMPT_DESIGN.md before doing anything else. Read all six in full.

Now bootstrap the Maestro monorepo per the architecture in CLAUDE.md.

This is Phase 0: Foundation Setup. The goal is a project skeleton that boots, 
runs the dashboard locally, and is ready to deploy to Railway. No actual 
session execution logic yet — that's Phase 1.

## What to build

### 1. Root configuration

- `package.json` with pnpm workspaces (the developer prefers pnpm), scripts:
  - `pnpm dev` — runs dashboard + conductor in watch mode (concurrently)
  - `pnpm build` — builds all packages
  - `pnpm test` — runs vitest across packages
  - `pnpm lint` — runs eslint
  - `pnpm typecheck` — runs tsc --noEmit per package
- `pnpm-workspace.yaml` pointing to `packages/*`
- Root `tsconfig.json` with project references
- `.gitignore` (Node, env files, sqlite db, working dirs)
- `.env.example` with all required vars (commented):
  - `ANTHROPIC_API_KEY` (only if needed for direct API; Claude CLI subscription is primary)
  - `GITHUB_TOKEN` (fine-grained PAT)
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID` (developer's chat id)
  - `MAESTRO_DATA_DIR` (where SQLite + working dirs live)
  - `MAESTRO_PORT` (default 3000)
  - `DEVELOPER_NAME` ("Aaryan Sinha")
  - `DEVELOPER_EMAIL` (the developer's GitHub email)
  - `DEVELOPER_GITHUB_USERNAME` ("aaryansinha16")
- ESLint config (flat config, modern), Prettier config

### 2. packages/shared

- `src/types.ts` — define ALL shared types:
  - Project, ProjectAutonomyLevel, ProjectAutonomyConfig
  - Session, SessionStatus, SessionResult
  - QualityGate, QualityGateResult
  - JournalEntry, ProjectState
  - PullRequest, PRStatus
  - Cost tracking types
- `src/schemas.ts` — Zod schemas for everything in types.ts
- `src/constants.ts` — defaults (DEFAULT_TIME_BUDGET, PROMPT_VERSION, etc.)
- `src/prompt-templates.ts` — the session prompt template per PROMPT_DESIGN.md, 
  with a `buildSessionPrompt(context)` function
- `src/errors.ts` — `MaestroError` class with structured context

### 3. packages/conductor

The main service. For Phase 0, just the skeleton:

- `src/index.ts` — entry point, starts Hono server
- `src/db.ts` — SQLite initialization, migrations directory
- `src/db/migrations/001_initial.sql` — schema:
  - projects (id, slug, repo_url, autonomy_config_json, created_at)
  - sessions (id, project_id, status, started_at, ended_at, cost_cents, prompt_version, branch_name, pr_number, journal_path)
  - quality_gate_runs (id, session_id, gate_name, status, output, ran_at)
  - briefings (id, sent_at, content, tg_message_id)
- `src/server.ts` — Hono app setup with placeholder routes:
  - `GET /api/health` returns 200
  - `GET /api/projects` returns []
  - `GET /api/sessions` returns []
- `src/scheduler.ts` — placeholder, will use node-cron
- `src/worker.ts` — placeholder, no-op for now
- `src/state-manager.ts` — placeholder
- `src/pr-manager.ts` — placeholder
- `src/quality-gates.ts` — placeholder
- `src/briefing.ts` — placeholder
- `src/logger.ts` — pino logger with structured context

### 4. packages/dashboard

- Vite + React + TypeScript + Tailwind setup
- Dark mode by default with the Maestro palette (deep navy #0B1929, amber #F59E0B accent)
- Inter font for UI, JetBrains Mono for code
- `src/App.tsx` — react-router with placeholder pages
- `src/pages/Overview.tsx` — empty grid that says "No projects yet — add one with `maestro add`"
- `src/pages/ProjectDetail.tsx` — placeholder
- `src/pages/Sessions.tsx` — placeholder
- `src/pages/PRs.tsx` — placeholder
- `src/pages/Settings.tsx` — placeholder
- `src/components/Layout.tsx` — sidebar navigation, header with status indicator
- `src/store/useStore.ts` — Zustand store skeleton
- `src/hooks/useApi.ts` — fetch wrapper for Hono API
- The dashboard should look polished even when empty — this is the daily-use 
  interface, not a debug tool

### 5. packages/api

A shared package with route schemas (input/output Zod) so the dashboard and 
conductor agree on shapes:

- `src/routes.ts` — define route input/output schemas
- `src/types.ts` — derived TypeScript types from schemas

### 6. CLI scaffolding

- `scripts/cli.ts` — entry point for the `maestro` CLI command
- Subcommands (placeholders OK):
  - `maestro add <repo-url>` — add a project (shows "not implemented" for now)
  - `maestro run <project>` — trigger a session manually (shows "not implemented")
  - `maestro list` — list projects (returns from API)
  - `maestro status` — system health
- Use a small CLI lib like `commander` or `cac`
- Bin entry in package.json

### 7. Deployment files

- `Dockerfile` for the conductor (Node 22, copies built artifacts, runs server)
- `railway.json` or `railway.toml` for Railway-specific config
- `docs/DEPLOYMENT.md` with step-by-step Railway deployment

### 8. Documentation

- `README.md` — public-facing readme. Include the Maestro tagline, what it does, 
  quick start, link to docs
- `docs/PROJECT_ONBOARDING.md` — how to add a project (skeleton, will be filled 
  later)

## What NOT to do in Phase 0

- Don't implement actual session execution
- Don't connect to GitHub or Telegram yet (env vars defined but unused)
- Don't write the prompt construction logic beyond the template (Phase 1)
- Don't add quality gate runners (Phase 1)
- Don't add scheduling logic (Phase 2)

## Verification before considering done

1. `pnpm install` runs cleanly from root
2. `pnpm build` succeeds across all packages
3. `pnpm dev` starts both conductor and dashboard
4. Dashboard renders at http://localhost:5173 with the Overview page showing 
   "No projects yet"
5. Conductor responds at http://localhost:3000/api/health with 200
6. `pnpm typecheck` passes
7. `pnpm lint` passes
8. The Dockerfile builds successfully (`docker build .`)

## Important reminders

- Strict TypeScript everywhere. Zero `any`s.
- Every external input validated with Zod.
- Use the developer's name (Aaryan Sinha) for git config and the 
  Telegram chat (read from env vars, never hard-coded).
- Use pnpm, not npm or yarn.
- Don't write placeholder TODO comments. Either implement properly or note in 
  the file header that "this is Phase X work" with reference to PRODUCT_VISION.md.
- Read the PROMPT_DESIGN.md template carefully and put it in 
  packages/shared/src/prompt-templates.ts as `SESSION_PROMPT_TEMPLATE_V1` 
  (preserving the version) with the `buildSessionPrompt` function ready for 
  Phase 1.

After scaffolding, give me a summary of what was built and the exact commands 
to run it locally.
```

---

## After Phase 0 — Next Prompts

### Phase 1: Single-project session execution (after Phase 0 verifies)

```
Phase 0 is complete and verified. Move to Phase 1: implement single-project 
session execution.

Read CLAUDE.md, AGENTS.md, and PROMPT_DESIGN.md again. Then implement:

[detailed Phase 1 prompt — Maestro Phase 1 from PRODUCT_VISION.md, but with 
specific implementation details about spawning Claude Code, time budget 
enforcement, quality gates, PR creation, and journal writing]
```

### Phase 2: Scheduling and parallelism

(Will be defined when Phase 1 is verified)

### Phase 3: Dashboard

(Will be defined when Phase 2 is verified)

---

## Tips for Working with Claude Code on This Project

1. **Each phase is a fresh session.** Open a new Claude Code conversation per 
   phase. The CLAUDE.md and other files give it the context it needs. Don't 
   try to do all phases in one long session.

2. **Use --dry-run extensively.** When testing prompt changes or new features, 
   run with --dry-run to see what would happen without it actually happening.

3. **Trust the .maestro/ files.** When something seems wrong, check state.md 
   and recent journal entries first. They tell you what the agent thought it 
   was doing.

4. **The first session on each managed project is the most important.** Spend 
   time on context.md and state.md before turning on automation.

5. **Review every PR carefully for the first 2 weeks.** Build trust with the 
   system before letting it run more frequently. After it's proven reliable, 
   reviews can be quicker.

6. **When Maestro produces a bad PR, the issue is almost always in state.md or 
   context.md.** Update those rather than trying to "fix" the agent.

7. **Don't optimize for activity.** The goal is meaningful progress. An empty 
   day where nothing was needed is fine. A day of bad commits is bad.
