import { describe, expect, it } from 'vitest'
import { ProviderError } from '../../lib/http.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import { similarArtists, submitListens, topRecordingsForArtist, validateToken } from './listenbrainz.js'

const radiohead = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'
const uptownFunk = '33b6b148-9dce-4894-902d-d218ecc30666'

const listen = {
  listenedAt: new Date('2026-11-20T12:00:00Z'),
  artist: 'Mark Ronson feat. Bruno Mars',
  title: 'Uptown Funk',
  album: 'Uptown Special',
  recordingMbid: uptownFunk,
  artistMbids: ['c3c82bdc-d9e7-4836-9746-c24ead47ca19', 'afb680f2-b6eb-4cd7-a70b-a63b25c763d5'],
  durationMs: 269_000,
}

describe('listenbrainz', () => {
  useTestDatabase()
  const http = useHttpFixtures('listenbrainz')

  it('stays off until the operator sets a token', async () => {
    expect(await topRecordingsForArtist(radiohead)).toEqual([])
    expect(await similarArtists(radiohead)).toEqual([])
    expect(http.requests).toEqual([])
    await updateServerSettings({ listenBrainzToken: 'operator-token' })
  })

  it('ranks an artist’s top recordings', async () => {
    const top = await topRecordingsForArtist(radiohead, { limit: 10 })
    expect(top).toHaveLength(10)
    expect(top[0]).toMatchObject({ artistName: 'Radiohead', artistMbids: [radiohead] })
    expect(top[0]!.listenCount).toBeGreaterThanOrEqual(top[9]!.listenCount)
    expect(top.map((recording) => recording.title)).toContain('Creep')
  })

  it('lists similar artists without the artist itself', async () => {
    const similar = await similarArtists(radiohead, { limit: 5 })
    expect(similar).toHaveLength(5)
    expect(similar.map((artist) => artist.mbid)).not.toContain(radiohead)
    expect(similar[0]!.score).toBeGreaterThanOrEqual(similar[4]!.score)
  })

  it('submits listens with the user token', async () => {
    await submitListens('valid-user-token', [listen], 'single')
    const [single] = http.requests
    expect(single).toBe('POST https://api.listenbrainz.org/1/submit-listens')
  })

  it('validates a user token and names its account', async () => {
    expect(await validateToken('valid-user-token')).toEqual({ userName: 'squirmy-test' })
    expect(await validateToken('invalid-user-token')).toBeNull()
  })

  it('rejects an invalid user token with a 401 ProviderError', async () => {
    const { listenedAt: _listenedAt, ...nowPlaying } = listen
    const failure = submitListens('invalid-user-token', [nowPlaying], 'playing_now')
    await expect(failure).rejects.toBeInstanceOf(ProviderError)
    await expect(failure).rejects.toMatchObject({ upstreamStatus: 401 })
    await expect(submitListens('valid-user-token', [listen, listen], 'single')).rejects.toThrow(/exactly one/)
  })
})
