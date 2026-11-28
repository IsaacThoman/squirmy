import { describe, expect, it } from 'vitest'
import { PairingUserCode, PollTvPairing, SetupStatus, StartTvPairing, TvPairingPoll } from './auth.js'

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


describe('TV pairing', () => {
  it('normalizes the displayed user code and rejects ambiguous characters', () => {
    expect(PairingUserCode.parse(' abcd-2345 ')).toBe('ABCD2345')
    expect(PairingUserCode.parse('ABCD2345')).toBe('ABCD2345')
    for (const code of ['ABC', 'ABCD--2345', 'IO10-2345', 'ABCD-23456']) {
      expect(PairingUserCode.safeParse(code).success).toBe(false)
    }
  })

  it('keeps the short user code separate from the secret used to poll', () => {
    expect(PollTvPairing.safeParse({ deviceCode: 'ABCD-2345' }).success).toBe(false)
    expect(PollTvPairing.safeParse({ deviceCode: 'a'.repeat(43) }).success).toBe(true)
    expect(StartTvPairing.safeParse({ device: { id: 'device-123', name: 'iPhone', kind: 'ios' } }).success).toBe(false)
    expect(TvPairingPoll.safeParse({ status: 'approved' }).success).toBe(false)
    expect(TvPairingPoll.parse({ status: 'slow_down', intervalSeconds: 10 })).toMatchObject({ intervalSeconds: 10 })
  })
})
