import { createReadStream } from 'node:fs'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AlbumDetail } from '@squirmy/contracts'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import {
  acquisitionJobs, acquisitionMisses, albumArtists, albums, artists, externalIds, imports, likes, matchReviews, mediaFiles, playlistItems, playlists, plays,
  recordingArtists, recordings, releases, releaseTracks, wants,
} from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { body, signIn } from '../../test/api.js'
import { makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { resolveOne } from '../catalog/redirects.js'
import { albumSummaries } from '../catalog/summaries.js'
import { addImportFile, commitImport, createImport, importsModule } from '../imports/index.js'
import { libraryModule } from '../library/index.js'
import { insertRoot } from '../library/roots.js'
import { scanRoot } from '../library/scan.js'
import { matchingModule } from '../matching/index.js'
import { createProvider } from './providers.js'
import { repairDeliveries } from './repair.js'
import { mergeDelivered } from './verify.js'

/**
 * The repair, on a library left the way the live instance was before deliveries were placed
 * on their album (audit of 2026-11-22): every on-demand track was its own import in
 * `_Incoming/<importId>/Release/`, ingest built a one-track album for each from the file's
 * tags, verification merged only the recording into the requested one, matching left each
 * file for review, and nothing was filed. Users had liked, queued and played the copies.
 *
 * The seed runs the real import and ingest on files tagged like the old provider tagged them,
 * for jobs that had already ended (so nothing places them), then does what the old
 * verification and matching did by hand.
 */

async function eventually(check: () => void | Promise<void>, timeoutMs = 60_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (performance.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

type User = Awaited<ReturnType<typeof signIn>>
type Tags = { title: string; artist: string; album: string; position: number; year?: number; albumArtist?: string; artists?: string }

describe('repairing deliveries left on albums of their own', () => {
  useTestDatabase()
  let app: FastifyInstance
  let fixtures = ''
  let rootDir = ''
  let rootId = ''
  let providerId = ''
  let fan: User
  let tone = 300

  beforeAll(async () => {
    await updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: false, coverArtArchiveEnabled: false, wikidataEnabled: false, lrclibEnabled: false })
    app = await buildApp()
    // Not the acquisition module: its sweep would repair the seed while it is being made.
    for (const module of [libraryModule, matchingModule, importsModule]) await module.jobs!(jobs)
    await startJobs({ work: true })
    fixtures = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-repair-fixtures-')))
    rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-repair-')))
    rootId = (await insertRoot({ name: 'Music', path: rootDir, mode: 'managed', watch: false })).id
    await updateServerSettings({ importRootId: rootId })
    providerId = (await createProvider({ name: 'Old provider', baseUrl: 'http://127.0.0.1:9', secret: 'old-provider-secret', enabled: true, priority: 0 })).id
    fan = await signIn({ canAcquire: true })
  }, 60_000)
  afterAll(async () => {
    await stopJobs()
    await app.close()
    await rm(fixtures, { recursive: true, force: true })
    await rm(rootDir, { recursive: true, force: true })
  })

  /** A finished job for one recording, as the job list showed them. */
  async function endedJob(recordingId: string, albumId: string | null, status: 'completed' | 'failed' = 'completed', error: string | null = null) {
    const id = newId()
    await db.insert(acquisitionJobs).values({
      id, providerId, requestedBy: fan.id, recordingId, albumId, recordingIds: [recordingId], status, error,
      idempotencyKey: `recording:${recordingId}:${id}`, completedAt: new Date(),
    })
    return id
  }

  /** One file through a real acquisition import, tagged like the old provider: track artist as album artist, "N/1", no ids, `Release/1-0NN`. */
  async function oldImport(jobId: string, tags: Tags) {
    const delivery = await createImport({ kind: 'acquisition', userId: fan.id, acquisitionJobId: jobId, rootId })
    await db.update(acquisitionJobs).set({ importId: delivery.id }).where(eq(acquisitionJobs.id, jobId))
    const name = `Release/1-${String(tags.position).padStart(3, '0')}.flac`
    tone += 37
    const file = await makeTone(fixtures, {
      path: `${delivery.id}.flac`, durationSec: 2, frequency: tone,
      tags: {
        title: tags.title, artist: tags.artist, album_artist: tags.albumArtist ?? tags.artist, album: tags.album, track: `${tags.position}/1`, disc: '1/1',
        date: tags.year ?? 2012, ...(tags.artists ? { ARTISTS: tags.artists } : {}),
      },
    })
    await addImportFile(delivery.id, { filename: path.basename(name), relativePath: name, stream: createReadStream(file) })
    await commitImport(delivery.id)
    await eventually(async () => {
      const [row] = await db.select({ status: imports.status }).from(imports).where(eq(imports.id, delivery.id))
      expect(row!.status).toBe('completed')
    })
    await drainJobs()
    const [delivered] = await db.select().from(mediaFiles).where(eq(mediaFiles.importId, delivery.id))
    expect(delivered).toMatchObject({ source: `provider:${providerId}`, relPath: `_Incoming/${delivery.id}/${name}` })
    return { importId: delivery.id, file: delivered! }
  }

  /** What the old verification and matching did with a delivery: the recording merged into the requested one, the file left for review. */
  async function oldVerify(requestedId: string, file: typeof mediaFiles.$inferSelect) {
    const [requested] = await db.select().from(recordings).where(eq(recordings.id, requestedId))
    const [delivered] = await db.select().from(recordings).where(eq(recordings.id, file.recordingId!))
    expect(await mergeDelivered(requested!, delivered!, file.id)).toBe(true)
    await db.update(mediaFiles).set({ matchStatus: 'review' }).where(eq(mediaFiles.id, file.id))
    await db.insert(matchReviews).values({ id: newId(), rootId, groupKey: file.groupKey!, summary: { album: 'copy', trackCount: 1 }, candidates: [] }).onConflictDoNothing()
    const [after] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, file.id))
    return after!
  }

  /** An old on-demand fetch, start to end. Returns the file and the one-track album it made. */
  async function fetchedTheOldWay(recordingId: string, albumId: string | null, tags: Tags) {
    const jobId = await endedJob(recordingId, albumId)
    const { importId, file } = await oldImport(jobId, tags)
    const placed = await oldVerify(recordingId, file)
    expect(placed.albumId).not.toBe(albumId)
    return { jobId, importId, file: placed, copyId: placed.albumId! }
  }

  /** A MusicBrainz album with its edition and recordings identified, as album detail writes it. */
  async function identified(input: Parameters<typeof createAlbum>[0]) {
    const album = await createAlbum({ mbid: crypto.randomUUID(), ...input, tracks: input!.tracks!.map((track) => ({ mbid: crypto.randomUUID(), ...track })) })
    await db.update(releases).set({ mbid: crypto.randomUUID(), fetchedAt: new Date(), status: 'official' }).where(eq(releases.id, album.releaseId))
    return album
  }

  const fileRow = async (id: string) => (await db.select().from(mediaFiles).where(eq(mediaFiles.id, id)))[0]!
  const albumRow = async (id: string) => (await db.select().from(albums).where(eq(albums.id, id)))[0]
  /**
   * The artist's albums that hold a present file, in title order. Deliveries are cache, so
   * they are in nobody's library; this is where they show on artist pages and in search.
   */
  const libraryAlbums = async (artistId: string) => {
    const held = await db.selectDistinct({ id: mediaFiles.albumId }).from(mediaFiles).where(and(isNull(mediaFiles.missingSince), isNotNull(mediaFiles.albumId)))
    return (await albumSummaries(held.map((row) => row.id!)))
      .filter((album) => album.artists.some((artist) => artist.id === artistId))
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  }
  const albumPage = async (albumId: string) => body(await app.inject({ url: `/api/v1/albums/${albumId}`, headers: fan.headers }), AlbumDetail)
  const exists = (relPath: string) => access(path.join(rootDir, relPath)).then(() => true, () => false)

  it('merges the look-alike albums into the album they were fetched from, and leaves everything else alone', async () => {
    // "The Money Store": the album, three of its tracks fetched one at a time.
    const lp = await identified({
      title: 'The Coin Shop', year: 2012,
      tracks: [{ title: 'Got Given', durationMs: 2000 }, { title: 'The Chill', durationMs: 2000 }, { title: 'Found Girls', durationMs: 2000 }, { title: 'Whitejack', durationMs: 2000 }],
    })
    const artistName = lp.artist.name
    const lpTags = (position: number): Tags => ({ title: lp.tracks[position - 1]!.title, artist: artistName, album: 'The Coin Shop', position })
    const fetched = [
      await fetchedTheOldWay(lp.tracks[0]!.recordingId, lp.albumId, lpTags(1)),
      await fetchedTheOldWay(lp.tracks[2]!.recordingId, lp.albumId, lpTags(3)),
      await fetchedTheOldWay(lp.tracks[1]!.recordingId, lp.albumId, lpTags(2)),
    ]
    const copies = fetched.map((item) => item.copyId)
    expect(new Set(copies).size).toBe(3)

    // What people did with the copies while they were visible.
    const [copy] = copies as [string]
    await db.insert(likes).values({ userId: fan.id, entityType: 'album', entityId: copy })
    await db.insert(wants).values({ userId: fan.id, entityType: 'album', entityId: copies[1]! })
    await db.insert(likes).values({ userId: fan.id, entityType: 'recording', entityId: lp.tracks[0]!.recordingId })
    const playlistId = newId()
    await db.insert(playlists).values({ id: playlistId, ownerId: fan.id, name: 'Fetched' })
    await db.insert(playlistItems).values({ id: newId(), playlistId, position: 0, recordingId: lp.tracks[0]!.recordingId, albumId: copy, addedBy: fan.id })
    const playId = newId()
    await db.insert(plays).values({ id: playId, userId: fan.id, recordingId: lp.tracks[2]!.recordingId, albumId: copies[1]!, msPlayed: 2000, completed: true })

    // Another release group of the same name by the same artist, with a fetched track of its own.
    const single = await identified({ title: 'The Coin Shop', type: 'single', artist: lp.artist, year: 2011, tracks: [{ title: 'Got Given (Single Edit)', durationMs: 2000 }] })
    const fromSingle = await fetchedTheOldWay(single.tracks[0]!.recordingId, single.albumId, { title: 'Got Given (Single Edit)', artist: artistName, album: 'The Coin Shop', position: 1, year: 2011 })

    // The owner's own copy of the album in a folder of their own, scanned, never fetched.
    await makeTone(rootDir, {
      path: `${artistName}/Coin Shop rip/04 Whitejack.flac`, durationSec: 2, frequency: 1500,
      tags: { title: 'Whitejack', artist: artistName, album_artist: artistName, album: 'The Coin Shop', track: 4 },
    })
    await scanRoot({ rootId, paths: [`${artistName}/Coin Shop rip`] })
    await drainJobs()
    const [own] = await db.select().from(mediaFiles).where(sql`${mediaFiles.relPath} like ${`${artistName}/Coin Shop rip/%`}`)
    await eventually(async () => expect((await fileRow(own!.id)).albumId).not.toBeNull())
    const ownBefore = await fileRow(own!.id)

    // "Ö": a search stub of "Shake It Up" fetched first, then the album's own recording of it
    // fetched again, which the import dropped as a copy, so that job failed with a miss.
    const fcukers = await createArtist({ name: 'Fcukerz' })
    const oh = await identified({ title: 'Oh', artist: fcukers, year: 2026, tracks: [{ title: 'Butterflies', durationMs: 2000 }, { title: 'Shake It Up', durationMs: 2400 }] })
    const stub = newId()
    await db.insert(recordings).values({
      id: stub, title: 'Shake It Up', artistCredit: fcukers.name, primaryArtistId: fcukers.id, durationMs: 2000, albumHintId: oh.albumId,
      titleKey: matchKey('Shake It Up'), matchKey: creditKey(fcukers.name, 'Shake It Up'),
    })
    await db.insert(recordingArtists).values({ recordingId: stub, position: 0, artistId: fcukers.id, creditedName: fcukers.name })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: 'shake-it-up', entityId: stub })
    const shaken = await fetchedTheOldWay(stub, oh.albumId, { title: 'Shake It Up', artist: fcukers.name, album: 'Oh', position: 6, year: 2026 })
    const refused = await endedJob(oh.tracks[1]!.recordingId, oh.albumId, 'failed', 'The delivered files are not what was asked for')
    await db.insert(acquisitionMisses).values({ providerId, entityType: 'recording', entityId: oh.tracks[1]!.recordingId, reason: 'The delivered files are not what was asked for' })
    const butterflies = await fetchedTheOldWay(oh.tracks[0]!.recordingId, oh.albumId, { title: 'Butterflies', artist: fcukers.name, album: 'Oh', position: 3, year: 2026 })

    // "SILK SCARF": a top-track stub fetched with no album; the tags ran its two artists
    // together as the album artist, which made an artist of that name.
    const tiga = await createArtist({ name: 'Tigah' })
    const hotlife = newId()
    await db.insert(albums).values({
      id: hotlife, title: 'HOTLIFE', artistCredit: tiga.name, primaryArtistId: tiga.id, type: 'album', detailLevel: 0,
      titleKey: matchKey('HOTLIFE'), matchKey: creditKey(tiga.name, 'HOTLIFE'),
    })
    await db.insert(albumArtists).values({ albumId: hotlife, position: 0, artistId: tiga.id, creditedName: tiga.name })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: 'hotlife', entityId: hotlife })
    const scarf = newId()
    await db.insert(recordings).values({
      id: scarf, title: 'SILK SCARF', artistCredit: `${tiga.name} & ${fcukers.name}`, primaryArtistId: tiga.id, durationMs: 2000, albumHintId: hotlife,
      titleKey: matchKey('SILK SCARF'), matchKey: creditKey(`${tiga.name} & ${fcukers.name}`, 'SILK SCARF'),
    })
    await db.insert(recordingArtists).values([
      { recordingId: scarf, position: 0, artistId: tiga.id, creditedName: tiga.name, joinPhrase: ' & ' },
      { recordingId: scarf, position: 1, artistId: fcukers.id, creditedName: fcukers.name },
    ])
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: 'silk-scarf', entityId: scarf })
    const silk = await fetchedTheOldWay(scarf, null, {
      title: 'SILK SCARF', artist: `${tiga.name}, ${fcukers.name}`, artists: `${tiga.name};${fcukers.name}`, albumArtist: `${tiga.name}, ${fcukers.name}`, album: 'HOTLIFE', position: 4, year: 2025,
    })
    // Grouping used to make one artist of the album artist tag.
    const combined = newId()
    const combinedName = `${tiga.name}, ${fcukers.name}`
    await db.insert(artists).values({ id: combined, name: combinedName, sortName: combinedName, nameKey: matchKey(combinedName), detailLevel: 1 })
    await db.update(albumArtists).set({ artistId: combined, creditedName: combinedName }).where(eq(albumArtists.albumId, silk.copyId))
    await db.update(albums).set({ primaryArtistId: combined, artistCredit: combinedName }).where(eq(albums.id, silk.copyId))

    // A delivery that was another song: its job failed and it stays where it is.
    const wrongJob = await endedJob(lp.tracks[3]!.recordingId, lp.albumId, 'failed', 'The delivered files are not what was asked for')
    const wrong = await oldImport(wrongJob, { title: 'Something Else', artist: artistName, album: 'The Coin Shop', position: 4 })
    await db.update(mediaFiles).set({ matchStatus: 'review' }).where(eq(mediaFiles.id, wrong.file.id))
    await db.insert(matchReviews).values({ id: newId(), rootId, groupKey: wrong.file.groupKey!, summary: { album: 'The Coin Shop', trackCount: 1 }, candidates: [] })

    // The broken state, as the library showed it.
    expect((await libraryAlbums(lp.artist.id)).filter((album) => album.title === 'The Coin Shop')).toHaveLength(6)
    expect(await db.select().from(matchReviews).where(eq(matchReviews.status, 'open'))).toHaveLength(8)

    const result = await repairDeliveries()
    await drainJobs()
    expect(result).toMatchObject({ placed: 7 })

    // One album, holding the fetched tracks in its own order, filed where Organize puts it.
    const listed = await libraryAlbums(lp.artist.id)
    // The other song's delivery keeps the album its tags made; it is not one of these.
    expect(listed.map((album) => album.id).sort()).toEqual([lp.albumId, single.albumId, ownBefore.albumId, wrong.file.albumId].sort())
    expect(listed.find((album) => album.id === lp.albumId)).toMatchObject({ availability: 'partial', trackCount: 4, ownedTrackCount: 3 })
    const page = await albumPage(lp.albumId)
    expect(page.discs[0]!.tracks.map((track) => [track.position, track.id, track.availability === 'server'])).toEqual([
      [1, lp.tracks[0]!.recordingId, true], [2, lp.tracks[1]!.recordingId, true], [3, lp.tracks[2]!.recordingId, true], [4, lp.tracks[3]!.recordingId, false],
    ])
    for (const item of fetched) {
      const position = lp.tracks.findIndex((track) => track.recordingId === item.file.recordingId)
      const file = await fileRow(item.file.id)
      expect(file).toMatchObject({
        albumId: lp.albumId, releaseId: lp.releaseId, releaseTrackId: lp.tracks[position]!.releaseTrackId, matchStatus: 'matched', matchSource: 'request',
        relPath: `_Fetched/${artistName}/The Coin Shop (2012)/0${position + 1} ${lp.tracks[position]!.title}.flac`,
      })
      expect(await exists(file.relPath)).toBe(true)
      const [delivery] = await db.select().from(imports).where(eq(imports.id, item.importId))
      expect(delivery!.stats).toMatchObject({ filesFiled: 1, filesLeftForReview: 0 })
    }

    // The copies are redirects now, and what pointed at them points at the album.
    for (const id of copies) {
      expect(await albumRow(id)).toMatchObject({ mergedIntoId: lp.albumId })
      expect(await resolveOne('albums', id)).toBe(lp.albumId)
      expect(await db.select().from(albumArtists).where(eq(albumArtists.albumId, id))).toEqual([])
    }
    expect(await db.select().from(releases).where(eq(releases.albumId, lp.albumId))).toHaveLength(1)
    expect(await db.select({ entityId: likes.entityId }).from(likes).where(and(eq(likes.userId, fan.id), eq(likes.entityType, 'album')))).toEqual([{ entityId: lp.albumId }])
    expect(await db.select({ entityId: likes.entityId }).from(likes).where(and(eq(likes.userId, fan.id), eq(likes.entityType, 'recording')))).toEqual([{ entityId: lp.tracks[0]!.recordingId }])
    expect(await db.select({ entityId: wants.entityId }).from(wants).where(eq(wants.userId, fan.id))).toEqual([{ entityId: lp.albumId }])
    expect(await db.select({ albumId: playlistItems.albumId, recordingId: playlistItems.recordingId }).from(playlistItems).where(eq(playlistItems.playlistId, playlistId)))
      .toEqual([{ albumId: lp.albumId, recordingId: lp.tracks[0]!.recordingId }])
    expect(await db.select({ albumId: plays.albumId }).from(plays).where(eq(plays.id, playId))).toEqual([{ albumId: lp.albumId }])
    // Only the album's real artist is left.
    expect(await db.select().from(artists).where(and(eq(artists.nameKey, matchKey(artistName)), isNull(artists.mergedIntoId)))).toHaveLength(1)

    // The single stays a single, with its own track.
    expect(await fileRow(fromSingle.file.id)).toMatchObject({ albumId: single.albumId, releaseTrackId: single.tracks[0]!.releaseTrackId, matchStatus: 'matched' })
    expect(await albumRow(single.albumId)).toMatchObject({ mergedIntoId: null })
    // The owner's own folder is not touched.
    expect(await fileRow(own!.id)).toMatchObject({ albumId: ownBefore.albumId, recordingId: ownBefore.recordingId, releaseTrackId: ownBefore.releaseTrackId, relPath: ownBefore.relPath })
    expect(await albumRow(ownBefore.albumId!)).toMatchObject({ mergedIntoId: null })
    // Nor is the delivery that was another song.
    expect(await fileRow(wrong.file.id)).toMatchObject({ albumId: wrong.file.albumId, recordingId: wrong.file.recordingId, relPath: wrong.file.relPath })
    expect(await albumRow(wrong.file.albumId!)).toMatchObject({ mergedIntoId: null })

    // "Ö": the stub is the album's recording now, at its position, and the song plays.
    expect(await resolveOne('recordings', stub)).toBe(oh.tracks[1]!.recordingId)
    expect(await fileRow(shaken.file.id)).toMatchObject({ albumId: oh.albumId, releaseTrackId: oh.tracks[1]!.releaseTrackId, recordingId: oh.tracks[1]!.recordingId })
    expect(await fileRow(butterflies.file.id)).toMatchObject({ albumId: oh.albumId, releaseTrackId: oh.tracks[0]!.releaseTrackId })
    const ohPage = await albumPage(oh.albumId)
    expect(ohPage).toMatchObject({ trackCount: 2, ownedTrackCount: 2, availability: 'full' })
    expect(ohPage.discs.flatMap((disc) => disc.tracks.map((track) => [track.position, track.title, track.availability])))
      .toEqual([[1, 'Butterflies', 'server'], [2, 'Shake It Up', 'server']])
    expect(await db.select().from(acquisitionJobs).where(eq(acquisitionJobs.id, refused))).toMatchObject([{ status: 'failed' }])

    // "SILK SCARF" went on the album its stub named, and the run-together artist is gone.
    expect(await fileRow(silk.file.id)).toMatchObject({ albumId: hotlife, matchStatus: 'matched' })
    expect(await db.select().from(artists).where(and(eq(artists.id, combined), isNull(artists.mergedIntoId)))).toEqual([])
    expect(await db.select().from(albumArtists).where(eq(albumArtists.artistId, combined))).toEqual([])

    // No review is left for what was placed; the other song's stays.
    const open = await db.select().from(matchReviews).where(eq(matchReviews.status, 'open'))
    expect(open.map((review) => review.groupKey)).toEqual([wrong.file.groupKey])

    // Running it again changes nothing.
    const snapshot = async () => JSON.stringify(await db.execute(sql`
      select f.id, f.album_id, f.recording_id, f.release_track_id, f.rel_path, f.match_status from media_files f order by f.id`))
    const before = await snapshot()
    expect(await repairDeliveries()).toMatchObject({ placed: 0 })
    await drainJobs()
    expect(await snapshot()).toBe(before)
    expect(await db.select().from(releaseTracks).where(eq(releaseTracks.releaseId, lp.releaseId))).toHaveLength(4)
  }, 180_000)
})
