import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { recordingArtists, recordings } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import type { DeezerTrack } from '../metadata/deezer.js'
import { deezerTopTrackRow } from './deezer-rows.js'
import { artistStub } from '../../test/enrichment-stubs.js'

function deezerTrack(input: Partial<DeezerTrack> & Pick<DeezerTrack, 'id' | 'title' | 'artist' | 'artists'>): DeezerTrack {
  return {
    durationMs: 200_000, explicit: false, rank: 1000, isrc: null, album: null, discNumber: null, trackNumber: null,
    link: `https://www.deezer.com/track/${input.id}`, ...input,
  }
}

describe('Deezer top-track rows', () => {
  useTestDatabase()

  it('credits a featured-on track to its own main artist, not to the page artist', async () => {
    const fcukers = await artistStub({ name: 'Fcukers', deezerId: 900001 })
    const tiga = await artistStub({ name: 'Tiga', deezerId: 900002 })
    // A track of Tiga's that Fcukers is featured on, as Fcukers' top tracks list it.
    const id = await deezerTopTrackRow(fcukers, '900001', deezerTrack({
      id: 900100, title: 'SILK SCARF', artist: { id: 900002, name: 'Tiga' }, artists: [{ id: 900002, name: 'Tiga' }, { id: 900001, name: 'Fcukers' }],
    }))

    const [row] = await db.select({ primaryArtistId: recordings.primaryArtistId }).from(recordings).where(eq(recordings.id, id))
    expect(row!.primaryArtistId).toBe(tiga)
    const credits = await db.select({ artistId: recordingArtists.artistId, name: recordingArtists.creditedName }).from(recordingArtists)
      .where(eq(recordingArtists.recordingId, id)).orderBy(asc(recordingArtists.position))
    expect(credits).toEqual([{ artistId: tiga, name: 'Tiga' }, { artistId: fcukers, name: 'Fcukers' }])
  })

  it('repairs a stored credit that names one artist and points at the page artist', async () => {
    // As rows were written before featured-on tracks were credited to their own main artist:
    // live, "Yeat" on Face The Flamë pointed at Grimes, whose page listed the track.
    const grimes = await artistStub({ name: 'Grimes Fixture', deezerId: 900021 })
    const yeat = await artistStub({ name: 'Yeat Fixture', deezerId: 900022 })
    const track = deezerTrack({
      id: 900120, title: 'Face The Flame Fixture', artist: { id: 900022, name: 'Yeat Fixture' },
      artists: [{ id: 900022, name: 'Yeat Fixture' }, { id: 900021, name: 'Grimes Fixture' }],
    })
    const id = await deezerTopTrackRow(grimes, '900021', track)
    await db.update(recordingArtists).set({ artistId: grimes }).where(eq(recordingArtists.recordingId, id))
    await db.update(recordings).set({ primaryArtistId: grimes }).where(eq(recordings.id, id))

    expect(await deezerTopTrackRow(grimes, '900021', track)).toBe(id)
    const credits = await db.select({ artistId: recordingArtists.artistId }).from(recordingArtists)
      .where(eq(recordingArtists.recordingId, id)).orderBy(asc(recordingArtists.position))
    expect(credits.map((credit) => credit.artistId)).toEqual([yeat, grimes])
    const [row] = await db.select({ primaryArtistId: recordings.primaryArtistId }).from(recordings).where(eq(recordings.id, id))
    expect(row!.primaryArtistId).toBe(yeat)
  })

  it('creates a stub for a featured main artist the catalog does not know yet', async () => {
    const page = await artistStub({ name: 'Fcukers II', deezerId: 900011 })
    const id = await deezerTopTrackRow(page, '900011', deezerTrack({
      id: 900110, title: 'Summer 2000 (Fcukers Remix)', artist: { id: 900012, name: 'TV Girl' }, artists: [{ id: 900012, name: 'TV Girl' }, { id: 900011, name: 'Fcukers II' }],
    }))
    const credits = await db.select({ artistId: recordingArtists.artistId }).from(recordingArtists)
      .where(eq(recordingArtists.recordingId, id)).orderBy(asc(recordingArtists.position))
    expect(credits[0]!.artistId).not.toBe(page)
    expect(credits[1]!.artistId).toBe(page)
  })
})
