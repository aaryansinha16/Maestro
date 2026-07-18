// SH-02: the spawned `claude` process must receive the Claude Code auth
// passthrough (CLAUDE_CONFIG_DIR + CLAUDE_CODE_OAUTH_TOKEN) so a headless
// self-hosted instance can authenticate with the owner's own token — while
// still never forwarding operational secrets like GITHUB_TOKEN.

import { afterEach, describe, expect, it } from 'vitest'
import { claudeEnv } from '../claude-runner.js'

const saved = new Map<string, string | undefined>()

function stash(key: string): void {
  if (!saved.has(key)) saved.set(key, process.env[key])
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  saved.clear()
})

describe('claudeEnv (SH-02 headless auth passthrough)', () => {
  it('forwards CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CONFIG_DIR when set', () => {
    stash('CLAUDE_CODE_OAUTH_TOKEN')
    stash('CLAUDE_CONFIG_DIR')
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'tok_test'
    process.env['CLAUDE_CONFIG_DIR'] = '/data/claude'
    const env = claudeEnv()
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok_test')
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/data/claude')
  })

  it('does not invent the token when unset', () => {
    stash('CLAUDE_CODE_OAUTH_TOKEN')
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
    expect(claudeEnv()['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined()
  })

  it('never forwards GITHUB_TOKEN (secret isolation preserved)', () => {
    stash('GITHUB_TOKEN')
    process.env['GITHUB_TOKEN'] = 'ghp_secret'
    expect(claudeEnv()['GITHUB_TOKEN']).toBeUndefined()
  })
})
