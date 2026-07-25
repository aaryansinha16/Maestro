# Real-Project Learnings

A running log of what works and what doesn't when Maestro touches real
codebases. Phase 1.5's most valuable deliverable per the spec — future-you
will reference this whenever a session produces a surprising PR.

Add new entries at the top. Each entry: date, project, what we tried, what
happened, what we'd change.

---

## 2026-05-02 — Scaffolder self-test on Maestro itself

**What we tried.** Phase 1.5 added a `--scaffold-context` flag to
`maestro init` that spawns a one-shot `claude -p` run to draft
`.maestro/context.md` instead of the cheap manual scrape. Tested on a
824 KB / 102-file rsync snapshot of Maestro itself (no `.git`).

**What happened.**

| Metric | Value |
|---|---|
| Wallclock | 168 s |
| Cost | ≈ $0.01 |
| Output | 110 lines, 12 KB |
| Sections delivered | Stack · Architecture · Conventions · Notable deps · Top-level layout · CI · NEVER list · Gotchas |

**Quality observations.**

The output is dense and on-target. The "Gotchas" section caught real
subtleties a fresh agent would absolutely miss:

- "scheduler.ts and briefing.ts are intentional stubs awaiting Phase 2 / 4"
- "lib.ts is a separate barrel because conductor/index.ts calls main() on import"
- "exactOptionalPropertyTypes is off on purpose"
- "ProjectLockManager.releaseAllForCurrentProcess() reclaims locks on boot"
- "The CLI walks up 6 dirs to find .env"

The NEVER list is concrete and code-aware (it cites file paths, not
abstract categories) — exactly what we want.

**What we'd change.**

- 110 lines is below the 200–300 line ask. The output is good *because*
  it's dense, but a lengthier version would cover individual conductor
  modules in more detail. Consider making the prompt's line target a
  range with examples, or adding a "describe each conductor module in
  one paragraph" requirement.
- The model didn't include itself in the `model` field of stream-json's
  result object (returned `null`). Doesn't affect the output — just our
  metadata. Worth checking on a Sonnet vs Opus run whether this is
  consistent.
- `git log` errors confused the agent briefly (it noted "this snapshot
  is not a git repository"). For real-project onboarding via `maestro
  init`, the path is a real git repo so this won't repeat — but worth
  noting that the scaffolder's prompt could include "if `git log` works,
  use it to derive commit conventions; otherwise read AGENTS.md/etc".

**Verdict.** Ship it. The scaffolded context is qualitatively better
than a developer's first manual draft and costs ≈ 1 cent. It is now the
recommended path for `maestro init` against real codebases.

---

## 2026-07-17 — AIFlowo: first real autonomous session (VAL-01)

**What we ran.** A single bounded (20-min) `pr-only` session against the real
AIFlowo repo, on the developer's Claude subscription. First end-to-end
validation of the loop on a real codebase — the milestone that had been open
since Phase 1.

**What happened — the loop works.** The agent did genuinely good work:

| Metric | Value |
|---|---|
| Turns | 2 (main + one fixup) |
| Wallclock | ~15 min |
| Output tokens | ~66k |
| Est. cost | ≈ $0.29 |
| Files changed | 15 (+381 / −156) |
| Result | Branch + commits pushed; **PR aiflowo#50** |

**Quality observations (all positive):**

- **Diagnosed two real problems** from `state.md` — the root route rendered the
  component showcase instead of an entry point, and `useAuth.register()` POSTed
  to a nonexistent `/api/auth/register` (backend has only magic-link).
- **Respected the NEVER-touch list.** `apps/backend/src/auth/**` is off-limits,
  so it made login/signup work **frontend-only** (a `demo.`-token client
  session) instead of touching the backend. This is the single most important
  guardrail and it held.
- **The fixup turn worked as designed.** The root `typecheck` gate failed on the
  first turn; the fixup added per-workspace `typecheck` scripts and the session
  continued. (ADR-013.)
- Journal entry was detailed and honest about the tradeoffs it made.

**The one real bug it surfaced → fixed.** The session was marked `failed` at the
push step: Git 2.50 emits `Configuring credential.helper is not permitted…` when
the push's credential *store* runs the ambient / `!shell` helper (the exact
pattern the Docker image + DEPLOYMENT.md configured). The mock-based integration
suite could never catch this — it only appears against a real GitHub remote.
Fixed in **maestro#89**: the worker now pushes to
`https://x-access-token:<token>@github.com/o/r.git` (like GitHub Actions),
sidestepping credential helpers. The already-pushed branch was turned into
aiflowo#50 by hand to complete the validation.

**What we'd change / follow-ups.**

- The 20-min budget was comfortable — the agent finished well inside it. The
  default 45–60 min is generous; consider lowering the default.
- ENG-07 is only half done: the **push** is now token-authenticated, but the
  **clone/fetch** still relies on the ambient helper (it worked here because
  `get` isn't blocked, only `store`). Fully retiring the Docker `!shell` helper
  means token-authenticating the fetch too, then deleting the Dockerfile helper.
- Cost/quality ratio is excellent (~$0.29 for a coherent 15-file PR). The loop
  is ready for repeated real use.

**Verdict.** Ship it. The autonomous loop produces reviewable, guardrail-
respecting PRs on a real codebase. VAL-01 is validated end-to-end.

## (Pending) Devovia onboarding

Same shape as AIFlowo.

---

## How to use this document

When a session does something good or bad:

1. Skim the existing entries to see if you've already noted the pattern.
2. If new, add an entry. Keep it specific (file paths, exact behaviour).
3. If a pattern repeats across projects, lift it into PROMPT_DESIGN.md or
   DECISIONS.md as a durable rule.
