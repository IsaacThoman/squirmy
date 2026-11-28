import { describe, expect, it } from 'vitest'
import { AuthSession, PairingUserCode, PollTvPairing, SetupStatus, StartTvPairing, TvPairingPoll, TvPairingPreview } from './auth.js'

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

describe('speaker pairing', () => {
  it('pairs speakers as well as TVs', () => {
    expect(StartTvPairing.parse({ device: { id: 'speaker-123', name: 'Living room', kind: 'speaker' } }).device.kind).toBe('speaker')
  })

  it('reads a preview from a server that pairs only TVs as a TV', () => {
    expect(TvPairingPreview.parse({ id: '00000000-0000-4000-8000-000000000000', deviceName: 'Den', ipAddress: '10.0.0.2' }).deviceKind).toBe('tv')
  })

  it('reads a sign-in method an older client does not know as none', () => {
    const session = {
      id: '00000000-0000-4000-8000-000000000000', current: false, clientKind: 'speaker', deviceName: 'Den', userAgent: null,
      createdAt: '2026-11-28T00:00:00.000Z', lastSeenAt: '2026-11-28T00:00:00.000Z', expiresAt: '2027-05-28T00:00:00.000Z',
    }
    expect(AuthSession.parse({ ...session, method: 'speaker_pairing' }).method).toBe('speaker_pairing')
    expect(AuthSession.parse({ ...session, method: 'carrier_pigeon' }).method).toBeNull()
  })
})
