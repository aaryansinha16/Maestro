# Project Context — testproject

## Stack

Node.js 22 + TypeScript strict. Vite for the dashboard. Hono for the API.

### Scripts

- `test`: `vitest run`
- `lint`: `eslint .`
- `typecheck`: `tsc --noEmit`

## Conventions

- Conventional commits (feat:, fix:, refactor:)
- Single quotes, no semis, trailing commas
- One feature per PR

## Project-specific NEVER list

- Never modify the migration ordering in db/migrations
- Never bump @maestro/* packages without a version bump in DECISIONS.md
