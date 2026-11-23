import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '../../database/client.js'
import { albums, externalIds } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { deezer } from '../metadata/index.js'
import type { DeezerAlbumSummary } from '../metadata/deezer.js'
import { deezerDiscography } from './deezer-rows.js'
import { retypeDeezerSoundtracks } from './repair.js'

/** Deezer's "Gladiator: 20th Anniversary Edition": filed under Films/Games, no film in its title. */
const gladiator20 = 145932142

describe('retypeDeezerSoundtracks', () => {
  useTestDatabase()
  const http = useHttpFixtures('deezer')

  it('reads a composer’s Deezer-only albums once and types the ones Deezer files under film music', async () => {
    const zimmer = await createArtist({ name: 'Hans Zimmer' })
    await createAlbum({ artist: zimmer, title: 'Inception', type: 'soundtrack', mbid: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' })
    const { albumId } = await createAlbum({ artist: zimmer, title: 'Gladiator: 20th Anniversary Edition' })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: String(gladiator20), entityId: albumId })
    // An artist with no soundtracks: their albums are not read.
    const band = await createArtist({ name: 'A Band' })
    const other = await createAlbum({ artist: band, title: 'An Album' })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: '1', entityId: other.albumId })

    expect(await retypeDeezerSoundtracks()).toEqual({ soundtrackChecks: 1, soundtracks: 1 })
    const [row] = await db.select({ type: albums.type, genres: albums.genres }).from(albums).where(eq(albums.id, albumId))
    expect(row).toMatchObject({ type: 'soundtrack' })
    expect(row!.genres).toContain('Films/Games')
    // Read once: it is a soundtrack now, and its genres say it was read.
    const before = http.requests.length
    expect(await retypeDeezerSoundtracks()).toEqual({ soundtrackChecks: 0, soundtracks: 0 })
    expect(http.requests.length).toBe(before)
  })
})

describe('deezerDiscography', () => {
  useTestDatabase()

  it('types a Deezer-only album a soundtrack when Deezer now says it is one, never a MusicBrainz row', async () => {
    const zimmer = await createArtist({ name: 'Hans Zimmer' })
    const deezerOnly = await createAlbum({ artist: zimmer, title: 'The Dark Knight' })
    const musicBrainz = await createAlbum({ artist: zimmer, title: 'Batman Begins', mbid: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e' })
    await db.insert(externalIds).values([
      { provider: 'deezer', entityType: 'album', externalId: '11', entityId: deezerOnly.albumId },
      { provider: 'deezer', entityType: 'album', externalId: '12', entityId: musicBrainz.albumId },
    ])
    const summary = (id: number, title: string): DeezerAlbumSummary => ({
      id, title, artist: { id: 1, name: 'Hans Zimmer' }, artists: [{ id: 1, name: 'Hans Zimmer' }], coverUrl: null,
      type: 'soundtrack', explicit: false, releaseDate: '2008-07-14', trackCount: 14, link: `https://www.deezer.com/album/${id}`,
    })
    const spy = vi.spyOn(deezer, 'getArtistAlbums').mockResolvedValue([summary(11, 'The Dark Knight'), summary(12, 'Batman Begins')])
    try {
      await deezerDiscography(zimmer.id, '1')
    } finally {
      spy.mockRestore()
    }
    const typeOf = async (id: string) => (await db.select({ type: albums.type }).from(albums).where(eq(albums.id, id)))[0]!.type
    expect(await typeOf(deezerOnly.albumId)).toBe('soundtrack')
    expect(await typeOf(musicBrainz.albumId)).toBe('album')
  })
})
