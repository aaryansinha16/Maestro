// PROD-01: production must not boot with dashboard auth misconfigured.

import { describe, expect, it } from 'vitest'
import { assertProductionAuth } from '../config.js'
import { isMaestroError } from '@maestro/shared'

describe('assertProductionAuth (PROD-01)', () => {
  it('allows non-production without auth', () => {
    expect(() =>
      assertProductionAuth({ nodeEnv: 'development', allowUnauthenticated: false }),
    ).not.toThrow()
  })

  it('allows production when both auth vars are set', () => {
    expect(() =>
      assertProductionAuth({
        nodeEnv: 'production',
        authUser: 'u',
        authPassword: 'a-strong-pw',
        allowUnauthenticated: false,
      }),
    ).not.toThrow()
  })

  it('allows production with an explicit opt-out', () => {
    expect(() =>
      assertProductionAuth({ nodeEnv: 'production', allowUnauthenticated: true }),
    ).not.toThrow()
  })

  it('throws in production without auth and without opt-out', () => {
    let thrown: unknown
    try {
      assertProductionAuth({ nodeEnv: 'production', allowUnauthenticated: false })
    } catch (err) {
      thrown = err
    }
    expect(isMaestroError(thrown)).toBe(true)
  })

  it('throws in production when only one auth var is set (the old silent-open path)', () => {
    expect(() =>
      assertProductionAuth({
        nodeEnv: 'production',
        authUser: 'u',
        allowUnauthenticated: false,
      }),
    ).toThrow()
  })
})
