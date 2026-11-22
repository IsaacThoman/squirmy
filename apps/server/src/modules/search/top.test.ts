import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { recordings } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { createUser } from '../../test/factories.js'
import { albumSummaries, artistSummaries, trackSummaries } from '../catalog/summaries.js'
import { topResult } from './top.js'

describe('topResult', () => {
  useTestDatabase()

  /** Summaries in the given orders, as a route would answer them. */
  async function found(ids: { artists?: string[]; albums?: string[]; tracks?: string[] }) {
    const user = await createUser()
    return {
      artists: await artistSummaries(ids.artists ?? []),
      albums: await albumSummaries(ids.albums ?? []),
      tracks: await trackSummaries(user.id, (ids.tracks ?? []).map((id) => ({ id }))),
    }
  }
  const popular = (recordingId: string, popularity: number) => db.update(recordings).set({ popularity }).where(eq(recordings.id, recordingId))

  it('ignores a leading article on either side', async () => {
    const store = await createAlbum({ title: 'The Money Store', artist: await createArtist({ name: 'Death Grips' }), tracks: [{ title: 'Get Got' }] })
    const single = await createAlbum({ title: 'Money Store', artist: await createArtist({ name: 'Someone Else' }), type: 'single', tracks: [{ title: 'Money Store' }] })
    expect(await topResult('money store', await found({ albums: [store.albumId] }))).toEqual({ type: 'album', id: store.albumId, score: 2 })
    // The title as written wins over the one that only matches without its article.
    expect(await topResult('the money store', await found({ albums: [single.albumId, store.albumId] }))).toEqual({ type: 'album', id: store.albumId, score: 3 })
    const beatles = await createAlbum({ title: 'Abbey Road', artist: await createArtist({ name: 'The Beatles' }), tracks: [{ title: 'Come Together' }] })
    expect(await topResult('beatles abbey road', await found({ albums: [beatles.albumId] }))).toEqual({ type: 'album', id: beatles.albumId, score: 2 })
    // "mone" and "money stor" are prefixes of the title once its article is dropped.
    expect(await topResult('money stor', await found({ albums: [store.albumId] }))).toEqual({ type: 'album', id: store.albumId, score: 1 })
  })

  it('does not let a track with known popularity beat an album the provider ranked first', async () => {
    const rainbows = await createAlbum({ title: 'In Rainbows', artist: await createArtist({ name: 'Radiohead' }), tracks: [{ title: '15 Step' }] })
    const dog = await createAlbum({ title: 'Pack', artist: await createArtist({ name: 'a Giant Dog' }), tracks: [{ title: 'In Rainbows' }] })
    await popular(dog.tracks[0]!.recordingId, 0.2)
    // No returned track is on the album, so nothing says how popular it is: list order decides.
    expect(await topResult('in rainbows', await found({ albums: [rainbows.albumId], tracks: [dog.tracks[0]!.recordingId] })))
      .toEqual({ type: 'album', id: rainbows.albumId, score: 3 })

    // When both are known, popularity still decides: Kendrick's song over another artist's single.
    const humble = await createAlbum({ title: 'Humble', artist: await createArtist({ name: 'Ren' }), type: 'single', tracks: [{ title: 'Humble' }] })
    const kendrick = await createAlbum({ title: 'DAMN.', artist: await createArtist({ name: 'Kendrick Lamar' }), tracks: [{ title: 'HUMBLE.' }] })
    await popular(humble.tracks[0]!.recordingId, 0.3)
    await popular(kendrick.tracks[0]!.recordingId, 0.9)
    expect(await topResult('humble', await found({ albums: [humble.albumId], tracks: [kendrick.tracks[0]!.recordingId, humble.tracks[0]!.recordingId] })))
      .toEqual({ type: 'track', id: kendrick.tracks[0]!.recordingId, score: 3 })
  })

  it('treats an edition suffix as the same title, so the first listed edition leads', async () => {
    const beatles = await createArtist({ name: 'The Beatles' })
    const remaster = await createAlbum({ title: 'Let It Be (Remastered 2009)', artist: beatles, tracks: [{ title: 'Two of Us' }] })
    const cover = await createAlbum({ title: 'Let It Be', artist: await createArtist({ name: 'Music Travel Love' }), type: 'single', tracks: [{ title: 'Let It Be' }] })
    expect(await topResult('let it be', await found({ albums: [remaster.albumId, cover.albumId] }))).toEqual({ type: 'album', id: remaster.albumId, score: 3 })
  })

  it('leads with a name one typo away when nothing matches better', async () => {
    const artist = await createArtist({ name: 'Death Grips' })
    const store = await createAlbum({ title: 'The Money Store', artist, tracks: [{ title: 'Get Got' }] })
    expect(await topResult('deth grips', await found({ artists: [artist.id], albums: [store.albumId] }))).toEqual({ type: 'artist', id: artist.id, score: 1 })
    // A prefix still beats a typo.
    const other = await createArtist({ name: 'Deth Gripsy' })
    expect(await topResult('deth grips', await found({ artists: [artist.id, other.id] }))).toEqual({ type: 'artist', id: other.id, score: 1 })
    // Short queries need the real thing.
    expect(await topResult('dg', await found({ artists: [artist.id] }))).toBeNull()
    expect(await topResult('the deaf', await found({ artists: [artist.id] }))).toBeNull()
  })
  it('scores a hint so that a higher score is one this ranking would have put first', async () => {
    const tvGirl = await createArtist({ name: 'TV Girl' })
    const lovers = await createAlbum({ title: 'TV Girl Lovers Rock', artist: await createArtist({ name: 'Fan Covers' }), tracks: [{ title: 'Lovers Rock' }] })
    const french = await createAlbum({ title: 'French Exit', artist: tvGirl, tracks: [{ title: 'Birds Dont Sing' }] })
    // The library's prefix match and the catalog's exact artist are picked separately; the
    // scores say which of the two leads.
    expect(await topResult('tv girl', await found({ albums: [lovers.albumId] }))).toEqual({ type: 'album', id: lovers.albumId, score: 1 })
    expect(await topResult('tv girl', await found({ artists: [tvGirl.id], albums: [french.albumId] }))).toEqual({ type: 'artist', id: tvGirl.id, score: 3 })
    expect(await topResult('tv girl french exit', await found({ albums: [french.albumId] }))).toEqual({ type: 'album', id: french.albumId, score: 3 })
    expect(await topResult('the tv girl', await found({ artists: [tvGirl.id] }))).toEqual({ type: 'artist', id: tvGirl.id, score: 2 })
    expect(await topResult('tv grl', await found({ artists: [tvGirl.id] }))).toEqual({ type: 'artist', id: tvGirl.id, score: 1 })
  })
})
