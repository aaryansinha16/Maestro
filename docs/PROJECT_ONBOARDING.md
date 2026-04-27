# Project Onboarding

How to bring a project under Maestro management. The onboarding flow is
deliberately friction-heavy — better to spend an hour setting a project up
well than to have weeks of bad agent commits (per `PROJECT_CONFIG.md`).

> Phase 0 status: this document describes the intended end-state. The CLI
> commands referenced here (`maestro init`, `maestro add`, `maestro run`) are
> stubs in Phase 0 and become real in Phases 1-2.

## 1. Create the `.maestro/` directory

In the project's working tree:

```text
.maestro/
├── state.md
├── context.md
├── decisions.md
├── autonomy.json
└── journal/
```

The full contract for these files is in `CLAUDE.md` (root of this repo)
under "The .maestro/ Directory Contract".

## 2. Write `context.md` (long-lived)

Architecture overview, conventions, key files, gotchas. The agent reads this
every session. Keep it ~200-500 lines. Include:

- Tech stack and main entry points
- Code style and naming conventions
- Commit message format
- Test commands and patterns
- Project-specific NEVER-touch list
- Any external systems the project integrates with

## 3. Write `state.md` (immediate work)

Current focus, 3-5 concrete next tasks, blockers. The agent picks one task
per session from "Next Concrete Tasks". See `CLAUDE.md` for the section
template.

## 4. Configure `autonomy.json`

```json
{
  "level": "pr-only",
  "schedule": "0 */6 * * *",
  "timeBudget": 2700,
  "qualityGates": ["test", "lint", "typecheck"],
  "branches": { "base": "main", "prefix": "maestro/" },
  "github": { "prLabels": ["maestro"], "draftByDefault": false },
  "skipDays": [],
  "maxSessionsPerDay": 6
}
```

`timeBudget` is in seconds. Default 2700 (45 minutes). See
`PROJECT_CONFIG.md` for the developer's per-project decisions.

## 5. Commit `.maestro/` to the project repo

The directory travels with the code (ADR-004). Both your active sessions and
Maestro's autonomous sessions read the same files.

## 6. Register with Maestro

```bash
maestro add <repo-url>
```

## 7. Dry-run the first session

```bash
maestro run <project> --dry-run
```

This prints the constructed prompt without spawning Claude. Read it. If
anything looks off, the fix is almost always in `state.md` or `context.md`,
not in the agent.

## 8. Real first session

```bash
maestro run <project>
```

For a brand-new project the first session is intentionally orientation-only
(see the FIRST SESSION preamble in `packages/shared/src/prompt-templates.ts`).
The next session will start real work.

## 9. Review the resulting PR carefully

The first 2 weeks of any project are for building trust with the system.
Review every PR. When something is wrong, update `state.md` or `context.md`
rather than trying to "fix" the agent.

## 10. Enable the schedule

Once you've shipped a few good PRs from manual sessions, switch the project
on. The schedule in `autonomy.json` takes effect on the next scheduler tick.
