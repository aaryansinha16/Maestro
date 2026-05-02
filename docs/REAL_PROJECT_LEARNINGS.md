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

## (Pending) AIFlowo onboarding

To be filled in once the developer runs `maestro init`, `add`, and 5
sessions. Capture: prompt-template surprises, gate flakiness, journal
quality, PR coherence, working-dir hygiene wins.

## (Pending) Devovia onboarding

Same shape as AIFlowo.

---

## How to use this document

When a session does something good or bad:

1. Skim the existing entries to see if you've already noted the pattern.
2. If new, add an entry. Keep it specific (file paths, exact behaviour).
3. If a pattern repeats across projects, lift it into PROMPT_DESIGN.md or
   DECISIONS.md as a durable rule.
