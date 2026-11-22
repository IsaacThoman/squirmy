import { describe, expect, it } from 'vitest'
import { SetupStatus } from './auth.js'

describe('setup status', () => {
  const status = { needsSetup: false, version: '1.0.0', serverName: 'Squirmy', registrationRequiresInvite: true }

  it('hides the wantlist when a server from before the setting leaves it out', () => {
    expect(SetupStatus.parse(status).wantlistEnabled).toBe(false)
  })

  it('reports the wantlist as the server says', () => {
    expect(SetupStatus.parse({ ...status, wantlistEnabled: true }).wantlistEnabled).toBe(true)
    expect(SetupStatus.safeParse({ ...status, wantlistEnabled: 'on' }).success).toBe(false)
  })
})
