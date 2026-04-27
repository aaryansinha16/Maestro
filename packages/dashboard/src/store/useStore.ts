// Zustand store. Phase 0 holds only conductor health; Phase 3 adds projects,
// sessions, PR queue. See PRODUCT_VISION.md "Phase 3: The Dashboard".

import { create } from 'zustand'
import type { HealthResponse } from '@maestro/api'

interface State {
  health: HealthResponse | null
  setHealth: (h: HealthResponse | null) => void
}

export const useStore = create<State>((set) => ({
  health: null,
  setHealth: (health) => set({ health }),
}))
