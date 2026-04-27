# Maestro — PROJECT_CONFIG.md

This file documents the autonomy decisions for the developer's actual projects. Maestro reads this to understand each project's context and constraints. Update it as projects evolve.

## The Developer's Active Projects

Based on the developer's work, the projects under Maestro management are:

### 1. TripKaptan (tripkaptan.com)

- **Repo**: github.com/aaryansinha16/tripkaptan
- **Stack**: Full-stack JavaScript/TypeScript
- **Status**: Active production deployment
- **Autonomy level**: `pr-only`
- **Schedule**: `0 6,14,22 * * *` (3x daily)
- **Time budget**: 45 minutes
- **Quality gates**: test, lint, typecheck
- **Notes**: This has real users. Be conservative. Never touch payment flows or auth without explicit instruction in state.md.

### 2. AIFlowo (aiflowo.com)

- **Repo**: github.com/aaryansinha16/aiflowo
- **Stack**: TypeScript, browser automation
- **Status**: Active development
- **Autonomy level**: `pr-only`
- **Schedule**: `0 */6 * * *` (every 6 hours)
- **Time budget**: 60 minutes
- **Quality gates**: test, lint, typecheck
- **Notes**: Browser automation has flaky tests. Quality gates may need timeout handling.

### 3. Devovia (devovia.com)

- **Repo**: github.com/aaryansinha16/devovia
- **Stack**: Real-time collaborative dev platform
- **Status**: Active development  
- **Autonomy level**: `pr-only`
- **Schedule**: `0 */6 * * *`
- **Time budget**: 45 minutes
- **Quality gates**: test, lint, typecheck

### 4. AI-Trader

- **Repo**: github.com/aaryansinha16/ai-trader (or wherever it lives)
- **Stack**: Python, ML, XGBoost
- **Status**: Active development, real money risk
- **Autonomy level**: `draft-only`
- **Schedule**: `0 */12 * * *` (twice daily)
- **Time budget**: 30 minutes
- **Quality gates**: test, lint, typecheck
- **Notes**: This trades real money. Autonomy is intentionally restricted. Agent CANNOT modify trading logic, position sizing, or risk parameters without explicit state.md instruction. Allowed: backtest improvements, refactoring, test additions, documentation, dependency updates.

### 5. Agent Studio

- **Repo**: github.com/aaryansinha16/agent-studio
- **Stack**: Electron, React, Pixi.js, TypeScript
- **Status**: Active development
- **Autonomy level**: `pr-only`
- **Schedule**: `0 */8 * * *` (3x daily)
- **Time budget**: 45 minutes
- **Quality gates**: lint, typecheck (no test runner yet)
- **Notes**: Visual project. Test feedback is hard. Focus agent work on backend (event-bridge, electron-shell) where tests are easier.

### 6. Maestro itself

- **Repo**: github.com/aaryansinha16/maestro
- **Autonomy level**: `pr-only` once Maestro is stable enough
- **Schedule**: `0 4 * * *` (once a day, early morning)
- **Time budget**: 60 minutes
- **Quality gates**: test, lint, typecheck
- **Notes**: Maestro maintaining itself. Set up only after v0 is stable. Recursive use case is great portfolio narrative.

## Global Rules

These apply to every project:

1. **Never modify these without explicit state.md instruction:**
   - Authentication / authorization code
   - Payment processing
   - Trading logic (in AI-Trader)
   - Production database migrations
   - CI/CD configuration
   - Environment variable handling
   - Cryptography or security primitives

2. **Always allowed if state.md mentions related work:**
   - Refactoring within agreed direction
   - Test additions
   - Documentation
   - Type definition improvements
   - Dependency updates (security patches anytime, major versions only with mention)
   - Bug fixes for issues mentioned in state.md or open issues
   - Code comments and JSDoc

3. **Default git identity for all commits:**
   - Name: Aaryan Sinha
   - Email: (developer's GitHub email)

## Risk Tiers

Projects are categorized by risk level. Higher risk = more conservative autonomy.

- **Tier 1 (Low risk)**: Personal tools, experiments, docs sites — `full` allowed
- **Tier 2 (Medium risk)**: Active SaaS without users yet, side projects — `pr-only`
- **Tier 3 (High risk)**: Production with users, public APIs — `pr-only` with manual review on every PR
- **Tier 4 (Critical)**: Anything financial, anything with real money flow — `draft-only` always

| Project | Tier |
|---|---|
| TripKaptan | 3 |
| AIFlowo | 2 |
| Devovia | 2 |
| AI-Trader | 4 |
| Agent Studio | 2 |
| Maestro | 2 |

## Cost Budget

Target monthly Anthropic API spend across all projects: **$30-50**.

If projected monthly cost exceeds $50 by mid-month, Maestro should automatically reduce session frequency on lowest-priority projects. The dashboard surfaces cost trends.

## Onboarding Checklist for Adding a Project

When adding a new project to Maestro:

1. [ ] Clone the project repo to a temporary location
2. [ ] Run `maestro init <project-path>` which creates `.maestro/` interactively
3. [ ] Manually populate `context.md` with architecture overview, conventions, key files
4. [ ] Set initial state.md with current focus
5. [ ] Configure autonomy.json (level, schedule, time budget, quality gates)
6. [ ] Commit `.maestro/` to the project repo
7. [ ] Register the project with Maestro: `maestro add <repo-url>`
8. [ ] Trigger a manual first session: `maestro run <project> --dry-run`
9. [ ] Review the would-be output, adjust prompts/state if needed
10. [ ] Trigger a real session: `maestro run <project>`
11. [ ] Review the resulting PR carefully
12. [ ] If satisfied, enable scheduled runs

The onboarding is deliberately friction-heavy. Better to spend an hour setting up a project well than to have weeks of bad agent commits.
