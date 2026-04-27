# Maestro — Product Vision

## One-Liner

Maestro is an autonomous project management system that runs your GitHub projects while you sleep — making meaningful progress, opening PRs for your review, and keeping every project moving forward in parallel.

## The Problem

A solo developer running multiple active projects faces an impossible scheduling problem. Each project demands attention. Context-switching between projects costs hours. Some projects inevitably stagnate while others get focus. Days go by without progress on important work. Github contribution graphs have empty stretches not because the developer is lazy but because attention is finite.

The current state-of-the-art tools (Claude Code, Cursor, Copilot) are all designed for *active* development sessions. They require the developer to be present, choosing the project, driving the conversation. None of them work autonomously across multiple projects.

The market gap: an orchestration layer that turns AI coding assistants from interactive tools into autonomous agents that work on your projects in parallel.

## The Solution

Maestro is a server-side conductor that:

1. Knows about all your active projects
2. Maintains structured state for each (current focus, blockers, recent decisions)
3. Schedules work sessions across projects automatically
4. Spawns Claude Code in isolated environments to do the actual work
5. Enforces quality gates (tests, lint, types) before allowing commits
6. Opens PRs for your review
7. Reports progress through a daily briefing and a web dashboard
8. Keeps every project moving without you being the bottleneck

The developer reviews PRs daily, makes high-level decisions, and merges. Maestro handles the rest.

## Target User

Initially: **the developer building it.** This is the right starting position — solve your own problem first, prove it works, then expand.

Eventually: **solo developers and small teams managing 3+ active repositories.** Indie hackers, technical founders, prolific open-source maintainers, AI engineers running multiple experiments. The kind of developer whose biggest problem is not skill or tools but parallel attention.

## Core Experiences

### The Morning Briefing

You wake up. Your phone has a Telegram message from Maestro:

> Good morning. Last night across your 5 projects:
> 
> **3 PRs ready for review:**
> - TripKaptan: Fixed booking confirmation race condition (#142)
> - Devovia: Added rate limiting to API gateway (#89)  
> - AI-Trader: Refactored signal aggregation, added 4 tests (#56)
> 
> **1 blocker needs your input:**
> - AIFlowo: Agent ran into a design question about whether to use server-sent events or websockets for the agent feed. Replied with options in journal.
> 
> **1 project paused itself:**
> - Agent Studio: Recent state.md says "waiting on visual design" — agent did nothing, which is correct.
> 
> Total cost overnight: $4.20 across 12 sessions.

You spend 15 minutes reviewing the 3 PRs, merging 2, requesting changes on 1. You reply "websockets" to the AIFlowo question. By 9am you've moved 4 projects forward and you haven't even started your real work day.

### The Dashboard

You open `maestro.yourdomain.com` on your laptop. You see a grid of all your projects. Each card shows:

- Project name and current state.md focus
- Recent activity timeline (last 7 days, agent + human commits)
- Pending PRs with one-click review
- Cost this month
- Autonomy level (with quick toggle)

You click into TripKaptan. You see the full session history for the past week. Each session shows: what the agent did, why, what worked, what didn't. You can read the journal entries chronologically. You feel completely informed about a project you haven't actively touched in days.

### Active Development

You decide to work on Devovia today. You sit down at your laptop, open the project, run `claude`. Claude Code reads `.maestro/state.md` and `.maestro/journal/` automatically. You're up to speed in seconds. You make changes, commit. The journal updates with your session too. Maestro knows you were active and won't run an autonomous session today on Devovia.

The .maestro/ folder ensures both your active sessions and Maestro's autonomous sessions share the same context. No matter which laptop you use. No matter who's working — you or the agent.

### Adding a New Project

You create a new project: `tinyrepo`. You initialize it. You run:

```bash
maestro add tinyrepo --autonomy pr-only --schedule "0 */6 * * *"
```

This creates `.maestro/` in the repo, registers it with the conductor, and starts scheduling sessions. The first session generates an initial `context.md` by reading the codebase. From the next session onward, real work begins.

## Phased Roadmap

### Phase 0: Foundation Setup (Day 1)

**Goal**: Project skeleton, infrastructure, deployable shell.

- [ ] Monorepo with workspaces
- [ ] TypeScript strict mode everywhere
- [ ] Hono server boots on the VPS
- [ ] SQLite initializes with empty schema
- [ ] Vite dashboard renders "Hello Maestro" page
- [ ] Deployable to Railway

**Milestone**: Empty system runs on Railway. Dashboard accessible.

### Phase 1: Manual Single-Project Sessions (Days 2-4)

**Goal**: Prove the core loop works, end-to-end, on one project.

- [ ] Add project to Maestro via CLI command
- [ ] `.maestro/` directory created and validated
- [ ] Manually trigger a session: `maestro run <project>`
- [ ] Worker clones repo, reads state, spawns Claude Code
- [ ] Time budget enforced (kills process at limit)
- [ ] Quality gates run (test, lint, typecheck)
- [ ] If passing: commit, push, PR created
- [ ] If failing: branch committed with label
- [ ] Session journal written
- [ ] state.md updated

**Milestone**: One real session, on one real project, produces a real PR you'd merge.

### Phase 2: Scheduling and Parallelism (Days 5-7)

**Goal**: Multiple projects, automatic scheduling.

- [ ] Cron-based scheduling per project
- [ ] Parallel session execution (no project blocks another)
- [ ] Session queue with concurrency limits
- [ ] Per-project autonomy.json respected
- [ ] Project pause/resume
- [ ] Skip days configuration

**Milestone**: 3 projects scheduled, running on cadences, all producing PRs.

### Phase 3: The Dashboard (Days 8-12)

**Goal**: Visual interface that makes the system useful daily.

- [ ] Project overview grid
- [ ] Project detail page with session history
- [ ] PR approval queue
- [ ] Session detail view (what agent did, why)
- [ ] Cost tracking and graphs
- [ ] Autonomy settings UI
- [ ] Manual session trigger from UI
- [ ] Light/dark mode (developer preference)

**Milestone**: Dashboard is the daily-use interface. CLI is rarely needed.

### Phase 4: Telegram Briefing (Days 13-15)

**Goal**: Daily push notifications with quick actions.

- [ ] Telegram bot setup
- [ ] Daily briefing cron at developer's chosen time
- [ ] Briefing includes summary, PRs, blockers, cost
- [ ] Inline buttons for common actions
- [ ] Reply parsing for natural-language commands ("merge all", "pause X")

**Milestone**: Morning routine works without opening the dashboard.

### Phase 5: Smart Task Selection (Days 16-21)

**Goal**: Better autonomous decisions about what to work on.

- [ ] Analyze open issues to suggest tasks
- [ ] Detect TODOs in code, propose addressing them
- [ ] Test coverage analysis, propose new tests
- [ ] Stale dependency detection, propose updates
- [ ] Integration with GitHub issue assignment

**Milestone**: Agent finds meaningful work even when state.md is sparse.

### Phase 6: Polish and Public Release (Days 22-30)

**Goal**: Shippable open-source project.

- [ ] Documentation site (vitepress)
- [ ] Onboarding wizard for new users
- [ ] Project templates for common stacks
- [ ] Webhook integrations (deploy hooks, etc.)
- [ ] Multi-developer support (if branching out from solo)
- [ ] Public release on GitHub

**Milestone**: First external user adopts Maestro. Maestro itself is being maintained by Maestro.

## Differentiation

| Tool | Active or Passive | Multi-project | Quality Gates | Daily Briefing |
|---|---|---|---|---|
| Claude Code | Active | Single session | Manual | None |
| Cursor | Active | Single | Manual | None |
| GitHub Copilot | Active | Single | None | None |
| Devin / Cognition | Both | Single task | Yes | None |
| Sweep / etc | Passive | Per-task | Yes | None |
| **Maestro** | **Passive** | **Many in parallel** | **Yes** | **Yes** |

The competitive position: nothing else is built around the workflow of a solo developer with 5 active projects who needs autonomous parallel progress.

## Non-Goals

- We are NOT building a code editor — agents use Claude Code
- We are NOT building a CI/CD system — quality gates are pre-PR, not deployment
- We are NOT replacing GitHub Issues / Linear / Plane — projects can integrate with whichever they use
- We are NOT generating noise commits to inflate contribution graphs
- We are NOT trying to replace human review — every PR is reviewed
- We are NOT supporting team workflows in v1 — solo developer first
- We are NOT supporting non-Git projects in v1
- We are NOT supporting non-GitHub repositories in v1 (GitLab, Bitbucket later)

## Success Metrics

For v1 (the developer's personal use):

- **Empty days reduced** — measure GitHub contribution streaks before/after Maestro
- **PR throughput** — meaningful PRs per week across all projects
- **Quality** — % of agent-generated PRs that get merged without changes
- **Cost** — total monthly Anthropic spend, target under $30/month for 5 projects
- **Time saved** — estimate of developer hours not spent context-switching
- **Sustained use** — does the developer still use it after 4 weeks?

For broader adoption (later):

- GitHub stars (target: 1k in first month after public release)
- Active installations (target: 100 in first 3 months)
- Daily active users (target: 60% of installs use it daily)

## Brand and Identity

- **Product name**: Maestro
- **Tagline**: "Conductor for your codebases"
- **Aesthetic**: Calm, professional, dark mode by default
- **Color palette**: Deep navy (#0B1929) base, warm amber accent (#F59E0B), muted greens for success states
- **Typography**: JetBrains Mono for code, Inter for UI
- **Tone**: Confident, terse, technical — like a senior engineer's notes
- **Domain**: maestro.aaryansinha.dev (or wherever)
- **Repo**: github.com/aaryansinha16/maestro
