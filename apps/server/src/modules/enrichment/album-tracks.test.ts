import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import {
  albumArtists, albums, externalIds, likes, mediaFiles, playlistItems, playlists, recordingArtists, recordings, releases, releaseTracks,
  type FileTags,
} from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { albumRow, albumStub, artistStub } from '../../test/enrichment-stubs.js'
import { createLibraryRoot, createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { albumDetail } from '../catalog/pages.js'
import { lockUpserts, upsertRelease } from '../matching/apply.js'
import type { MbRelease } from '../metadata/musicbrainz.js'
import { hydrateAlbum } from './album.js'
import { albumsWithHeldCopies, albumsWithTwins, repairAlbumTracks } from './album-tracks.js'
import { fitStrayRecordings } from './fit.js'
import { setDetailBudget } from './runner.js'

type Delivery = { durationMs: number; tags: FileTags }
const prima = JSON.parse(readFileSync(new URL('../../test/releases/prima.json', import.meta.url), 'utf8')) as {
  deezerAlbumId: number; deezerArtistId: number; releaseGroupMbid: string; atmosReleaseMbid: string
  deliveries: Delivery[]; redBottomsSingle: Delivery
}

/** PRIMA as MusicBrainz and Deezer list it, in order. */
const titles = ['KGB', 'Nicole Kidman', 'I’m the Man', 'Boys', 'Red Bottoms', 'Hitachi', 'Fantasize', 'Starving Artist', 'Marijuana', 'Therapy', 'Ain’t in LA']
/** Deezer's explicit flags for them: four songs have no explicit lyrics on either version. */
const explicit = [true, true, true, true, true, false, false, false, true, false, true]

/**
 * A track list ingest builds from delivered files' tags: no MBID, no source, one
 * MBID-less recording per file with the ISRC its tags carry, and the file on it.
 */
async function deliveredTrackList(albumId: string, artistId: string, rootId: string, deliveries: readonly Delivery[]) {
  const releaseId = newId()
  await db.insert(releases).values({ id: releaseId, albumId, title: deliveries[0]!.tags.album!, trackCount: deliveries.length, barcode: '00881061182924' })
  const ids: string[] = []
  for (const delivery of deliveries) {
    const { title, isrcs, track } = delivery.tags as Required<Pick<FileTags, 'title' | 'isrcs' | 'track'>>
    const recordingId = newId()
    const releaseTrackId = newId()
    await db.insert(recordings).values({
      id: recordingId, title, artistCredit: 'ADÉLA', primaryArtistId: artistId, durationMs: delivery.durationMs, isrcs,
      titleKey: matchKey(title), matchKey: creditKey('ADÉLA', title),
    })
    await db.insert(recordingArtists).values({ recordingId, position: 0, artistId, creditedName: 'ADÉLA' })
    await db.insert(releaseTracks).values({ id: releaseTrackId, releaseId, disc: 1, position: track, recordingId, title, durationMs: delivery.durationMs })
    await db.insert(mediaFiles).values({
      id: newId(), rootId, relPath: `_Fetched/Adéla/${delivery.tags.album} (2026)/${String(track).padStart(2, '0')} ${title}.m4a`,
      size: 1_000_000, mtime: new Date(), container: 'mp4', codec: 'aac', bitrate: 320_000, durationMs: delivery.durationMs, tags: delivery.tags,
      recordingId, releaseTrackId, releaseId, albumId, matchStatus: 'matched', matchSource: 'request', probeStage: 2, source: 'provider:test',
    })
    ids.push(recordingId)
  }
  return { releaseId, ids }
}

async function pageTracks(userId: string, albumId: string) {
  return (await albumDetail(userId, albumId)).discs.flatMap((disc) => disc.tracks)
}

describe('one row per song on an album', () => {
  useTestDatabase()
  useHttpFixtures('enrichment', 'musicbrainz', 'deezer', 'coverart')
  let userId = ''
  beforeAll(async () => {
    await startJobs({ work: false })
    userId = (await createUser()).id
  })
  afterAll(stopJobs)
  beforeEach(() => setDetailBudget(60_000))
  afterAll(() => setDetailBudget(4000))

  it('writes the stereo release and keeps the delivered songs’ rows when MusicBrainz arrives after a delivery', async () => {
    const artistId = await artistStub({ name: 'ADÉLA', deezerId: prima.deezerArtistId })
    const { albumId } = await albumStub({ title: 'PRIMA', artist: 'ADÉLA', artistId, deezerId: prima.deezerAlbumId })
    const root = await createLibraryRoot()
    // Played before the album was opened: five songs were delivered and filed under it.
    const delivered = await deliveredTrackList(albumId, artistId, root.id, prima.deliveries)
    await db.insert(likes).values({ userId, entityType: 'recording', entityId: delivered.ids[1]! })

    const result = await hydrateAlbum(albumId)
    expect(result).not.toBeNull()
    const album = await albumRow(result!)
    expect(album.mbid).toBe(prima.releaseGroupMbid)
    const [canonical] = await db.select({ mbid: releases.mbid }).from(releases).where(eq(releases.id, album.canonicalReleaseId!))
    // Not the Dolby Atmos mix, whose songs are recordings of their own.
    expect(canonical!.mbid).not.toBe(prima.atmosReleaseMbid)

    const tracks = await pageTracks(userId, result!)
    expect(tracks.map((track) => track.title)).toEqual(titles)
    // The delivered rows became the album's tracks: their ids, files and likes stand.
    const places = [1, 3, 4, 9, 11]
    expect(places.map((position) => tracks[position - 1]!.id)).toEqual(delivered.ids)
    for (const position of places) expect(tracks[position - 1]!.availability).toBe('server')
    expect(tracks[2]!.liked).toBe(true)
    expect(tracks.map((track) => track.explicit)).toEqual(explicit)
  })

  it('merges the songs an album lists twice, and the single of a song that lists it again', async () => {
    const { albumId, canonical, stray, single } = await primaAsFound()

    // What users did with the rows shown twice.
    const listener = (await createUser()).id
    await db.insert(likes).values({ userId: listener, entityType: 'recording', entityId: stray.ids[1]! })
    await createPlay({ userId: listener, recordingId: stray.ids[1]!, albumId })
    const playlistId = newId()
    await db.insert(playlists).values({ id: playlistId, ownerId: listener, name: 'Mine' })
    await db.insert(playlistItems).values({ id: newId(), playlistId, position: 0, recordingId: stray.ids[3]!, albumId })

    // Read without opening the page: a page visit fits the album's files itself.
    expect(await albumsWithTwins()).toContain(albumId)

    const report = await repairAlbumTracks({ deezerEnabled: true })
    // Five twins, and Red Bottoms joining the copy the single holds.
    expect(report).toMatchObject({ albums: 1, merged: 6, relinked: 1 })

    const after = await pageTracks(listener, albumId)
    expect(after.map((track) => track.title)).toEqual(titles)
    // Track 5 is the stereo recording the single holds: the album's Atmos row joined it.
    expect(after.map((track) => track.id)).toEqual(canonical.map((id, index) => (index === 4 ? single : id)))
    // Every song plays: Red Bottoms through its single, which carries the code Deezer lists for it here.
    expect(after.map((track) => track.availability)).toEqual(titles.map(() => 'server'))
    expect(after.map((track) => track.explicit)).toEqual(explicit)
    expect(after[2]!.liked).toBe(true)
    const [moved] = await db.select({ recordingId: playlistItems.recordingId }).from(playlistItems).where(eq(playlistItems.playlistId, playlistId))
    expect(moved!.recordingId).toBe(canonical[8])
    const [played] = await db.execute<{ id: string }>(sql`select recording_id as id from plays where user_id = ${listener}`)
    expect(played!.id).toBe(canonical[2])
    // The old ids still lead to the songs.
    for (const [index, id] of stray.ids.entries()) {
      const [row] = await db.select({ into: recordings.mergedIntoId }).from(recordings).where(eq(recordings.id, id))
      expect(row!.into).toBe(canonical[[0, 2, 3, 8, 10][index]!])
    }
    const [atmos] = await db.select({ into: recordings.mergedIntoId }).from(recordings).where(eq(recordings.id, canonical[4]!))
    expect(atmos!.into).toBe(single)

    // Nothing is left to merge.
    expect(await albumsWithTwins()).not.toContain(albumId)
    expect(await repairAlbumTracks({ deezerEnabled: true })).toEqual({ albums: 0, merged: 0, relinked: 0 })
  })

  it('plays a song another release holds even when the album’s twins were folded before', async () => {
    // As the test instance had it after the first repair: the twins were folded, and no run
    // that merged something read PRIMA's Deezer track list again.
    const { albumId, canonical, single } = await primaAsFound()
    await fitNow(albumId)
    expect(await albumsWithTwins()).not.toContain(albumId)
    expect(await albumsWithHeldCopies()).toContain(albumId)

    expect(await repairAlbumTracks({ deezerEnabled: true })).toMatchObject({ albums: 1, merged: 1 })
    const tracks = await pageTracks(userId, albumId)
    expect(tracks[4]).toMatchObject({ id: single, title: 'Red Bottoms', availability: 'server', explicit: true })
    expect(tracks.map((track) => track.availability)).toEqual(titles.map(() => 'server'))

    // MusicBrainz's Atmos release written again keeps the track on the held recording.
    const [moved] = await db.select({ mbid: recordings.mbid }).from(recordings).where(eq(recordings.id, canonical[4]!))
    await db.transaction((tx) => upsertRelease(tx, oneTrackRelease(moved!.mbid!, 'Red Bottoms', ['USUM72604715']), {}, { canonical: 'unless-owned' }))
    const [held] = await db.select({ mbid: recordings.mbid, isrcs: recordings.isrcs, into: recordings.mergedIntoId }).from(recordings).where(eq(recordings.id, single))
    expect(held).toMatchObject({ mbid: redBottomsMbid, into: null })
    expect(held!.isrcs).toEqual(expect.arrayContaining(['USUM72604713', 'USUM72604715']))

    // Nothing is left to do.
    expect(await repairAlbumTracks({ deezerEnabled: true })).toMatchObject({ albums: 0, merged: 0 })
  })

  it('folds the delivered songs into their tracks when the album is opened', async () => {
    const { albumId, canonical, stray } = await primaAsFound()
    const tracks = await pageTracks(userId, albumId)
    expect(tracks.map((track) => track.title)).toEqual(titles)
    expect(tracks.map((track) => track.id)).toEqual(canonical)
    expect(tracks.filter((track) => track.availability === 'server')).toHaveLength(10)
    const [row] = await db.select({ into: recordings.mergedIntoId }).from(recordings).where(eq(recordings.id, stray.ids[0]!))
    expect(row!.into).toBe(canonical[0])
  })
})

const redBottomsMbid = 'eabbb286-caa7-4665-85f7-92745600a461'

/** The "Red Bottoms" single, with the delivered file of its song. */
async function deliveredSingle(artistId: string, rootId: string): Promise<string> {
  const albumId = newId()
  await db.insert(albums).values({
    id: albumId, title: 'Red Bottoms', artistCredit: 'ADÉLA', primaryArtistId: artistId, type: 'single', year: 2026,
    titleKey: 'red bottoms', matchKey: creditKey('ADÉLA', 'Red Bottoms'), detailLevel: 1,
  })
  const { releaseId, ids } = await deliveredTrackList(albumId, artistId, rootId, [prima.redBottomsSingle])
  await db.update(albums).set({ canonicalReleaseId: releaseId }).where(eq(albums.id, albumId))
  // MusicBrainz's stereo recording of the song, as the single's release wrote it.
  await db.update(recordings).set({ mbid: redBottomsMbid }).where(eq(recordings.id, ids[0]!))
  return ids[0]!
}

/**
 * PRIMA as the test instance had it: the group's row shows the Atmos release, five
 * delivered songs sit on a track list built from their tags, and Red Bottoms' file is on
 * the single.
 */
async function primaAsFound() {
  await db.execute(sql`truncate albums, artists, recordings, external_ids cascade`)
  const artistId = await artistStub({ name: 'ADÉLA' })
  const albumId = newId()
  await db.insert(albums).values({
    id: albumId, title: 'PRIMA', artistCredit: 'ADÉLA', primaryArtistId: artistId, type: 'album', year: 2026, releaseDate: '2026-09-04',
    titleKey: 'prima', matchKey: creditKey('ADÉLA', 'PRIMA'), detailLevel: 2, fetchedAt: new Date(),
  })
  await db.insert(albumArtists).values({ albumId, position: 0, artistId, creditedName: 'ADÉLA' })
  await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: String(prima.deezerAlbumId), entityId: albumId })
  const atmos = newId()
  await db.insert(releases).values({ id: atmos, albumId, title: 'PRIMA', trackCount: 11, detailLevel: 2, fetchedAt: new Date(), barcode: '00881061182931' })
  await db.update(albums).set({ canonicalReleaseId: atmos }).where(eq(albums.id, albumId))
  const atmosIsrcs = ['USUM72601923', 'USUM72607794', 'USUM72607788', 'USUM72607783', 'USUM72604715', 'USUM72607786', 'USUM72607785', 'USUM72607796', 'USUM72607791', 'USUM72607797', 'USUM72605979']
  const lengths = [158000, 181000, 150000, 145000, 187000, 216000, 183000, 180000, 110000, 181000, 185000]
  const canonical: string[] = []
  for (const [index, title] of titles.entries()) {
    const id = newId()
    await db.insert(recordings).values({
      id, mbid: newId(), title, artistCredit: 'ADÉLA', primaryArtistId: artistId, durationMs: lengths[index]!, isrcs: [atmosIsrcs[index]!],
      titleKey: matchKey(title), matchKey: creditKey('ADÉLA', title), explicit: explicit[index]!,
    })
    await db.insert(releaseTracks).values({ id: newId(), releaseId: atmos, disc: 1, position: index + 1, recordingId: id, title, durationMs: lengths[index]! })
    canonical.push(id)
  }
  const root = await createLibraryRoot()
  // The songs that did play: delivered files the requests accepted.
  for (const index of [0, 1, 5, 6, 7, 9]) {
    await db.insert(mediaFiles).values({
      id: newId(), rootId: root.id, relPath: `_Fetched/Adéla/PRIMA (2026)/${index + 1}.m4a`, size: 1, mtime: new Date(), container: 'mp4', codec: 'aac',
      durationMs: lengths[index]!, recordingId: canonical[index]!, albumId, releaseId: atmos, matchStatus: 'matched', matchSource: 'request', probeStage: 2, source: 'provider:test',
    })
  }
  const stray = await deliveredTrackList(albumId, artistId, root.id, prima.deliveries)
  const single = await deliveredSingle(artistId, root.id)

  return { albumId, canonical, stray, single }
}

const fitNow = (albumId: string) => db.transaction(async (tx) => {
  await lockUpserts(tx)
  return fitStrayRecordings(tx, albumId)
})

/** A MusicBrainz release of one track, enough for `upsertRelease`. */
function oneTrackRelease(recordingMbid: string, title: string, isrcs: string[]): MbRelease {
  const artistCredit = [{ name: 'ADÉLA', mbid: newId(), joinPhrase: '' }]
  const group = { mbid: newId(), title: 'PRIMA', type: 'album' as const, primaryType: 'Album', secondaryTypes: [], disambiguation: '', artistCredit, artistName: 'ADÉLA', date: '2026-09-04', year: 2026 }
  return {
    mbid: newId(), title: 'PRIMA', status: 'official', country: 'XW', barcode: '00881061182931', disambiguation: 'Dolby Atmos mix', artistCredit, artistName: 'ADÉLA',
    date: '2026-09-04', year: 2026, media: [{ format: 'Digital Media', trackCount: 1 }], trackCount: 1, labels: [], releaseGroup: group, urls: [],
    mediums: [{ position: 1, format: 'Digital Media', title: '', tracks: [{
      mbid: newId(), position: 5, number: '5', title, durationMs: 187000, artistCredit, artistName: 'ADÉLA',
      recording: { mbid: recordingMbid, title, durationMs: 187000, disambiguation: '', video: false, artistCredit, artistName: 'ADÉLA', isrcs } as MbRelease['mediums'][number]['tracks'][number]['recording'],
    }] }],
  }
}
