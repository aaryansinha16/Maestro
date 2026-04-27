// Quality gate runners. Phase 1 work (see PRODUCT_VISION.md). Per ADR-006:
// gates run after the agent commits, before PR creation. If any gate fails,
// the branch is preserved but no PR opens.

import type { QualityGate, QualityGateRun } from '@maestro/shared'
import { MaestroError } from '@maestro/shared'

export interface RunQualityGatesInput {
  /** Absolute path to the working checkout. */
  projectRoot: string
  sessionId: string
  gates: QualityGate[]
}

export async function runQualityGates(
  _input: RunQualityGatesInput,
): Promise<QualityGateRun[]> {
  throw new MaestroError('INTERNAL_ERROR', {
    message: 'runQualityGates is Phase 1 work. See PRODUCT_VISION.md.',
  })
}
