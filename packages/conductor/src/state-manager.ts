// .maestro/ file I/O. Reads state.md, context.md, journal entries, and parses
// autonomy.json with Zod. Writes are locked per-project to prevent concurrent
// session corruption. Phase 1 work (see PRODUCT_VISION.md).
//
// Stubs here so callers compile against the intended surface area.

import type { ProjectAutonomyConfig, ProjectState, JournalEntry } from '@maestro/shared'
import { MaestroError } from '@maestro/shared'

export interface StateManagerInput {
  /** Absolute path to the working checkout of the project. */
  projectRoot: string
}

export async function readState(_input: StateManagerInput): Promise<ProjectState> {
  throw notImplemented('readState')
}

export async function writeState(
  _input: StateManagerInput & { state: ProjectState },
): Promise<void> {
  throw notImplemented('writeState')
}

export async function readContext(_input: StateManagerInput): Promise<string> {
  throw notImplemented('readContext')
}

export async function readAutonomy(
  _input: StateManagerInput,
): Promise<ProjectAutonomyConfig> {
  throw notImplemented('readAutonomy')
}

export async function listRecentJournal(
  _input: StateManagerInput & { limit: number },
): Promise<JournalEntry[]> {
  throw notImplemented('listRecentJournal')
}

export async function appendJournal(
  _input: StateManagerInput & { entry: JournalEntry },
): Promise<void> {
  throw notImplemented('appendJournal')
}

function notImplemented(name: string): MaestroError {
  return new MaestroError('INTERNAL_ERROR', {
    message: `state-manager.${name} is Phase 1 work. See PRODUCT_VISION.md.`,
  })
}
