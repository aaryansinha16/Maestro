// ENG-04: manual triggers still fire when over the monthly budget, but the
// trigger endpoint surfaces a warning instead of silently bypassing the
// throttle. The warning logic is a pure helper, tested directly here.

import { describe, expect, it } from 'vitest'
import { overBudgetWarning } from '../server.js'

describe('overBudgetWarning (ENG-04)', () => {
  it('returns null below the throttle line (95%)', () => {
    // $40 of $50 = 80% — below COST_THROTTLE_ALL_FRACTION.
    expect(overBudgetWarning(4000, 50)).toBeNull()
  })

  it('warns at/above the throttle line', () => {
    // $100 of $50 = 200%.
    const w = overBudgetWarning(10000, 50)
    expect(w).not.toBeNull()
    expect(w).toMatch(/200% of budget/)
    expect(w).toMatch(/still fire/)
  })

  it('returns null when the budget is zero / disabled', () => {
    expect(overBudgetWarning(9999, 0)).toBeNull()
  })
})
