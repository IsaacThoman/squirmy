import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albumArtists, albums, recordings } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { useTestDatabase } from '../../test/database.js'
import { albumStub, artistStub } from '../../test/enrichment-stubs.js'
import { useHttpFixtures } from '../../test/http.js'
import { decodeEntities, getAlbum, type DeezerAlbum } from '../metadata/deezer.js'
import { buildFromDeezer, creditDeezerTracks, linkDeezerAlbum } from './deezer-rows.js'

/** Deezer's explicit "Watch The Throne (Deluxe)" (16 tracks), as it answered on 2026-11-22. */
const throneDeluxe = 477673195

describe('Deezer text', () => {
  it('decodes HTML entities, also when encoded twice', () => {
    expect(decodeEntities('Will Taylor &amp;amp; Strings Attached')).toBe('Will Taylor & Strings Attached')
    expect(decodeEntities('Rock &#x26; Roll &#39;n&#39; &quot;Soul&quot;')).toBe('Rock & Roll \'n\' "Soul"')
    expect(decodeEntities('AT&T &unknown; & more')).toBe('AT&T &unknown; & more')
  })
})

describe('rows built from Deezer', () => {
  useTestDatabase()
  useHttpFixtures('deezer')

  it('credit every main artist of a collaboration and the guests of each track', async () => {
    const album = (await getAlbum(throneDeluxe))!
    expect(album.artists.map((one) => one.name)).toEqual(['JAŸ-Z', 'Kanye West'])
    const jay = await artistStub({ name: 'JAŸ-Z', deezerId: album.artist.id })
    const { albumId } = await albumStub({ title: album.title, artist: 'JAŸ-Z', artistId: jay, deezerId: throneDeluxe })

    await buildFromDeezer(albumId, album)
    const credits = await db.select({ name: albumArtists.creditedName }).from(albumArtists).where(eq(albumArtists.albumId, albumId)).orderBy(albumArtists.position)
    expect(credits.map((row) => row.name)).toEqual(['JAŸ-Z', 'Kanye West'])

    // The album's track list names only the main artists; each track's own entry has the guests.
    expect(await creditDeezerTracks(album)).toBeGreaterThan(0)
    const [church] = await db.select({ artistCredit: recordings.artistCredit }).from(recordings).where(sql`${recordings.title} like 'No Church In The Wild%'`)
    expect(church!.artistCredit).toContain('Frank Ocean')
    // Nothing more to add the second time.
    expect(await creditDeezerTracks(album)).toBe(0)
  })

  it('copy the explicit flag onto recordings that have none, for the same sound only', async () => {
    const artist = await artistStub({ name: 'Fixture Rapper' })
    const albumId = newId()
    await db.insert(albums).values({ id: albumId, title: 'Loud', artistCredit: 'Fixture Rapper', primaryArtistId: artist, titleKey: 'loud', matchKey: creditKey('Fixture Rapper', 'Loud') })
    const recording = async (title: string, isrc: string) => {
      const id = newId()
      await db.insert(recordings).values({ id, title, artistCredit: 'Fixture Rapper', titleKey: matchKey(title), matchKey: creditKey('Fixture Rapper', title), isrcs: [isrc] })
      return id
    }
    const first = await recording('One', 'QZ0000000001')
    const second = await recording('Two', 'QZ0000000002')
    const releaseId = newId()
    await db.execute(sql`insert into releases (id, album_id, title, track_count, detail_level) values (${releaseId}, ${albumId}, 'Loud', 2, 2)`)
    await db.execute(sql`insert into release_tracks (id, release_id, disc, position, title, recording_id) values
      (${newId()}, ${releaseId}, 1, 1, 'One', ${first}), (${newId()}, ${releaseId}, 1, 2, 'Two', ${second})`)
    await db.update(albums).set({ canonicalReleaseId: releaseId }).where(eq(albums.id, albumId))

    const track = (id: number, title: string, isrc: string, explicit: boolean, trackNumber: number) => ({
      id, title, durationMs: 1000, explicit, rank: null, isrc, artist: { id: 1, name: 'Fixture Rapper' }, artists: [{ id: 1, name: 'Fixture Rapper' }],
      album: null, discNumber: 1, trackNumber, link: '',
    })
    // The clean version: another ISRC at the same place, which must not mark the explicit song clean.
    const clean: DeezerAlbum = {
      id: 1, title: 'Loud', artist: { id: 1, name: 'Fixture Rapper' }, artists: [{ id: 1, name: 'Fixture Rapper' }], coverUrl: null, type: 'album',
      explicit: false, releaseDate: null, trackCount: 2, link: '', upc: null, label: null, genres: [],
      tracks: [track(11, 'One', 'QZ0000000091', false, 1), track(12, 'Two', 'QZ0000000092', false, 2)],
    }
    await linkDeezerAlbum(albumId, clean)
    const flags = async () => (await db.select({ id: recordings.id, explicit: recordings.explicit }).from(recordings)
      .where(sql`${recordings.id} in (${first}, ${second})`).orderBy(recordings.title)).map((row) => row.explicit)
    expect(await flags()).toEqual([null, null])

    const explicit: DeezerAlbum = { ...clean, id: 2, explicit: true, tracks: [track(21, 'One', 'QZ0000000001', true, 1), track(22, 'Two', 'QZ0000000002', false, 2)] }
    await linkDeezerAlbum(albumId, explicit)
    expect(await flags()).toEqual([true, false])
  })
})
