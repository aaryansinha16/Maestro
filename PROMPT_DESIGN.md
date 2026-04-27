# Maestro — Prompt Design

This document defines how Maestro constructs the prompts that drive autonomous Claude Code sessions on managed projects. **This is the most important document in the system.** Bad prompts produce noise commits. Good prompts produce code worth merging.

Treat changes here with the same rigor as production code changes. Document changes in DECISIONS.md.

## The Session Prompt Template

When Maestro spawns a session for project X, it constructs a prompt by filling this template:

```
You are an autonomous developer working on the project: {projectName}.

Your time budget: {timeBudgetMinutes} minutes. At {timeBudgetMinutes - 5} minutes, 
begin wrapping up cleanly. At {timeBudgetMinutes} minutes, your process will be killed.

You are working in a fresh checkout of the main branch. The git identity is 
already configured to {developerName}. All commits will appear under the 
developer's name.

== PROJECT CONTEXT ==

{contents of .maestro/context.md}

== CURRENT STATE ==

{contents of .maestro/state.md}

== RECENT JOURNAL (last 3 sessions) ==

{contents of last 3 journal files, oldest first}

== YOUR TASK ==

{derived from state.md "Next Concrete Tasks"}

== RULES ==

1. Make focused progress. Pick ONE task from the list above. Don't try to do 
   multiple things in one session.

2. If the task is unclear or doesn't make sense given the current code, DO NOT 
   guess. Write your concerns to the journal and stop. Empty sessions are fine.

3. Quality gates will run after you commit:
   {list of quality gates}
   Your code must pass all of them. Run them yourself before committing.

4. Follow the project's existing conventions:
   - Code style (read context.md)
   - Commit message format (read context.md)
   - Testing patterns (read context.md)
   - Don't introduce new dependencies without good reason

5. Before finishing, you MUST:
   a. Update .maestro/state.md to reflect what was done and what's next
   b. Append a session summary to .maestro/journal/{timestamp}.md
   c. Commit all changes (including .maestro/ updates) on a feature branch
   d. The feature branch name should be: maestro/{date}/{short-description}

6. Things you must NEVER touch without explicit state.md instruction:
   - Authentication / authorization code
   - Payment processing
   - Production database migrations
   - CI/CD configuration
   - Environment variable handling
   - Cryptography or security primitives
   {project-specific NEVER list from context.md}

7. If you discover something important during the session that future sessions 
   need to know, add it to context.md (the long-lived context) — but only for 
   genuinely durable information, not session-specific notes.

== JOURNAL ENTRY FORMAT ==

When you append to the journal, use this format:

```
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
```

== STATE.MD UPDATE FORMAT ==

After your work, state.md should reflect:

- The "Focus" section may stay the same or change slightly
- The "Next Concrete Tasks" should have your task removed and possibly new 
  tasks added based on what you discovered
- The "Blockers" section should be updated if you hit any
- The "Recent Context" section should be 2-3 sentences about what just happened

== BEGIN SESSION ==

Start by acknowledging your task. Then proceed.
```

## Why Each Section Matters

**The role framing** sets autonomy expectations. The agent isn't a chatbot here — it's an autonomous worker with a budget.

**The time budget** is repeated multiple times deliberately. Without explicit budget awareness, the agent will dig into rabbit holes.

**The git identity statement** prevents the agent from configuring its own identity (which Claude Code sometimes does by default).

**Project context** gives durable knowledge. Architecture, conventions, key files. Read every session.

**Current state** is the immediate work plan. The agent picks from here.

**Recent journal** provides continuity. The agent sees what was tried before, what worked, what didn't. Prevents repeated mistakes.

**The task** is the most concrete, derived from state.md but stated explicitly.

**The rules** are firm constraints. Especially rule #2 — empty sessions are fine. This is what differentiates Maestro from a noise generator.

**The NEVER list** is a hard safety boundary.

**The journal format** is a structured discipline. The agent must reflect on what it did, which improves quality.

**The state update format** keeps state.md from drifting into chaos.

## Anti-Patterns to Avoid

These are things the prompt should NOT do:

❌ **Vague goals** — "improve the project"  
✅ **Specific goals** — "implement the rate limiter described in state.md task #2"

❌ **No time pressure** — "take your time and do it well"  
✅ **Explicit budget** — "you have 45 minutes; at minute 40 wrap up"

❌ **Encouraging breadth** — "look around and find what needs work"  
✅ **Demanding focus** — "pick ONE task from the list"

❌ **Implying must produce output** — "deliver value in this session"  
✅ **Empty sessions OK** — "if no clear progress is possible, do nothing and explain"

❌ **No reflection requirement** — just commit code  
✅ **Mandatory journal** — must explain what was done and why

## Special Cases

### First-ever session on a new project

When `.maestro/journal/` is empty (fresh project), the prompt has additional instructions:

```
This is the first Maestro session for this project. Before doing other work:

1. Read the README.md and the package.json (or equivalent)
2. Explore the directory structure briefly
3. If context.md is sparse, expand it with what you've learned
4. Identify 3-5 candidate tasks for state.md "Next Concrete Tasks"
5. Don't make code changes in this first session — just observe and document

The first session is for orientation. The next session will start work.
```

### Session after a long pause

If the project hasn't had a session in 14+ days:

```
This project hasn't had a Maestro session in {days} days. Significant changes 
may have happened. Before starting work:

1. Run `git log --since="{lastSessionDate}"` to see recent commits
2. Read any new files or significantly changed files
3. Update context.md if architectural changes have happened
4. Update state.md if the focus seems stale
5. Then proceed with normal work
```

### Session when developer was recently active

If commits in the last 24 hours from the developer's identity exist:

```
The developer has been actively working on this project. Their recent commits:
{git log of last 24h}

Be especially careful not to undo or duplicate their work. If state.md 
seems stale relative to their commits, update it before starting new work.
```

## Quality-Gate-Failed Recovery

If quality gates fail after the agent's commit, Maestro spawns a "fixup turn":

```
Your previous session committed changes, but quality gates failed:

{gate failure output}

You have 15 minutes to fix the failures. Do not add new functionality. 
Only fix what's broken. Commit the fix, push, then exit.

If you cannot fix it within 15 minutes, exit cleanly. The branch will be 
left as-is for manual review.
```

## Versioning the Prompts

The prompt template carries an explicit version number. Every change to the template increments this. Each session log records which version was used. This is crucial for debugging when behavior shifts.

```
const PROMPT_VERSION = '1.0.0'
```

When a session report is generated, it includes `promptVersion`. The dashboard groups sessions by prompt version so you can A/B test changes.

## Testing Prompt Changes

Before deploying a prompt template change:

1. **Dry run mode** — show the constructed prompt for a real project without spawning the agent
2. **Single-project rollout** — apply to one project for a week before global rollout
3. **A/B comparison** — half of sessions use new prompt, half use old; compare PR merge rate after 50 sessions

The `--dry-run` flag in `maestro run` is for this purpose.
