# Maestro — AGENTS.md

## Purpose

Patterns for AI coding agents working on the Maestro codebase itself. Ensures consistent behavior across sessions.

This file is for agents building **Maestro**. The system prompts that drive agents working on **managed projects** are in `packages/shared/src/prompt-templates.ts`.

## Before Any Task

1. Read `CLAUDE.md` for architecture context
2. Read `DECISIONS.md` for recent architectural decisions
3. Read `PROJECT_CONFIG.md` for the developer's specific projects and their autonomy decisions
4. Check the relevant package's `src/` directory before creating new files
5. If modifying an existing file, read it fully first

## Task Patterns

### When adding a new feature to the conductor

1. Define the types in `packages/shared/src/types.ts` first
2. Add Zod schemas in the same file
3. Add the database table/migration in `packages/conductor/src/db.ts`
4. Implement the conductor logic
5. Add the API endpoint in `packages/api/src/routes/`
6. Add the UI integration in `packages/dashboard/src/`
7. Test end-to-end before considering done

### When modifying prompt templates

This is the most sensitive part of the system. Changes here directly affect agent behavior on managed projects.

1. Read the existing template fully
2. Document the change reasoning in DECISIONS.md
3. Test with a "dry run" mode that prints the prompt without running Claude
4. Verify on at least one real project before deploying
5. Add a version number to the template

### When working with the .maestro/ file format

1. Always validate with Zod before reading
2. If schema changes, write a migration (parse old format, save in new format)
3. Never assume the file exists — handle missing gracefully
4. Lock files during writes (concurrent sessions could corrupt state)

### When adding a new quality gate

1. Add the gate type to `packages/shared/src/types.ts`
2. Implement the runner in `packages/conductor/src/quality-gates.ts`
3. Default to non-strict (warn, don't fail) until proven reliable
4. Document the gate in `docs/PROMPT_DESIGN.md`

## Pre-Commit Checklist

Before marking any task as done:

- [ ] TypeScript compiles with zero errors (`pnpm tsc --noEmit`)
- [ ] No `any` types introduced
- [ ] All Zod schemas updated if types changed
- [ ] No console.log left (use the logger)
- [ ] Tests pass (`pnpm test`)
- [ ] Lint clean (`pnpm lint`)
- [ ] If touching prompt templates: documented in DECISIONS.md
- [ ] If touching .maestro/ file format: migration written

## Error Handling Pattern

```typescript
import { MaestroError } from '@maestro/shared'

try {
  await spawnClaudeSession(project, prompt)
} catch (err) {
  throw new MaestroError('SESSION_SPAWN_FAILED', {
    cause: err,
    context: { 
      project: project.slug, 
      timeBudget: project.config.timeBudget,
      attempt: retryCount,
    },
  })
}
```

Errors should always include enough context to diagnose without re-running.

## Naming Conventions

- **Sessions**: `session-{project-slug}-{ISO-timestamp}` 
- **Branches**: `maestro/{project-slug}/{short-description}`
- **PRs**: title from agent, body includes session summary + journal link
- **Commit messages**: agent follows project conventions from context.md
- **Files**: kebab-case TypeScript files, PascalCase for React components
- **DB tables**: snake_case (sessions, project_runs, daily_briefings)

## Test Conventions

- Unit tests: `*.test.ts` adjacent to source
- Integration tests: `__tests__/integration/` per package
- Use `vitest`
- For tests that spawn Claude Code: use a mock executor in `packages/conductor/src/test/`
- Never make real API calls in tests (Anthropic, GitHub, Telegram all mocked)

## Security Patterns

- Secrets ONLY from environment variables, never in code or files
- Use `dotenv` for local dev, real env vars on Railway
- Validate every external input with Zod
- Sanitize anything written to shell (use execa with array args, never shell strings)
- Working directories must be created with `mkdtemp` and cleaned up after
- Git operations use `simple-git` with explicit paths, never shell git
