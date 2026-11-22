import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, artists, recordings } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { backfillYears, decodeStoredEntities } from './repair.js'

describe('release repair', () => {
  useTestDatabase()

  it('decodes names and titles stored with HTML entities, and their keys', async () => {
    // As the test instance had it: Deezer's "Will Taylor &amp; Strings Attached".
    const band = await createArtist({ name: 'Will Taylor &amp; Strings Attached' })
    const album = await createAlbum({ title: 'Plays the Beatles White Album', artist: band, tracks: [{ title: 'Rock &amp;amp; Roll' }] })
    await db.update(albums).set({ artistCredit: band.name }).where(eq(albums.id, album.albumId))
    await db.update(recordings).set({ artistCredit: band.name }).where(eq(recordings.id, album.tracks[0]!.recordingId))

    expect(await decodeStoredEntities()).toBeGreaterThanOrEqual(4)
    const [artist] = await db.select({ name: artists.name, nameKey: artists.nameKey }).from(artists).where(eq(artists.id, band.id))
    expect(artist).toEqual({ name: 'Will Taylor & Strings Attached', nameKey: 'will taylor and strings attached' })
    const [song] = await db.select({ title: recordings.title, artistCredit: recordings.artistCredit, titleKey: recordings.titleKey }).from(recordings)
      .where(eq(recordings.id, album.tracks[0]!.recordingId))
    expect(song).toEqual({ title: 'Rock & Roll', artistCredit: 'Will Taylor & Strings Attached', titleKey: 'rock and roll' })
    expect(await decodeStoredEntities()).toBe(0)
  })

  it('gives albums with a date the year', async () => {
    const own = await createAlbum({ title: 'Donda', year: 2021 })
    await db.update(albums).set({ year: null, releaseDate: '2021-08-29' }).where(eq(albums.id, own.albumId))
    // Only the track list knows the date.
    const built = await createAlbum({ title: 'Marraine', year: 2022 })
    await db.update(albums).set({ year: null, releaseDate: null }).where(eq(albums.id, built.albumId))
    expect(await backfillYears()).toBe(2)
    const rows = await db.select({ id: albums.id, year: albums.year, releaseDate: albums.releaseDate }).from(albums).orderBy(albums.title)
    expect(rows.find((row) => row.id === own.albumId)).toMatchObject({ year: 2021, releaseDate: '2021-08-29' })
    expect(rows.find((row) => row.id === built.albumId)).toMatchObject({ year: 2022, releaseDate: '2022' })
    expect(await backfillYears()).toBe(0)
  })
})
