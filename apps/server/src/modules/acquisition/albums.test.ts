import { access, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMockProvider, type MockProvider, type MockTrack } from '@squirmy/adapter-mock'
import { AcquireResponse, AlbumDetail, AlbumPage, ArtistDetail, MatchReviewList } from '@squirmy/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import {
  acquisitionJobs, acquisitionMisses, albumArtists, albums, artists, externalIds, imports, libraryItems, mediaFiles, recordingArtists, recordings, releases, releaseTracks,
} from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { resolveOne } from '../catalog/redirects.js'
import { importsModule } from '../imports/index.js'
import { libraryModule } from '../library/index.js'
import { insertRoot } from '../library/roots.js'
import { matchingModule } from '../matching/index.js'
import { acquisitionModule } from './index.js'
import { configureAcquisition } from './jobs.js'
import { updateAcquisitionPolicy } from './policy.js'
import { createProvider } from './providers.js'

/**
 * Where fetched music ends up in the library. Tracks are requested the way playback
 * requests them (one job and one import each) from the mock provider, which tags its files
 * like a provider that knows only its own catalog: no MusicBrainz ids, the track artist as
 * album artist, "N/1" track numbers and its own file names. MusicBrainz and the other
 * sources are off, so nothing but the request can say which album a file belongs to.
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

/** Tags and file names like a provider that reads its own catalog, not the request. */
const likeAStore = (track: MockTrack): MockTrack => ({
  ...track, albumArtist: track.artist, total: 1, mbid: null, path: `Release/${track.disc}-${String(track.position).padStart(3, '0')}.flac`,
})

type User = Awaited<ReturnType<typeof signIn>>

describe('acquired tracks and their album', () => {
  useTestDatabase()
  const secret = 'albums-provider-secret'
  let app: FastifyInstance
  let mock: MockProvider
  let providerId = ''
  let rootId = ''
  let rootDir = ''
  let fan: User
  let admin: User

  beforeAll(async () => {
    await updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: false, coverArtArchiveEnabled: false, wikidataEnabled: false, lrclibEnabled: false })
    app = await buildApp()
    await app.listen({ host: '127.0.0.1', port: 0 })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    for (const module of [libraryModule, matchingModule, importsModule, acquisitionModule]) await module.jobs!(jobs)
    await startJobs({ work: true })
    configureAcquisition({ pollMs: 50 })

    rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-fetched-')))
    const root = await insertRoot({ name: 'Fetched', path: rootDir, mode: 'managed', watch: false })
    rootId = root.id
    await updateServerSettings({ importRootId: root.id })
    await updateAcquisitionPolicy({ deliveryBaseUrl: url })

    mock = createMockProvider({ secret, onError: () => {} })
    providerId = (await createProvider({ name: 'Mock', baseUrl: await mock.listen(), secret, enabled: true, priority: 0 })).id
    fan = await signIn({ canAcquire: true })
    admin = await signIn({ role: 'admin' })
  }, 60_000)

  beforeEach(() => {
    Object.assign(mock.settings, { delayMs: 0, fail: false, wrongFile: false, priced: false, retag: likeAStore, kinds: ['recording', 'album'], busyTimes: 0, has: () => true })
  })
  afterAll(async () => {
    await acquisitionModule.stop!()
    await stopJobs()
    await mock.close()
    await app.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  const jobsFor = (recordingId: string) => db.select().from(acquisitionJobs).where(sql`${acquisitionJobs.recordingIds} @> array[${recordingId}]::uuid[]`).orderBy(acquisitionJobs.id)
  const settle = async (recordingId: string) => {
    await eventually(async () => expect((await jobsFor(recordingId)).every((job) => job.completedAt !== null)).toBe(true))
    await drainJobs()
  }
  /** Requests one track as playback does, and waits for its job and everything it queued. */
  async function fetchTrack(recordingId: string, albumId?: string) {
    const response = await app.inject({ method: 'POST', url: `/api/v1/tracks/${recordingId}/acquire${albumId ? `?albumId=${albumId}` : ''}`, headers: fan.headers })
    body(response, AcquireResponse, 202)
    await settle(recordingId)
    const job = (await jobsFor(recordingId)).at(-1)!
    return job
  }
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
  const filesOf = (recordingId: string) => db.select().from(mediaFiles).where(and(eq(mediaFiles.recordingId, recordingId), isNull(mediaFiles.missingSince)))
  const albumsNamed = (title: string, artistName: string) => db.select().from(albums).where(and(eq(albums.matchKey, creditKey(artistName, title)), isNull(albums.mergedIntoId)))
  const exists = (relPath: string) => access(path.join(rootDir, relPath)).then(() => true, () => false)
  const incoming = () => readdir(path.join(rootDir, '_Incoming')).catch(() => [] as string[])

  /** A stub album as a catalog search leaves it: no releases, an external id, tracks that only hint at it. */
  async function createStubAlbum(input: { title: string; artist: { id: string; name: string }; tracks: { title: string; durationMs: number; isrc?: string }[] }) {
    const albumId = newId()
    await db.insert(albums).values({
      id: albumId, title: input.title, artistCredit: input.artist.name, primaryArtistId: input.artist.id, type: 'album',
      titleKey: matchKey(input.title), matchKey: creditKey(input.artist.name, input.title), detailLevel: 0,
    })
    await db.insert(albumArtists).values({ albumId, position: 0, artistId: input.artist.id, creditedName: input.artist.name })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: `stub-${albumId}`, entityId: albumId })
    const tracks = []
    for (const track of input.tracks) {
      const id = newId()
      await db.insert(recordings).values({
        id, title: track.title, artistCredit: input.artist.name, primaryArtistId: input.artist.id, durationMs: track.durationMs,
        isrcs: track.isrc ? [track.isrc] : [], titleKey: matchKey(track.title), matchKey: creditKey(input.artist.name, track.title), albumHintId: albumId,
      })
      await db.insert(recordingArtists).values({ recordingId: id, position: 0, artistId: input.artist.id, creditedName: input.artist.name })
      await db.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: `stub-${id}`, entityId: id })
      tracks.push({ recordingId: id, ...track })
    }
    return { albumId, tracks }
  }

  /** Makes a factory album look like one fetched from MusicBrainz: ids on the group, the release and every recording. */
  async function identified(input: Parameters<typeof createAlbum>[0]) {
    const album = await createAlbum({ mbid: crypto.randomUUID(), ...input, tracks: input!.tracks!.map((track) => ({ mbid: crypto.randomUUID(), ...track })) })
    await db.update(releases).set({ mbid: crypto.randomUUID(), fetchedAt: new Date(), status: 'official' }).where(eq(releases.id, album.releaseId))
    return album
  }

  it('files tracks fetched one at a time on the album they were requested from, in its track order', async () => {
    const album = await identified({
      title: 'The Coin Shop', year: 2012,
      tracks: [{ title: 'Got Given', durationMs: 3000 }, { title: 'The Chill', durationMs: 2000 }, { title: 'Found Girls', durationMs: 4000 }, { title: 'Whitejack', durationMs: 3000 }],
    })
    const [first, second, third] = album.tracks.map((track) => track.recordingId) as [string, string, string]

    // Out of order, as someone picking songs would.
    const jobs = [await fetchTrack(third, album.albumId), await fetchTrack(first, album.albumId), await fetchTrack(second, album.albumId)]
    for (const job of jobs) expect(job).toMatchObject({ status: 'completed', error: null })

    const listed = await albumsWithFiles(album.artist.id)
    expect(listed.map((item) => ({ id: item.id, title: item.title }))).toEqual([{ id: album.albumId, title: 'The Coin Shop' }])
    expect(listed[0]).toMatchObject({ availability: 'partial', trackCount: 4, ownedTrackCount: 3, mbid: expect.any(String) })
    expect(await albumsNamed('The Coin Shop', album.artist.name)).toHaveLength(1)

    const page = await albumPage(album.albumId)
    expect(page.discs).toHaveLength(1)
    expect(page.discs[0]!.tracks.map((track) => [track.position, track.title, track.availability, track.id])).toEqual([
      [1, 'Got Given', 'server', first], [2, 'The Chill', 'server', second], [3, 'Found Girls', 'server', third], [4, 'Whitejack', 'on_demand', album.tracks[3]!.recordingId],
    ])

    for (const [index, recordingId] of [first, second, third].entries()) {
      const files = await filesOf(recordingId)
      expect(files).toHaveLength(1)
      const track = album.tracks[index]!
      expect(files[0]).toMatchObject({
        albumId: album.albumId, releaseId: album.releaseId, releaseTrackId: track.releaseTrackId, matchStatus: 'matched', matchSource: 'request',
        source: `provider:${providerId}`, relPath: `_Fetched/${album.artist.name}/The Coin Shop (2012)/0${index + 1} ${track.title}.flac`,
      })
      expect(await exists(files[0]!.relPath)).toBe(true)
    }
    // Nothing waits in the import folder, and the imports say so.
    expect(await incoming()).toEqual([])
    for (const job of jobs) {
      const [delivered] = await db.select().from(imports).where(eq(imports.id, job.importId!))
      expect(delivered!.stats).toMatchObject({ filesFiled: 1, filesLeftForReview: 0, albumsFiled: 1 })
    }
    // No artist row was made for the album artist the files named.
    expect(await db.select().from(artists).where(and(eq(artists.nameKey, matchKey(album.artist.name)), isNull(artists.mergedIntoId)))).toHaveLength(1)
    const artist = body(await app.inject({ url: `/api/v1/artists/${album.artist.id}`, headers: fan.headers }), ArtistDetail)
    expect(artist.albums.map((item) => item.id)).toEqual([album.albumId])
    // Tracks fetched by playing them are cache, not saves.
    expect(await savedAlbums()).not.toContain(album.albumId)
  })

  it('puts two tracks of one album fetched at the same time on that album', async () => {
    // Playback asks for the current entry and the next ones at once.
    for (const tags of [likeAStore, (track: MockTrack) => track]) {
      mock.settings.retag = tags
      const album = await createAlbum({ title: `Side By Side ${newId()}`, tracks: [{ title: 'Left', durationMs: 3000 }, { title: 'Right', durationMs: 2000 }, { title: 'Middle', durationMs: 2000 }] })
      const ids = album.tracks.slice(0, 2).map((track) => track.recordingId)
      mock.settings.delayMs = 200
      await Promise.all(ids.map(async (id) => body(await app.inject({ method: 'POST', url: `/api/v1/tracks/${id}/acquire?albumId=${album.albumId}`, headers: fan.headers }), AcquireResponse, 202)))
      for (const id of ids) await settle(id)
      for (const id of ids) expect((await jobsFor(id)).at(-1)).toMatchObject({ status: 'completed', error: null })
      expect((await albumsWithFiles(album.artist.id)).map((item) => [item.id, item.trackCount, item.ownedTrackCount])).toEqual([[album.albumId, 3, 2]])
      for (const [index, id] of ids.entries()) {
        expect((await filesOf(id))[0]).toMatchObject({ albumId: album.albumId, releaseTrackId: album.tracks[index]!.releaseTrackId, matchStatus: 'matched' })
      }
    }
  })

  it('keeps a delivery tagged as another edition on the album that was asked for', async () => {
    const album = await identified({ title: 'Plain Title', year: 1997, tracks: [{ title: 'Opening Song', durationMs: 3000 }, { title: 'Second Song', durationMs: 2000 }] })
    mock.settings.retag = (track) => ({ ...likeAStore(track), album: 'Plain Title (Deluxe Edition)', year: 2017, position: track.position + 20, title: `${track.title} (2017 Remaster)` })
    const wanted = album.tracks[1]!
    expect(await fetchTrack(wanted.recordingId, album.albumId)).toMatchObject({ status: 'completed', error: null })

    expect((await albumsWithFiles(album.artist.id)).map((item) => [item.id, item.title, item.year])).toEqual([[album.albumId, 'Plain Title', 1997]])
    expect(await albumsNamed('Plain Title (Deluxe Edition)', album.artist.name)).toEqual([])
    const [file] = await filesOf(wanted.recordingId)
    expect(file).toMatchObject({ albumId: album.albumId, releaseTrackId: wanted.releaseTrackId, relPath: `_Fetched/${album.artist.name}/Plain Title (1997)/02 Second Song.flac` })
    const page = await albumPage(album.albumId)
    expect(page.discs[0]!.tracks.map((track) => [track.position, track.title, track.availability])).toEqual([[1, 'Opening Song', 'on_demand'], [2, 'Second Song', 'server']])
  })

  it('builds one track list on a stub album that has none, from the files as they arrive', async () => {
    const artist = await createArtist()
    const stub = await createStubAlbum({ title: 'Only Searched', artist, tracks: [{ title: 'Third In Line', durationMs: 3000 }, { title: 'First In Line', durationMs: 2000 }] })
    const positions = new Map([['Third In Line', 3], ['First In Line', 1]])
    mock.settings.retag = (track) => likeAStore({ ...track, position: positions.get(track.title)!, year: 2020 })
    for (const track of stub.tracks) expect(await fetchTrack(track.recordingId, stub.albumId)).toMatchObject({ status: 'completed', error: null })

    const listed = await albumsWithFiles(artist.id)
    expect(listed.map((item) => item.id)).toEqual([stub.albumId])
    expect(listed[0]).toMatchObject({ availability: 'full', trackCount: 2, ownedTrackCount: 2 })
    expect(await albumsNamed('Only Searched', artist.name)).toHaveLength(1)
    const page = await albumPage(stub.albumId)
    expect(page.discs[0]!.tracks.map((track) => [track.position, track.title, track.id])).toEqual([[1, 'First In Line', stub.tracks[1]!.recordingId], [3, 'Third In Line', stub.tracks[0]!.recordingId]])
    const files = await db.select().from(mediaFiles).where(eq(mediaFiles.albumId, stub.albumId))
    expect(new Set(files.map((file) => file.releaseId)).size).toBe(1)
    expect(files.map((file) => file.relPath).sort()).toEqual([`_Fetched/${artist.name}/Only Searched/01 First In Line.flac`, `_Fetched/${artist.name}/Only Searched/03 Third In Line.flac`])
    expect(await incoming()).toEqual([])
  })

  it('uses the track list a stub album got from its source', async () => {
    const artist = await createArtist()
    const stub = await createStubAlbum({ title: 'Listed Elsewhere', artist, tracks: [{ title: 'Side A', durationMs: 2000 }, { title: 'Side B', durationMs: 3000 }] })
    // What album detail writes for an album MusicBrainz does not know: a provider-only release.
    const releaseId = newId()
    await db.insert(releases).values({ id: releaseId, albumId: stub.albumId, title: 'Listed Elsewhere', trackCount: 2, detailLevel: 1, fetchedAt: new Date(), format: 'Digital Media' })
    const trackIds = [newId(), newId()]
    for (const [index, track] of stub.tracks.entries()) {
      await db.insert(releaseTracks).values({ id: trackIds[index]!, releaseId, disc: 1, position: index + 1, recordingId: track.recordingId, title: track.title, durationMs: track.durationMs })
    }
    await db.update(albums).set({ canonicalReleaseId: releaseId, detailLevel: 1, fetchedAt: new Date() }).where(eq(albums.id, stub.albumId))

    expect(await fetchTrack(stub.tracks[1]!.recordingId, stub.albumId)).toMatchObject({ status: 'completed', error: null })
    const [file] = await filesOf(stub.tracks[1]!.recordingId)
    expect(file).toMatchObject({ albumId: stub.albumId, releaseId, releaseTrackId: trackIds[1], matchStatus: 'matched', relPath: `_Fetched/${artist.name}/Listed Elsewhere/02 Side B.flac` })
    expect((await albumsWithFiles(artist.id)).map((item) => [item.id, item.availability, item.trackCount, item.ownedTrackCount])).toEqual([[stub.albumId, 'partial', 2, 1]])
    expect(await db.select().from(releases).where(eq(releases.albumId, stub.albumId))).toHaveLength(1)
  })

  it('finds the album itself when a track is requested without one', async () => {
    const album = await identified({ title: 'No Context', year: 2001, tracks: [{ title: 'Asked Alone', durationMs: 3000 }, { title: 'Never Asked', durationMs: 2000 }] })
    expect(await fetchTrack(album.tracks[0]!.recordingId)).toMatchObject({ status: 'completed', error: null, albumId: null })
    expect((await albumsWithFiles(album.artist.id)).map((item) => item.id)).toEqual([album.albumId])
    expect((await filesOf(album.tracks[0]!.recordingId))[0]).toMatchObject({ albumId: album.albumId, releaseTrackId: album.tracks[0]!.releaseTrackId, relPath: `_Fetched/${album.artist.name}/No Context (2001)/01 Asked Alone.flac` })

    // A search stub knows its album only as a hint.
    const artist = await createArtist()
    const stub = await createStubAlbum({ title: 'Hinted At', artist, tracks: [{ title: 'From A Search', durationMs: 2000 }] })
    expect(await fetchTrack(stub.tracks[0]!.recordingId)).toMatchObject({ status: 'completed', error: null })
    expect((await albumsWithFiles(artist.id)).map((item) => item.id)).toEqual([stub.albumId])
    expect(await albumsNamed('Hinted At', artist.name)).toHaveLength(1)
  })

  it('asks for an album without the tracks the server has, and gets only those', async () => {
    const album = await identified({ title: 'Half Owned', year: 2016, tracks: [{ title: 'Had It', durationMs: 2000 }, { title: 'Need It', durationMs: 2000 }, { title: 'Need It Too', durationMs: 2000 }] })
    expect(await fetchTrack(album.tracks[0]!.recordingId, album.albumId)).toMatchObject({ status: 'completed' })
    const asked = mock.resolved.length
    body(await app.inject({ method: 'POST', url: `/api/v1/albums/${album.albumId}/acquire`, headers: fan.headers }), AcquireResponse, 202)
    await settle(album.tracks[1]!.recordingId)
    const [job] = await jobsFor(album.tracks[1]!.recordingId)
    expect(job).toMatchObject({ status: 'completed', error: null, recordingIds: [album.tracks[1]!.recordingId, album.tracks[2]!.recordingId] })

    // The whole track list goes out, so the edition can be told apart, with the owned track not wanted.
    const item = mock.resolved.slice(asked).find((candidate) => candidate.kind === 'album')
    expect(item?.kind === 'album' && item.album.tracks.map((track) => [track.title, track.wanted ?? true])).toEqual([['Had It', false], ['Need It', true], ['Need It Too', true]])
    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.importId, job!.importId!))).toHaveLength(2)
    expect(await filesOf(album.tracks[0]!.recordingId)).toHaveLength(1)
    expect((await albumsWithFiles(album.artist.id)).map((item) => [item.id, item.availability, item.ownedTrackCount])).toEqual([[album.albumId, 'full', 3]])
    expect(await savedAlbums()).toContain(album.albumId)
  })

  it('adds an album to the library only when it is asked for from the library', async () => {
    const acquireAlbum = (albumId: string, origin?: 'library' | 'download') =>
      app.inject({ method: 'POST', url: `/api/v1/albums/${albumId}/acquire${origin ? `?origin=${origin}` : ''}`, headers: fan.headers })
    const saved = async (albumId: string) => (await db.select().from(libraryItems)
      .where(and(eq(libraryItems.userId, fan.id), eq(libraryItems.entityType, 'album'), eq(libraryItems.entityId, albumId)))).length > 0

    // A device downloading the album only fetches it.
    const downloaded = await identified({ title: 'For The Road', year: 2014, tracks: [{ title: 'Mile One', durationMs: 2000 }, { title: 'Mile Two', durationMs: 2000 }] })
    body(await acquireAlbum(downloaded.albumId, 'download'), AcquireResponse, 202)
    await settle(downloaded.tracks[0]!.recordingId)
    expect((await albumPage(downloaded.albumId)).ownedTrackCount).toBe(2)
    expect(await saved(downloaded.albumId)).toBe(false)
    expect(await savedAlbums()).not.toContain(downloaded.albumId)
    // Asking again, now that the server has it all, still adds nothing.
    expect(errorCode(await acquireAlbum(downloaded.albumId, 'download'), 409)).toBe('already_available')
    expect(await saved(downloaded.albumId)).toBe(false)

    // The library action adds it, even when there is nothing left to fetch.
    expect(errorCode(await acquireAlbum(downloaded.albumId, 'library'), 409)).toBe('already_available')
    expect(await saved(downloaded.albumId)).toBe(true)
    expect(await savedAlbums()).toContain(downloaded.albumId)

    const added = await identified({ title: 'Kept Close', year: 2015, tracks: [{ title: 'Held', durationMs: 2000 }] })
    body(await acquireAlbum(added.albumId, 'library'), AcquireResponse, 202)
    expect(await saved(added.albumId)).toBe(true)
    await settle(added.tracks[0]!.recordingId)

    // Tracks fetched to play them (or ahead of playing them) are never saved, nor is their album.
    const played = await identified({ title: 'Only Played', year: 2016, tracks: [{ title: 'Heard Once', durationMs: 2000 }, { title: 'Not Yet', durationMs: 2000 }] })
    expect(await fetchTrack(played.tracks[0]!.recordingId, played.albumId)).toMatchObject({ status: 'completed' })
    expect(await saved(played.albumId)).toBe(false)
    expect(await db.select().from(libraryItems).where(and(eq(libraryItems.userId, fan.id), eq(libraryItems.entityId, played.tracks[0]!.recordingId)))).toEqual([])
  })

  it('fetches an album track by track when no provider will fetch it whole', async () => {
    const album = await identified({ title: 'Not Whole', year: 2003, tracks: [{ title: 'Piece One', durationMs: 2000 }, { title: 'Piece Two', durationMs: 2000 }] })
    mock.settings.has = (item) => item.kind !== 'album'
    body(await app.inject({ method: 'POST', url: `/api/v1/albums/${album.albumId}/acquire`, headers: fan.headers }), AcquireResponse, 202)
    for (const track of album.tracks) {
      await eventually(async () => expect((await jobsFor(track.recordingId)).some((job) => job.recordingId === track.recordingId)).toBe(true))
      await settle(track.recordingId)
    }
    const [whole] = await db.select().from(acquisitionJobs).where(and(eq(acquisitionJobs.albumId, album.albumId), isNull(acquisitionJobs.recordingId)))
    expect(whole).toMatchObject({ status: 'failed' })
    expect(whole!.error).toMatch(/one at a time/)
    for (const [index, track] of album.tracks.entries()) {
      expect((await jobsFor(track.recordingId)).at(-1)).toMatchObject({ status: 'completed', recordingId: track.recordingId, albumId: album.albumId })
      expect((await filesOf(track.recordingId))[0]).toMatchObject({ albumId: album.albumId, releaseTrackId: album.tracks[index]!.releaseTrackId })
    }
    expect(await db.select().from(acquisitionMisses).where(eq(acquisitionMisses.providerId, providerId))).toEqual([])
    expect((await albumsWithFiles(album.artist.id)).map((item) => [item.id, item.availability])).toEqual([[album.albumId, 'full']])
    expect(await savedAlbums()).toContain(album.albumId)
  })

  // Longer than the default: a retry woken while its worker is busy waits for pg-boss's 30 second poll.
  it('waits for a busy provider instead of graying the track out, and never sends it more jobs than it takes', async () => {
    const album = await identified({ title: 'Busy Night', year: 2008, tracks: Array.from({ length: 3 }, (_, index) => ({ title: `Rush ${index + 1}`, durationMs: 1000 })) })
    configureAcquisition({ slotWaitSeconds: 1 })
    try {
      mock.settings.busyTimes = 2
      const first = album.tracks[0]!.recordingId
      expect(await fetchTrack(first, album.albumId)).toMatchObject({ status: 'completed', error: null })
      expect(mock.settings.busyTimes).toBe(0)
      expect(await db.select().from(acquisitionMisses).where(eq(acquisitionMisses.entityId, first))).toEqual([])

      // Playback asks for the current entry and the next ones at the same time, more than
      // the provider takes at once. Two against a provider that takes one: each running import
      // holds a connection of the test database's four, and filing reserves one more for its
      // root lock, so three imports filing at once would leave none for their queries.
      mock.settings.delayMs = 400
      mock.settings.maxConcurrent = 1
      expect((await app.inject({ method: 'POST', url: `/api/v1/admin/acquisition/providers/${providerId}/test`, headers: admin.headers })).statusCode).toBe(200)
      const rest = album.tracks.slice(1, 3).map((track) => track.recordingId)
      let peak = 0
      const watch = setInterval(() => {
        void db.select({ count: sql<number>`count(*)::int` }).from(acquisitionJobs)
          .where(and(eq(acquisitionJobs.providerId, providerId), sql`${acquisitionJobs.status} in ('queued', 'downloading')`))
          .then(([row]) => { peak = Math.max(peak, row!.count) }).catch(() => {})
      }, 20)
      await Promise.all(rest.map(async (id) => body(await app.inject({ method: 'POST', url: `/api/v1/tracks/${id}/acquire?albumId=${album.albumId}`, headers: fan.headers }), AcquireResponse, 202)))
      for (const id of rest) await settle(id)
      clearInterval(watch)
      for (const id of rest) expect((await jobsFor(id)).at(-1)).toMatchObject({ status: 'completed', error: null })
      expect(peak).toBeGreaterThan(0)
      expect(peak).toBe(1)
      expect((await albumsWithFiles(album.artist.id)).map((item) => [item.id, item.ownedTrackCount])).toEqual([[album.albumId, 3]])
    } finally {
      configureAcquisition({ slotWaitSeconds: 5 })
      mock.settings.maxConcurrent = 4
      await app.inject({ method: 'POST', url: `/api/v1/admin/acquisition/providers/${providerId}/test`, headers: admin.headers })
    }
  }, 90_000)

  it('puts a whole album fetched in one job on the album, whatever its files call it', async () => {
    const album = await identified({ title: 'All At Once', year: 2015, tracks: [{ title: 'Part One', durationMs: 2000 }, { title: 'Part Two', durationMs: 3000 }, { title: 'Part Three', durationMs: 2000 }] })
    mock.settings.retag = (track) => ({ ...likeAStore(track), album: 'All At Once (Expanded Edition)' })
    const response = body(await app.inject({ method: 'POST', url: `/api/v1/albums/${album.albumId}/acquire`, headers: fan.headers }), AcquireResponse, 202)
    expect(response.items).toHaveLength(1)
    await settle(album.tracks[0]!.recordingId)
    expect((await jobsFor(album.tracks[0]!.recordingId))[0]).toMatchObject({ status: 'completed', error: null, recordingId: null })

    const listed = await albumsWithFiles(album.artist.id)
    expect(listed.map((item) => [item.id, item.availability, item.trackCount, item.ownedTrackCount])).toEqual([[album.albumId, 'full', 3, 3]])
    expect(await albumsNamed('All At Once (Expanded Edition)', album.artist.name)).toEqual([])
    // Asking for the whole album saves it to the asker's library.
    expect(await savedAlbums()).toContain(album.albumId)
    expect(await db.select().from(libraryItems).where(and(eq(libraryItems.userId, fan.id), eq(libraryItems.entityId, album.albumId)))).toMatchObject([{ entityType: 'album' }])
    const files = await db.select().from(mediaFiles).where(eq(mediaFiles.albumId, album.albumId))
    expect(files.map((file) => file.relPath).sort()).toEqual(['01 Part One', '02 Part Two', '03 Part Three'].map((name) => `_Fetched/${album.artist.name}/All At Once (2015)/${name}.flac`))
    expect(files.every((file) => file.matchStatus === 'matched' && file.releaseTrackId !== null)).toBe(true)
    expect(await incoming()).toEqual([])
  })

  it('answers a second request for a track it has, and takes a second delivery of the same audio as the track it already is', async () => {
    const album = await identified({ title: 'Asked Twice', year: 2019, tracks: [{ title: 'Same Song', durationMs: 3000 }, { title: 'Other Song', durationMs: 2000 }] })
    const wanted = album.tracks[0]!.recordingId
    await fetchTrack(wanted, album.albumId)
    expect(errorCode(await app.inject({ method: 'POST', url: `/api/v1/tracks/${wanted}/acquire?albumId=${album.albumId}`, headers: fan.headers }), 409)).toBe('already_available')

    // The same song under a row of its own, as a search leaves it next to the album's recording.
    const twin = newId()
    await db.insert(recordings).values({
      id: twin, title: 'Same Song', artistCredit: album.artist.name, primaryArtistId: album.artist.id, durationMs: 3000,
      titleKey: matchKey('Same Song'), matchKey: creditKey(album.artist.name, 'Same Song'),
    })
    await db.insert(recordingArtists).values({ recordingId: twin, position: 0, artistId: album.artist.id, creditedName: album.artist.name })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: `twin-${twin}`, entityId: twin })
    const job = await fetchTrack(twin, album.albumId)
    expect(job).toMatchObject({ status: 'completed', error: null })
    const [delivered] = await db.select().from(imports).where(eq(imports.id, job.importId!))
    expect(delivered!.stats).toMatchObject({ duplicatesSkipped: 1 })

    expect(await resolveOne('recordings', twin)).toBe(wanted)
    expect(await db.select().from(acquisitionMisses).where(eq(acquisitionMisses.entityId, twin))).toEqual([])
    expect(await filesOf(wanted)).toHaveLength(1)
    expect((await albumsWithFiles(album.artist.id)).map((item) => [item.id, item.trackCount, item.ownedTrackCount])).toEqual([[album.albumId, 2, 1]])
    const page = await albumPage(album.albumId)
    expect(page.discs[0]!.tracks.map((track) => [track.position, track.title, track.availability])).toEqual([[1, 'Same Song', 'server'], [2, 'Other Song', 'on_demand']])
  })

  it('merges a requested search stub into the recording the album already lists', async () => {
    const album = await identified({ title: 'Listed Twice', year: 2022, tracks: [{ title: 'Before', durationMs: 2000 }, { title: 'Shaken Up', durationMs: 3000 }] })
    const listed = album.tracks[1]!
    const stub = newId()
    await db.insert(recordings).values({
      id: stub, title: 'Shaken Up', artistCredit: album.artist.name, primaryArtistId: album.artist.id, durationMs: 3400,
      titleKey: matchKey('Shaken Up'), matchKey: creditKey(album.artist.name, 'Shaken Up'), albumHintId: album.albumId,
    })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: `stub-${stub}`, entityId: stub })

    expect(await fetchTrack(stub, album.albumId)).toMatchObject({ status: 'completed', error: null })
    expect(await resolveOne('recordings', stub)).toBe(listed.recordingId)
    expect((await filesOf(listed.recordingId))[0]).toMatchObject({ albumId: album.albumId, releaseTrackId: listed.releaseTrackId, matchStatus: 'matched' })
    const page = await albumPage(album.albumId)
    expect(page.discs[0]!.tracks.map((track) => [track.position, track.title, track.availability])).toEqual([[1, 'Before', 'on_demand'], [2, 'Shaken Up', 'server']])
  })

  it('merges a requested stub into the album\'s recording when the delivery carries their shared ISRC', async () => {
    const album = await identified({ title: 'Coded', year: 2021, tracks: [{ title: 'Known Song', durationMs: 2000 }, { title: 'Coded Song', durationMs: 2000 }] })
    const listed = album.tracks[1]!
    await db.update(recordings).set({ isrcs: ['GBXXX2100001'] }).where(eq(recordings.id, listed.recordingId))
    // A search stub with another title for the same recording, and no length to go by.
    const stub = newId()
    await db.insert(recordings).values({
      id: stub, title: 'Coded Song (Album Version)', artistCredit: album.artist.name, primaryArtistId: album.artist.id, durationMs: 9000, isrcs: ['GBXXX2100001'],
      titleKey: matchKey('Coded Song (Album Version)'), matchKey: creditKey(album.artist.name, 'Coded Song (Album Version)'), albumHintId: album.albumId,
    })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: `isrc-${stub}`, entityId: stub })
    mock.settings.retag = (track) => ({ ...likeAStore(track), durationMs: 2000 })
    expect(await fetchTrack(stub, album.albumId)).toMatchObject({ status: 'completed', error: null })
    expect(await resolveOne('recordings', stub)).toBe(listed.recordingId)
    expect((await filesOf(listed.recordingId))[0]).toMatchObject({ albumId: album.albumId, releaseTrackId: listed.releaseTrackId })
  })

  it('keeps a live take apart from the album\'s recording of the same name and length', async () => {
    const album = await identified({ title: 'Studio Only', year: 2019, tracks: [{ title: 'Intro', durationMs: 2000 }, { title: 'Outro', durationMs: 2000 }] })
    const studio = album.tracks[0]!
    await db.update(recordings).set({ isrcs: ['GBSTU1900001'] }).where(eq(recordings.id, studio.recordingId))
    const live = newId()
    await db.insert(recordings).values({
      id: live, title: 'Intro', artistCredit: album.artist.name, primaryArtistId: album.artist.id, durationMs: 2000, isrcs: ['GBLIV1900009'],
      titleKey: matchKey('Intro'), matchKey: creditKey(album.artist.name, 'Intro'), albumHintId: album.albumId,
    })
    await db.insert(recordingArtists).values({ recordingId: live, position: 0, artistId: album.artist.id, creditedName: album.artist.name })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: `live-${live}`, entityId: live })
    expect(await fetchTrack(live, album.albumId)).toMatchObject({ status: 'completed', error: null })
    expect(await resolveOne('recordings', live)).toBe(live)
    expect(await resolveOne('recordings', studio.recordingId)).toBe(studio.recordingId)
    expect(await filesOf(studio.recordingId)).toEqual([])
    expect((await filesOf(live))[0]).toMatchObject({ albumId: album.albumId, releaseTrackId: null })
    expect((await albumPage(album.albumId)).discs[0]!.tracks.find((track) => track.id === studio.recordingId)?.availability).not.toBe('server')
  })

  it('still refuses a delivery that is another song, and deletes it instead of keeping it apart', async () => {
    const album = await identified({ title: 'Not This', year: 2010, tracks: [{ title: 'The Right One', durationMs: 3000 }, { title: 'Another', durationMs: 2000 }] })
    const wanted = album.tracks[0]!.recordingId
    mock.settings.wrongFile = true
    const job = await fetchTrack(wanted, album.albumId)
    expect(job.status).toBe('failed')

    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.importId, job.importId!))).toEqual([])
    expect(await incoming()).not.toContain(job.importId)
    expect(await filesOf(wanted)).toEqual([])
    expect(await db.select().from(acquisitionMisses).where(and(eq(acquisitionMisses.providerId, providerId), eq(acquisitionMisses.entityId, wanted)))).toHaveLength(1)
    expect((await albumPage(album.albumId)).ownedTrackCount).toBe(0)
  })

  it('leaves no review behind for a delivery it placed', async () => {
    const reviews = body(await app.inject({ url: '/api/v1/admin/reviews?status=open&limit=200', headers: admin.headers }), MatchReviewList)
    expect(reviews.items.filter((review) => review.rootId === rootId && !String(review.summary.album).includes('Not This'))).toEqual([])
  })
})
