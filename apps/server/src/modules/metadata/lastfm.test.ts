import { describe, expect, it } from 'vitest'
import { ProviderError } from '../../lib/http.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import { apiSignature, getAuthUrl, getSession, invalidSessionCode, scrobble, updateNowPlaying } from './lastfm.js'

const plays = [
  { artist: 'Radiohead', title: 'Airbag', album: 'OK Computer', durationMs: 284_000, trackNumber: 1, startedAt: new Date('2026-11-20T12:00:00Z') },
  { artist: 'Radiohead', title: 'Paranoid Android', album: 'OK Computer', durationMs: 383_000, trackNumber: 2, mbid: 'ef2a4d5c-58b4-4ec4-b1b2-3d0dd3ee2bfd', startedAt: new Date('2026-11-20T12:04:44Z') },
]

describe('lastfm', () => {
  useTestDatabase()
  const http = useHttpFixtures('lastfm')

  it('signs parameters the way Last.fm documents', () => {
    expect(apiSignature({ api_key: 'xyz', method: 'auth.getSession', token: 'abc', format: 'json' }, 's3cret')).toBe('fa6b4d6acf63d07edd2d32d9b3acf20c')
    expect(apiSignature({ method: 'track.scrobble', 'artist[0]': 'Sigur Rós' }, 's3cret')).toBe('12bf3059d744e55dfc5eccb9ff0f9d57')
  })

  it('does nothing without a key and secret', async () => {
    expect(await getAuthUrl('https://music.example.test/lastfm/callback')).toBeNull()
    expect(await getSession('authorized-token')).toBeNull()
    expect(await scrobble('session-key', plays)).toBeNull()
    expect(await updateNowPlaying('session-key', plays[0]!)).toBe(false)
    expect(http.requests).toEqual([])
    await updateServerSettings({ lastFmKey: 'test-lastfm-key', lastFmSecret: 'test-lastfm-secret' })
  })

  it('builds the web auth URL', async () => {
    expect(await getAuthUrl('https://music.example.test/lastfm/callback'))
      .toBe('https://www.last.fm/api/auth/?api_key=test-lastfm-key&cb=https%3A%2F%2Fmusic.example.test%2Flastfm%2Fcallback')
  })

  it('exchanges an authorized token for a session', async () => {
    expect(await getSession('authorized-token')).toEqual({ username: 'squirmy-test', sessionKey: 'test-session-key' })
    expect(await getSession('unauthorized-token')).toBeNull()
  })

  it('scrobbles plays and updates now playing', async () => {
    expect(await scrobble('test-session-key', plays)).toEqual({ accepted: 2, ignored: 0 })
    expect(await updateNowPlaying('test-session-key', plays[0]!)).toBe(true)
  })

  it('reports a revoked session with its error code', async () => {
    const failure = scrobble('revoked-session-key', plays.slice(0, 1))
    await expect(failure).rejects.toBeInstanceOf(ProviderError)
    await expect(failure).rejects.toMatchObject({ upstreamCode: invalidSessionCode })
  })
})
