import { describe, expect, it } from 'vitest'
import { ServerSettings, UpdateServerSettings, UpdateUserSettings, UserSettings } from './settings.js'

describe('settings patches', () => {
  it('never fills in keys the caller left out', () => {
    expect(UpdateServerSettings.parse({ deezerEnabled: false })).toEqual({ deezerEnabled: false })
    expect(UpdateServerSettings.parse({})).toEqual({})
    expect(UpdateUserSettings.parse({ normalization: 'off' })).toEqual({ normalization: 'off' })
  })

  it('can change every stored setting', () => {
    const derived = new Set(['listenBrainzTokenSet', 'acoustIdKeySet', 'fanartKeySet', 'lastFmKeySet', 'ssoClientSecretSet', 'ssoCallbackUrl'])
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

  it('takes only an http or https MusicBrainz address', () => {
    expect(UpdateServerSettings.parse({ musicBrainzBaseUrl: 'http://musicbrainz-mirror:5000' })).toEqual({ musicBrainzBaseUrl: 'http://musicbrainz-mirror:5000' })
    for (const bad of ['', 'http//mirror:5000', 'musicbrainz-mirror:5000', 'ftp://mirror/']) {
      expect(UpdateServerSettings.safeParse({ musicBrainzBaseUrl: bad }).success, bad).toBe(false)
    }
  })

  it('falls back to the public MusicBrainz server when a stored address is not usable', () => {
    expect(ServerSettings.parse({ musicBrainzBaseUrl: 'musicbrainz-mirror:5000' }).musicBrainzBaseUrl).toBe('https://musicbrainz.org')
    expect(ServerSettings.parse({ musicBrainzBaseUrl: 'https://mb.example.com/' }).musicBrainzBaseUrl).toBe('https://mb.example.com/')
  })

  it('asks for the openid scope and an http or https issuer', () => {
    expect(UpdateServerSettings.safeParse({ ssoScopes: 'openid profile email' }).success).toBe(true)
    expect(UpdateServerSettings.safeParse({ ssoScopes: 'profile email' }).success).toBe(false)
    expect(UpdateServerSettings.safeParse({ ssoIssuerUrl: 'javascript:alert(1)' }).success).toBe(false)
    expect(UpdateServerSettings.parse({ ssoIssuerUrl: null })).toEqual({ ssoIssuerUrl: null })
    expect(ServerSettings.parse({ ssoIssuerUrl: 'not a url' }).ssoIssuerUrl).toBeNull()
  })
})
