import { describe, expect, it } from 'vitest'
import { ServerSettings, UpdateServerSettings, UpdateUserSettings, UserSettings } from './settings.js'

describe('settings patches', () => {
  it('never fills in keys the caller left out', () => {
    expect(UpdateServerSettings.parse({ deezerEnabled: false })).toEqual({ deezerEnabled: false })
    expect(UpdateServerSettings.parse({})).toEqual({})
    expect(UpdateUserSettings.parse({ normalization: 'off' })).toEqual({ normalization: 'off' })
  })

  it('can change every stored setting', () => {
    const derived = new Set(['listenBrainzTokenSet', 'acoustIdKeySet', 'fanartKeySet', 'lastFmKeySet'])
    const patchable = Object.keys(UpdateServerSettings.shape)
    for (const key of Object.keys(ServerSettings.shape)) {
      if (!derived.has(key)) expect(patchable, key).toContain(key)
    }
    expect(Object.keys(UpdateUserSettings.shape).sort()).toEqual(Object.keys(UserSettings.shape).sort())
  })

  it('keeps the wantlist off unless an admin turns it on', () => {
    expect(ServerSettings.parse({}).wantlistEnabled).toBe(false)
    expect(ServerSettings.parse({ wantlistEnabled: true }).wantlistEnabled).toBe(true)
    expect(UpdateServerSettings.parse({ wantlistEnabled: true })).toEqual({ wantlistEnabled: true })
    expect(UpdateServerSettings.safeParse({ wantlistEnabled: 'yes' }).success).toBe(false)
  })
})
