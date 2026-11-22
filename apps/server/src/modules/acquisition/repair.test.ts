import { createReadStream } from 'node:fs'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AlbumDetail, AlbumPage, SearchResults } from '@squirmy/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { acquisitionJobs, acquisitionMisses, albumArtists, albums, artists, externalIds, imports, likes, matchReviews, mediaFiles, playlistItems, playlists, plays, recordingArtists, recordings, releases, releaseTracks, wants } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { body, signIn } from '../../test/api.js'
import { makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { resolveOne } from '../catalog/redirects.js'
import { addImportFile, commitImport, createImport, importsModule, refileImport } from '../imports/index.js'
import { lockCatalog } from '../library/cleanup.js'
import { libraryModule } from '../library/index.js'
import { insertRoot } from '../library/roots.js'
import { scanRoot } from '../library/scan.js'
import { matchingModule, placeFiles } from '../matching/index.js'
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
   * The artist's albums that hold a present file, as their album pages show them. This is
   * where fetched tracks used to show up as one look-alike album each. (Fetched files are
   * cache: they are in no one's library unless the album was saved, so the library lists
   * are no measure of where they went.)
   */
  const albumsWithFiles = async (artistId: string) => {
    const rows = await db.execute<{ id: string }>(sql`
      select distinct f.album_id as id from media_files f
      where f.missing_since is null and f.album_id is not null
        and exists (select 1 from album_artists aa where aa.album_id = f.album_id and aa.artist_id = ${artistId})
      order by f.album_id`)
    const pages = []
    for (const row of rows) pages.push(body(await app.inject({ url: `/api/v1/albums/${row.id}`, headers: fan.headers }), AlbumDetail))
    return pages
  }
  /** The ids of the albums in the user's library: the collection plus their saves. */
  const savedAlbums = async () => body(await app.inject({ url: '/api/v1/library/albums?limit=200', headers: fan.headers }), AlbumPage).items.map((album) => album.id)
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
    await db.insert(likes).values({ userId: fan.id, entityType: 'album', entityId: copies[2]! })
    expect(await savedAlbums()).toContain(copies[2])
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
    expect((await albumsWithFiles(lp.artist.id)).filter((album) => album.title === 'The Coin Shop')).toHaveLength(6)
    expect(await db.select().from(matchReviews).where(eq(matchReviews.status, 'open'))).toHaveLength(8)

    const result = await repairDeliveries()
    await drainJobs()
    expect(result).toMatchObject({ placed: 7 })

    // One album, holding the fetched tracks in its own order, filed where Organize puts it.
    const listed = await albumsWithFiles(lp.artist.id)
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
    // A save of a copy is a save of the album (the album saves were checked above).
    expect(await savedAlbums()).toContain(lp.albumId)
    expect(await savedAlbums()).not.toContain(copies[2])
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

  /** Unmerged artists with this name. */
  const artistsNamed = (name: string) => db.select({ id: artists.id }).from(artists).where(and(eq(artists.nameKey, matchKey(name)), isNull(artists.mergedIntoId)))

  it('puts popular tracks fetched with no album on the album their tags name, and drops the artists their tags ran together', async () => {
    // The live leftovers of 2026-11-22: "SILK SCARF" and "Summer 2000 (Fcukers Remix)" were
    // played from the Fcukers page's popular tracks. Deezer lists those without an album row,
    // so the jobs named no album and the rows had no album hint; the files' album artist tag
    // ran the track's artists together, which made an artist of each combination; and the
    // repair left both files in `_Incoming`, unmatched.
    const tiga = await createArtist({ name: 'Tieega', mbid: crypto.randomUUID() })
    const band = await createArtist({ name: 'Fcookers', mbid: crypto.randomUUID() })
    const girl = await createArtist({ name: 'TV Gurrl', mbid: crypto.randomUUID() })
    const clanton = await createArtist({ name: 'George Clantonn' })
    const hotlife = await identified({
      title: 'Hotlife', artist: tiga, year: 2025,
      tracks: [{ title: 'Party Thyme', durationMs: 2000 }, { title: 'Friktion', durationMs: 2000 }, { title: 'Mind Dimensions', durationMs: 2000 }, { title: 'SILK SCARF', durationMs: 2000 }],
    })
    // The standard edition, which does not have the Japanese edition's bonus remix.
    const faux = await identified({ title: 'Fauxllennium', artist: girl, year: 2016, tracks: [{ title: 'Taking What’s Not Yourz', durationMs: 2000 }, { title: 'Song About Mee', durationMs: 2000 }] })

    // Rows for Deezer's popular tracks: a Deezer id, no album hint, and the other artists'
    // credits pointing at the page's artist, as the live rows do.
    const popular = async (title: string, credits: { artistId: string; name: string }[]) => {
      const id = newId()
      const credit = credits.map((one) => one.name).join(', ')
      await db.insert(recordings).values({
        id, title, artistCredit: credit, primaryArtistId: band.id, durationMs: 2000, titleKey: matchKey(title), matchKey: creditKey(credit, title),
      })
      await db.insert(recordingArtists).values(credits.map((one, position) => ({
        recordingId: id, position, artistId: one.artistId, creditedName: one.name, joinPhrase: position < credits.length - 1 ? ', ' : '',
      })))
      await db.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: `top-${id}`, entityId: id })
      return id
    }
    const scarf = await popular('SILK SCARF', [{ artistId: band.id, name: tiga.name }, { artistId: band.id, name: band.name }])
    const summer = await popular('Summer 2000 (Fcookers Remix)', [{ artistId: band.id, name: girl.name }, { artistId: clanton.id, name: clanton.name }, { artistId: band.id, name: band.name }])
    const silkCredit = `${tiga.name}, ${band.name}`
    const summerCredit = `${girl.name}, ${clanton.name}, ${band.name}`
    const silk = await fetchedTheOldWay(scarf, null, { title: 'SILK SCARF', artist: silkCredit, album: 'HOTLIFE', position: 4, year: 2025 })
    const remix = await fetchedTheOldWay(summer, null, { title: 'Summer 2000 (Fcookers Remix)', artist: summerCredit, album: 'Fauxllennium (Japanese Deluxe Edition)', position: 14, year: 2025 })

    // The broken state: one album and one artist of its own for each, the files in `_Incoming`.
    expect(await artistsNamed(silkCredit)).toHaveLength(1)
    expect(await artistsNamed(summerCredit)).toHaveLength(1)
    expect((await albumPage(silk.copyId)).artists.map((artist) => artist.name)).toEqual([silkCredit])
    expect(silk.file.relPath).toMatch(/^_Incoming\//)

    expect(await repairDeliveries()).toMatchObject({ placed: 2 })
    await drainJobs()

    // "SILK SCARF" is track 4 of the album, as the album's own recording, filed with it.
    expect(await resolveOne('recordings', scarf)).toBe(hotlife.tracks[3]!.recordingId)
    const filed = await fileRow(silk.file.id)
    expect(filed).toMatchObject({
      albumId: hotlife.albumId, releaseTrackId: hotlife.tracks[3]!.releaseTrackId, recordingId: hotlife.tracks[3]!.recordingId, matchStatus: 'matched', matchSource: 'request',
      relPath: `_Fetched/${tiga.name}/Hotlife (2025)/04 SILK SCARF.flac`,
    })
    expect(await exists(filed.relPath)).toBe(true)
    expect(await albumPage(hotlife.albumId)).toMatchObject({ ownedTrackCount: 1, trackCount: 4 })

    // The remix is on the album its tags name ("Japanese Deluxe Edition" is an edition of it),
    // on a track list of its edition beside the standard one, at its own number, and filed.
    const bonus = await fileRow(remix.file.id)
    expect(bonus).toMatchObject({ albumId: faux.albumId, recordingId: summer, matchStatus: 'matched', matchSource: 'request' })
    expect(bonus.releaseId).not.toBe(faux.releaseId)
    expect(await db.select({ position: releaseTracks.position }).from(releaseTracks).where(eq(releaseTracks.id, bonus.releaseTrackId!))).toEqual([{ position: 14 }])
    expect(await albumRow(faux.albumId)).toMatchObject({ canonicalReleaseId: faux.releaseId })
    expect(bonus.relPath).toBe(`_Fetched/${girl.name}/Fauxllennium (2016)/14 Summer 2000 (Fcookers Remix).flac`)
    expect(await exists(bonus.relPath)).toBe(true)

    // The albums their tags made redirect, and the artists made of credits run together are gone.
    expect(await resolveOne('albums', silk.copyId)).toBe(hotlife.albumId)
    expect(await resolveOne('albums', remix.copyId)).toBe(faux.albumId)
    expect(await artistsNamed(silkCredit)).toEqual([])
    expect(await artistsNamed(summerCredit)).toEqual([])
    for (const item of [silk, remix]) {
      expect(await exists(`_Incoming/${item.importId}`)).toBe(false)
      const [delivery] = await db.select().from(imports).where(eq(imports.id, item.importId))
      expect(delivery!.stats).toMatchObject({ filesFiled: 1, filesLeftForReview: 0 })
    }
    expect(await db.select().from(matchReviews).where(and(eq(matchReviews.status, 'open'), sql`${matchReviews.groupKey} in (${silk.file.groupKey}, ${remix.file.groupKey})`))).toEqual([])

    expect(await repairDeliveries()).toMatchObject({ placed: 0 })
  }, 120_000)

  it('moves a track off the search stub it was put on onto its album\'s own row, and merges the stub', async () => {
    // The live "Baggy$$" of 2026-11-22: search showed the EP twice. "UMPA" had been fetched
    // for the Deezer search stub of the EP and put on a track list built from its file there,
    // before the EP's MusicBrainz row had a track list; the stub's Deezer id later moved to
    // that row. The file stayed on the stub, whose page showed one track of one.
    const band = await createArtist({ name: 'Fcukerrs', mbid: crypto.randomUUID() })
    const ep = await identified({
      title: 'Baggy$$', type: 'ep', artist: band, year: 2024,
      tracks: ['Bon Bon', 'Heart Dub', 'Homie Don’t Shake', 'UMPA', 'I Don’t Wanna', 'Tommy'].map((title) => ({ title, durationMs: 2000 })),
    })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: 'baggy', entityId: ep.albumId })
    const stub = newId()
    await db.insert(albums).values({
      id: stub, title: 'Baggy$$', artistCredit: band.name, primaryArtistId: band.id, type: 'ep', detailLevel: 0,
      titleKey: matchKey('Baggy$$'), matchKey: creditKey(band.name, 'Baggy$$'),
    })
    await db.insert(albumArtists).values({ albumId: stub, position: 0, artistId: band.id, creditedName: band.name })

    const umpa = await fetchedTheOldWay(ep.tracks[3]!.recordingId, stub, { title: 'UMPA', artist: band.name, album: 'Baggy$$', position: 4, year: 2024 })
    // Placed on the stub, as placement did while the stub was the only row that could take it.
    await db.transaction(async (tx) => {
      await lockCatalog(tx)
      await placeFiles(tx, { albumId: stub, files: [{ fileId: umpa.file.id, recordingId: ep.tracks[3]!.recordingId }], redirect: true })
    })
    await refileImport(umpa.importId)
    await drainJobs()
    const wanna = await fetchedTheOldWay(ep.tracks[4]!.recordingId, stub, { title: 'I Don’t Wanna', artist: band.name, album: 'Baggy$$', position: 5, year: 2024 })

    const baggy = async () => {
      const found = body(await app.inject({ url: `/api/v1/search/library?q=${encodeURIComponent('baggy$$')}`, headers: fan.headers }), SearchResults)
      return found.albums.filter((album) => album.title === 'Baggy$$' && album.artistCredit === band.name)
    }
    expect(await fileRow(umpa.file.id)).toMatchObject({ albumId: stub, matchStatus: 'matched', matchSource: 'request' })
    expect(await albumPage(stub)).toMatchObject({ trackCount: 1, ownedTrackCount: 1, availability: 'full' })

    await repairDeliveries()
    await drainJobs()

    // One "Baggy$$": the EP, with both tracks at their places and the stub redirecting to it.
    expect(await resolveOne('albums', stub)).toBe(ep.albumId)
    expect(await fileRow(umpa.file.id)).toMatchObject({ albumId: ep.albumId, releaseId: ep.releaseId, releaseTrackId: ep.tracks[3]!.releaseTrackId, matchStatus: 'matched' })
    expect(await fileRow(wanna.file.id)).toMatchObject({ albumId: ep.albumId, releaseTrackId: ep.tracks[4]!.releaseTrackId, matchStatus: 'matched' })
    expect((await baggy()).map((album) => album.id)).toEqual([ep.albumId])
    const page = await albumPage(ep.albumId)
    expect(page).toMatchObject({ trackCount: 6, ownedTrackCount: 2, availability: 'partial' })
    expect(page.discs.flatMap((disc) => disc.tracks.filter((track) => track.availability === 'server').map((track) => track.position))).toEqual([4, 5])
    expect(await db.select().from(releases).where(eq(releases.albumId, ep.albumId))).toHaveLength(1)
    // Filed files are not moved again: it keeps the folder it was filed in under the stub.
    expect((await fileRow(umpa.file.id)).relPath).toBe('_Fetched/Fcukerrs/Baggy$$/04 UMPA.flac')

    expect(await repairDeliveries()).toMatchObject({ placed: 0 })
  }, 120_000)
})
