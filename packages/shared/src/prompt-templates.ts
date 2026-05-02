// Maestro session prompt templates.
//
// This is the most important file in the system. The text here directly drives
// agent behavior on every managed project. Treat changes here with the same
// rigor as production code: bump PROMPT_VERSION on any change, document the
// reasoning in DECISIONS.md, and dry-run before deploying. See PROMPT_DESIGN.md.

import { PROMPT_VERSION, WRAP_UP_GRACE_SECONDS } from './constants.js'
import type { ProjectAutonomyConfig, QualityGate } from './types.js'

// ─── Public API ──────────────────────────────────────────────────────

export interface SessionPromptContext {
  /** Human-readable project name. */
  projectName: string
  /** Slug used for branch naming (e.g. "tripkaptan"). */
  projectSlug: string
  /** Hard kill ceiling for this session, in seconds. */
  timeBudgetSeconds: number
  /** Git config user.name, surfaced in the prompt to prevent agent re-config. */
  developerName: string
  /** Full markdown body of .maestro/context.md. */
  context: string
  /** Full markdown body of .maestro/state.md. */
  state: string
  /** Recent journal entries, oldest first. Empty array on a fresh project. */
  recentJournal: Array<{ filename: string; body: string }>
  /** Concrete task derived from state.md "Next Concrete Tasks". */
  task: string
  /** Quality gates that will run after commit. */
  qualityGates: QualityGate[]
  /**
   * Project-specific never-touch list. Phase 1.5 wires this up by parsing
   * the `## Project-specific NEVER list` section of context.md (case-insensitive,
   * accepts `## Never Touch` too). When the worker passes a non-empty array
   * here, the prompt's rule #6 expands with these items.
   */
  projectSpecificNeverTouch?: string[]
  /** True when .maestro/journal/ is empty for this project. */
  isFirstSession?: boolean
  /**
   * True when this session has no concrete task to work on (empty
   * "Next Concrete Tasks" + no journal). The agent is told to use the
   * session for orientation only — read, observe, document — and the
   * worker will skip quality gates and refuse to open a PR for it.
   *
   * Set automatically by buildSessionPrompt when isFirstSession is true and
   * `task` is empty / the placeholder string. Callers can also force it.
   */
  isOrientationOnly?: boolean
  /** Days since the last session. Used for the "long pause" preamble. */
  daysSinceLastSession?: number
  /** Recent developer commits in last 24h, if any. Triggers caution preamble. */
  recentDeveloperCommits?: string
  /**
   * Phase 4 / Sub 1: pending reviewer comments on the project's open Maestro
   * PRs. When non-empty the prompt grows a `== FEEDBACK ON RECENT PRs ==`
   * section instructing the agent to address relevant items. Each entry is
   * the comment as fetched from GitHub plus the PR + branch coordinates so
   * the agent can locate the change.
   */
  pendingPrFeedback?: ReadonlyArray<PendingPrFeedbackEntry>
}

export interface PendingPrFeedbackEntry {
  /** PR number on GitHub. */
  prNumber: number
  /** Feature branch the PR was opened from, e.g. `maestro/foo/auth-fix`. */
  branchName: string
  /** Comment author's GitHub login (already filtered against the allowlist). */
  author: string
  /** Comment body, verbatim. */
  body: string
  /** ISO timestamp of when the comment was posted on GitHub. */
  postedAt: string
}

export interface FixupTurnPromptContext {
  projectName: string
  /** The output of the failing quality gates, included verbatim. */
  failureOutput: string
  /** Fixup turn budget in seconds. Default 15 min via FIXUP_TURN_BUDGET_SECONDS. */
  timeBudgetSeconds: number
}

export function buildSessionPrompt(ctx: SessionPromptContext): string {
  const minutes = Math.round(ctx.timeBudgetSeconds / 60)
  const wrapMinutes = Math.max(1, Math.round((ctx.timeBudgetSeconds - WRAP_UP_GRACE_SECONDS) / 60))

  const journalSection = ctx.recentJournal.length
    ? ctx.recentJournal
        .map((entry) => `### ${entry.filename}\n\n${entry.body.trim()}`)
        .join('\n\n')
    : '_(No prior sessions on this project.)_'

  const gatesSection = ctx.qualityGates.length
    ? ctx.qualityGates.map((g) => `   - \`${g}\``).join('\n')
    : '   _(none configured)_'

  const projectNeverList = (ctx.projectSpecificNeverTouch ?? [])
    .map((item) => `   - ${item}`)
    .join('\n')

  const prFeedbackSection = renderPrFeedbackSection(ctx.pendingPrFeedback ?? [])

  // Orientation mode kicks in when this is a fresh project AND there's no
  // concrete task to act on. The first session on a project that already
  // has tasks is just a normal session — the FIRST SESSION preamble used to
  // contradict that, so Phase 1.5 corrects it.
  const orientationOnly = isOrientationModeFromContext(ctx)
  const enrichedCtx: SessionPromptContext = { ...ctx, isOrientationOnly: orientationOnly }
  const preamble = buildPreamble(enrichedCtx)

  return SESSION_PROMPT_TEMPLATE_V1({
    projectName: ctx.projectName,
    projectSlug: ctx.projectSlug,
    minutes,
    wrapMinutes,
    developerName: ctx.developerName,
    context: ctx.context.trim(),
    state: ctx.state.trim(),
    journalSection,
    task: ctx.task.trim(),
    gatesSection,
    projectNeverList,
    prFeedbackSection,
    preamble,
    promptVersion: PROMPT_VERSION,
  })
}

function renderPrFeedbackSection(entries: ReadonlyArray<PendingPrFeedbackEntry>): string {
  if (entries.length === 0) return ''
  const items = entries
    .map((e) => {
      const trimmed = e.body.trim()
      return `### PR #${e.prNumber} (branch \`${e.branchName}\`) — ${e.author}, ${e.postedAt}\n\n${trimmed}`
    })
    .join('\n\n')
  return `\n== FEEDBACK ON RECENT PRs ==\n\nThe developer (or reviewers) left these comments on Maestro PRs that\nhaven't been addressed yet. If any are relevant to your current task,\naddress them in this session. If a comment reveals a recurring problem\nwith how previous sessions worked, update context.md so future sessions\ndon't repeat it. When you address a comment, mention the PR number in\nyour journal entry — e.g. "addressed PR #42 feedback" — so Maestro can\nmark it as processed.\n\n${items}\n`
}

/**
 * Detect orientation mode for a session prompt context. Exported so the
 * worker can take the same decision (skip quality gates, refuse to open a
 * PR) using exactly the same logic as the prompt.
 */
export function isOrientationModeFromContext(ctx: {
  isOrientationOnly?: boolean
  isFirstSession?: boolean
  task: string
  recentJournal?: Array<unknown>
}): boolean {
  if (ctx.isOrientationOnly) return true
  const journalEmpty = !ctx.recentJournal || ctx.recentJournal.length === 0
  const taskEmpty =
    ctx.task.trim().length === 0 ||
    /^_\(No concrete task supplied/.test(ctx.task) ||
    /^Pick the most important task/.test(ctx.task)
  return journalEmpty && taskEmpty
}

export function buildFixupTurnPrompt(ctx: FixupTurnPromptContext): string {
  const minutes = Math.round(ctx.timeBudgetSeconds / 60)
  return FIXUP_TURN_TEMPLATE_V1({
    projectName: ctx.projectName,
    minutes,
    failureOutput: ctx.failureOutput.trim(),
  })
}

// ─── Templates ───────────────────────────────────────────────────────

interface SessionTemplateInputs {
  projectName: string
  projectSlug: string
  minutes: number
  wrapMinutes: number
  developerName: string
  context: string
  state: string
  journalSection: string
  task: string
  gatesSection: string
  projectNeverList: string
  /** Empty string when there is no pending feedback. */
  prFeedbackSection: string
  preamble: string
  promptVersion: string
}

const SESSION_PROMPT_TEMPLATE_V1 = (i: SessionTemplateInputs): string =>
  `You are an autonomous developer working on the project: ${i.projectName}.

Your time budget: ${i.minutes} minutes. At ${i.wrapMinutes} minutes, begin
wrapping up cleanly. At ${i.minutes} minutes, your process will be killed.

You are working in a fresh checkout of the main branch. The git identity is
already configured to ${i.developerName}. All commits will appear under the
developer's name.
${i.preamble}
== PROJECT CONTEXT ==

${i.context || '_(context.md is empty — note this in your journal entry.)_'}

== CURRENT STATE ==

${i.state || '_(state.md is empty — note this in your journal entry.)_'}

== RECENT JOURNAL (last 3 sessions) ==

${i.journalSection}
${i.prFeedbackSection}
== YOUR TASK ==

${i.task || '_(No concrete task supplied. If state.md does not name one, do nothing and explain in the journal.)_'}

== RULES ==

1. Make focused progress. Pick ONE task from the list above. Don't try to do
   multiple things in one session.

2. If the task is unclear or doesn't make sense given the current code, DO NOT
   guess. Write your concerns to the journal and stop. Empty sessions are fine.

3. Quality gates will run after you commit:
${i.gatesSection}
   Your code must pass all of them. Run them yourself before committing.

4. Follow the project's existing conventions:
   - Code style (read context.md)
   - Commit message format (read context.md)
   - Testing patterns (read context.md)
   - Don't introduce new dependencies without good reason

5. Before finishing, you MUST:
   a. Update .maestro/state.md to reflect what was done and what's next
   b. Append a session summary to .maestro/journal/YYYY-MM-DD-HH-MM-SS.md
      (UTC timestamp; seconds-granularity matters when sessions land in the
      same minute — pad with zeros, e.g. 2026-04-15-08-00-12.md)
   c. Commit all changes (including .maestro/ updates) on a feature branch
   d. The feature branch name should be: maestro/${i.projectSlug}/{short-description}

6. Things you must NEVER touch without explicit state.md instruction:
   - Authentication / authorization code
   - Payment processing
   - Production database migrations
   - CI/CD configuration
   - Environment variable handling
   - Cryptography or security primitives
${i.projectNeverList ? `\n${i.projectNeverList}` : ''}

7. If you discover something important during the session that future sessions
   need to know, add it to context.md (the long-lived context) — but only for
   genuinely durable information, not session-specific notes.

== JOURNAL ENTRY FORMAT ==

When you append to the journal, use this format:

\`\`\`
# Session {ISO timestamp}

## Goal
{what you set out to do}

## What I Did
{narrative of the work, including reasoning}

## What Worked
{techniques or approaches that worked well}

## What Didn't
{dead ends, mistakes corrected, things that didn't work}

## Quality Gates
{which gates ran, results}

## State Update
{what you changed in state.md and why}

## For Next Session
{important context for the next agent that runs}

## Cost
{tokens used if available}
\`\`\`

== STATE.MD UPDATE FORMAT ==

After your work, state.md should reflect:

- The "Focus" section may stay the same or change slightly
- The "Next Concrete Tasks" should have your task removed and possibly new
  tasks added based on what you discovered
- The "Blockers" section should be updated if you hit any
- The "Recent Context" section should be 2-3 sentences about what just happened

== BEGIN SESSION ==

Start by acknowledging your task. Then proceed.

[prompt-version: ${i.promptVersion}]
`

function buildPreamble(ctx: SessionPromptContext): string {
  const parts: string[] = []

  if (ctx.isOrientationOnly) {
    parts.push(
      [
        '== ORIENTATION MODE ==',
        '',
        "This project has no concrete tasks queued and no prior session journal.",
        'Treat this session as orientation only:',
        '',
        '1. Read README.md and the project manifest (package.json, pyproject.toml, etc.)',
        '2. Explore the directory structure briefly',
        '3. Expand .maestro/context.md with what you learn — architecture, conventions, gotchas',
        '4. Propose 3–5 concrete candidate tasks for state.md "Next Concrete Tasks"',
        '5. DO NOT make code changes in orientation mode — only update .maestro/ files',
        '',
        'No quality gates will run. No PR will be opened. The next session, with',
        "state.md populated, will begin real work.",
      ].join('\n'),
    )
  } else if (ctx.isFirstSession) {
    parts.push(
      [
        '== FIRST SESSION ==',
        '',
        'This is the first Maestro session for this project, but state.md already',
        "lists a concrete task — treat that task as authoritative and proceed",
        'normally. Before diving in:',
        '',
        '1. Skim README.md and the project manifest (package.json, etc.)',
        '2. Note any conventions or gotchas you discover and add them to context.md',
        '3. Then complete your task per the rules below',
        '',
        'You have permission to make code changes — the explicit task in state.md',
        'overrides any "orientation only" intuition.',
      ].join('\n'),
    )
  }

  if (ctx.daysSinceLastSession !== undefined && ctx.daysSinceLastSession >= 14) {
    parts.push(
      [
        '== LONG PAUSE ==',
        '',
        `This project has not had a Maestro session in ${ctx.daysSinceLastSession} days.`,
        'Significant changes may have happened. Before starting work:',
        '',
        '1. Run `git log --since=...` to see recent commits',
        '2. Read any new files or significantly changed files',
        '3. Update context.md if architectural changes have happened',
        '4. Update state.md if the focus seems stale',
        '5. Then proceed with normal work',
      ].join('\n'),
    )
  }

  if (ctx.recentDeveloperCommits && ctx.recentDeveloperCommits.trim().length > 0) {
    parts.push(
      [
        '== DEVELOPER WAS RECENTLY ACTIVE ==',
        '',
        'The developer has been actively working on this project. Recent commits:',
        '',
        '```',
        ctx.recentDeveloperCommits.trim(),
        '```',
        '',
        'Be especially careful not to undo or duplicate their work. If state.md',
        'seems stale relative to their commits, update it before starting new work.',
      ].join('\n'),
    )
  }

  return parts.length ? `\n${parts.join('\n\n')}\n` : ''
}

interface FixupTemplateInputs {
  projectName: string
  minutes: number
  failureOutput: string
}

const FIXUP_TURN_TEMPLATE_V1 = (i: FixupTemplateInputs): string =>
  `Your previous session on ${i.projectName} committed changes, but quality gates failed:

\`\`\`
${i.failureOutput}
\`\`\`

You have ${i.minutes} minutes to fix the failures. Do not add new functionality.
Only fix what's broken. Commit the fix, push, then exit.

If you cannot fix it within ${i.minutes} minutes, exit cleanly. The branch will
be left as-is for manual review.

[prompt-version: ${PROMPT_VERSION}]
`

// Re-export under stable names so callers can reach the templates directly for
// dry-run / debugging without going through buildSessionPrompt.
export { SESSION_PROMPT_TEMPLATE_V1, FIXUP_TURN_TEMPLATE_V1 }

// Convenience: also export a pre-baked default autonomy hint useful for tests.
export const DEFAULT_AUTONOMY_LEVEL: ProjectAutonomyConfig['level'] = 'pr-only'
