// Auto-pause logic. After N consecutive failed sessions on a project
// the conductor sets `projects.auto_paused_at` and stops scheduling
// new runs (Rule D in skip-rules.ts). Manual triggers still work and
// a successful manual run clears the auto-pause.
//
// "Failed" mirrors the definition in skip-rules.consecutiveFailures:
// status !== 'completed' OR (status='completed' && prNumber===null after
// a non-orientation session). That's the same yardstick the failure-
// backoff rule uses, so the two stay in sync.

import {
  AUTO_PAUSE_FAILURE_THRESHOLD,
  type Project,
  type Session,
} from '@maestro/shared'
import type { ProjectRepository, SessionRepository } from './repositories.js'
import { sessionFailedForBackoff } from './skip-rules.js'
import { logger } from './logger.js'

export interface AutoPauseDeps {
  projects: ProjectRepository
  sessions: SessionRepository
  /** Override the threshold; tests use a small one for fast checks. */
  threshold?: number
}

/**
 * Re-evaluate the auto-pause state for a project. Called after every
 * session completes (success or failure) and once at boot.
 *
 * Behaviour:
 *  - If consecutive_failures >= threshold AND not already paused → pause
 *  - If the most recent session succeeded AND was a manual trigger → clear pause
 *  - Scheduled successes after a pause do NOT clear the pause (the developer
 *    must explicitly run a manual session — Rule D in skip-rules
 *    prevents scheduled runs anyway, so this is a defensive no-op).
 */
export function evaluateAutoPause(
  deps: AutoPauseDeps,
  project: Project,
): { transitioned: 'paused' | 'resumed' | null; consecutive: number } {
  const threshold = deps.threshold ?? AUTO_PAUSE_FAILURE_THRESHOLD
  const recent = deps.sessions
    .list({ projectId: project.id, limit: threshold + 5 })
    .sessions
  const consecutive = countConsecutiveFailures(recent)

  // Transition: not paused → paused
  if (!project.autoPausedAt && consecutive >= threshold) {
    deps.projects.setAutoPause(
      project.slug,
      `auto-paused after ${consecutive} consecutive failed sessions`,
    )
    logger.warn(
      { slug: project.slug, consecutive },
      'auto-pause: project crossed failure threshold',
    )
    return { transitioned: 'paused', consecutive }
  }

  return { transitioned: null, consecutive }
}

/**
 * Manual successful runs clear the auto-pause. The worker calls this
 * after a successful manual session. Scheduled successes are deliberately
 * NOT a trigger — the developer must explicitly opt back in.
 */
export function maybeClearAutoPauseOnManualSuccess(
  deps: AutoPauseDeps,
  project: Project,
  session: Session,
): boolean {
  if (!project.autoPausedAt) return false
  if (sessionFailedForBackoff(session)) return false
  deps.projects.clearAutoPause(project.slug)
  logger.info(
    { slug: project.slug, sessionId: session.id },
    'auto-pause cleared by successful manual run',
  )
  return true
}

function countConsecutiveFailures(sessions: Session[]): number {
  let count = 0
  for (const s of sessions) {
    if (sessionFailedForBackoff(s)) count++
    else break
  }
  return count
}
