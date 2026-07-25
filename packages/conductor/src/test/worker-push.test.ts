// ENG-07 / VAL-01: the worker pushes with a token-authenticated URL for GitHub
// HTTPS remotes (avoiding credential helpers), and falls back to the ambient
// origin for local/test remotes or when no token is configured.

import { describe, expect, it } from 'vitest'
import { authenticatedPushUrl } from '../worker.js'

describe('authenticatedPushUrl (ENG-07)', () => {
  it('builds a token URL for an https github remote', () => {
    expect(authenticatedPushUrl('https://github.com/o/r', 'tok')).toBe(
      'https://x-access-token:tok@github.com/o/r.git',
    )
  })

  it('normalises a trailing .git and slash', () => {
    expect(authenticatedPushUrl('https://github.com/o/r.git', 'tok')).toBe(
      'https://x-access-token:tok@github.com/o/r.git',
    )
    expect(authenticatedPushUrl('https://github.com/o/r/', 'tok')).toBe(
      'https://x-access-token:tok@github.com/o/r.git',
    )
  })

  it('returns null without a token (keeps the ambient push path)', () => {
    expect(authenticatedPushUrl('https://github.com/o/r', undefined)).toBeNull()
  })

  it('returns null for local/file and non-github remotes', () => {
    expect(authenticatedPushUrl('file:///tmp/remote.git', 'tok')).toBeNull()
    expect(authenticatedPushUrl('https://gitlab.com/o/r', 'tok')).toBeNull()
    expect(authenticatedPushUrl('git@github.com:o/r.git', 'tok')).toBeNull()
  })
})
