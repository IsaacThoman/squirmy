import { AlbumDetail, Ok, PlaybackDescriptor, PublicShare, ShareLink, ShareTrackPlayback, TrackVersions, type AudioTier } from '@squirmy/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, mediaFiles, recordings, releases, releaseTracks, versionPicks } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { createFile } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot } from '../../test/factories.js'
import { ingestAlbum, type DemoAlbum } from '../../test/matching.js'
import { applyMatch } from '../matching/apply.js'
import { mergeAlbum } from '../matching/merge.js'
import type { Evaluation } from '../matching/score.js'
import type { MbRelease } from '../metadata/musicbrainz.js'
import { openStreamKey } from '../share/playback.js'
import { songs } from '../subsonic/songs.js'
import { exportPlaylist } from '../userdata/playlist-files.js'
import { createPlaylist } from '../userdata/playlists.js'
import { albumVersions } from './versions.js'

vi.mock('../enrichment/detail.js', () => ({
  ensureAlbumDetail: vi.fn(async () => true),
  ensureArtistDetail: vi.fn(async () => true),
  ensureLyrics: vi.fn(async () => {}),
}))

const mbid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const floyd = { name: 'Pink Floyd', mbid: mbid(1), joinPhrase: '' }
const songsOf = [
  { title: 'Speak to Me', durationMs: 68_000 },
  { title: 'Breathe', durationMs: 169_000 },
  { title: 'On the Run', durationMs: 216_000 },
]
const dsotm: DemoAlbum = { artist: 'Pink Floyd', album: 'The Dark Side of the Moon', year: 1973, tracks: songsOf }

type Edition = { release: number; date: string; country: string; label: string; catalogNumber: string; format: string; disambiguation?: string; recordings: number[] }

/** A MusicBrainz release of one group, as `musicbrainz.getRelease` returns it. */
function release(group: number, title: string, edition: Edition): MbRelease {
  return {
    mbid: mbid(edition.release), title, status: 'official', date: edition.date, year: Number(edition.date.slice(0, 4)),
    country: edition.country, barcode: null, disambiguation: edition.disambiguation ?? '',
    artistCredit: [floyd], artistName: floyd.name,
    media: [{ format: edition.format, trackCount: songsOf.length }], trackCount: songsOf.length,
    labels: [{ name: edition.label, mbid: null, catalogNumber: edition.catalogNumber }],
    releaseGroup: {
      mbid: mbid(group), title, type: 'album', primaryType: 'Album', secondaryTypes: [], disambiguation: '',
      artistCredit: [floyd], artistName: floyd.name, date: '1973-03-01', year: 1973,
    },
    urls: [],
    mediums: [{
      position: 1, format: edition.format, title: '',
      tracks: songsOf.map((song, index) => ({
        mbid: newId(), position: index + 1, number: String(index + 1), title: song.title, durationMs: song.durationMs,
        artistCredit: [floyd], artistName: floyd.name,
        recording: {
          mbid: mbid(edition.recordings[index]!), title: song.title, durationMs: song.durationMs, disambiguation: '', video: false,
          artistCredit: [floyd], artistName: floyd.name, isrcs: [],
        },
      })),
    }],
  }
}

const vinyl: Edition = { release: 101, date: '1973-03-01', country: 'GB', label: 'Harvest', catalogNumber: 'SHVL 804', format: '12" Vinyl', recordings: [11, 12, 13] }
const remaster: Edition = {
  release: 102, date: '2011-09-26', country: 'XE', label: 'EMI', catalogNumber: '50999 028955 2 5', format: 'CD',
  disambiguation: '2011 remaster', recordings: [11, 12, 13],
}

type Quality = { codec: string; container: string; lossless: boolean; sampleRate: number; bitDepth: number | null; bitrate: number; extension: string }
const hiRes: Quality = { codec: 'FLAC', container: 'flac', lossless: true, sampleRate: 96_000, bitDepth: 24, bitrate: 3_000_000, extension: 'flac' }
const cd: Quality = { codec: 'FLAC', container: 'flac', lossless: true, sampleRate: 44_100, bitDepth: 16, bitrate: 900_000, extension: 'flac' }
const mp3: Quality = { codec: 'MPEG 1 Layer 3', container: 'mp3', lossless: false, sampleRate: 44_100, bitDepth: null, bitrate: 320_000, extension: 'mp3' }

/** Ingests a folder of the album's files with the given technical facts, as the scanner and probe leave them. */
async function rip(rootId: string, folder: string, quality: Quality) {
  const ingested = await ingestAlbum(rootId, dsotm, { folder })
  for (const file of ingested.files) {
    await db.update(mediaFiles).set({
      codec: quality.codec, container: quality.container, lossless: quality.lossless, sampleRate: quality.sampleRate,
      bitDepth: quality.bitDepth, bitrate: quality.bitrate, channels: 2, relPath: file.relPath.replace(/\.flac$/, `.${quality.extension}`),
    }).where(eq(mediaFiles.id, file.id))
  }
  return ingested
}

/** Matches a ripped folder to `mb`, each file to the track at its place, as the matcher does once it accepts. */
async function match(files: { id: string }[], mb: MbRelease) {
  const evaluation = {
    score: 0.99, breakdown: {} as Evaluation['breakdown'], extraFileIds: [],
    pairs: files.map((file, index) => ({ fileId: file.id, disc: 1, position: index + 1, similarity: 1 })),
  } satisfies Evaluation
  return db.transaction((tx) => applyMatch(tx, { release: mb, fileIds: files.map((file) => file.id), evaluation, source: 'search', locked: false, attachExtras: true }))
}

async function canonicalOf(albumId: string) {
  const [row] = await db.select({ id: albums.canonicalReleaseId, mbid: releases.mbid }).from(albums)
    .leftJoin(releases, eq(releases.id, albums.canonicalReleaseId)).where(eq(albums.id, albumId))
  return row!.mbid
}

describe('album editions and versions', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  let rootId = ''
  const get = (url: string) => app.inject({ url: `/api/v1${url}`, headers: user.headers })
  const pick = (type: 'album' | 'track', id: string, versionId: string | null) => versionId === null
    ? app.inject({ method: 'DELETE', url: `/api/v1/me/versions/${type}/${id}`, headers: user.headers })
    : app.inject({ method: 'PUT', url: `/api/v1/me/versions/${type}/${id}`, headers: user.headers, payload: { versionId } })
  const page = async (albumId: string) => body(await get(`/albums/${albumId}`), AlbumDetail)
  const listed = (album: AlbumDetail) => album.discs.flatMap((disc) => disc.tracks.map((track) => track.id))
  const playback = async (trackId: string, query = '') => body(await get(`/tracks/${trackId}/playback?${query}`), PlaybackDescriptor)
  const tierOf = (versionId: string | null | undefined) => versionId?.split(':')[1] as AudioTier | undefined
  const share = async (payload: Record<string, unknown>) => {
    const link = body(await app.inject({ method: 'POST', url: '/api/v1/me/shares', headers: user.headers, payload }), ShareLink)
    return link.url!.slice('/s/'.length)
  }
  /** The file a share link plays of a song, from the key its URL seals. */
  const sharedFile = async (token: string, trackId: string) => {
    const played = body(await app.inject({ url: `/api/v1/share/${token}/tracks/${trackId}/playback` }), ShareTrackPlayback)
    return openStreamKey(played.url.split('key=').at(-1)!)!.fileId
  }

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
    user = await signIn({ settings: { libraryIncludesServerMusic: true } })
    rootId = (await createLibraryRoot()).id
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
  })

  describe('two editions with the same recordings', () => {
    let albumId = ''
    let vinylFiles: { id: string }[] = []
    let remasterFiles: { id: string }[] = []

    beforeAll(async () => {
      const lp = await rip(rootId, 'Vinyl/The Dark Side of the Moon', hiRes)
      const cdRip = await rip(rootId, 'CD/The Dark Side of the Moon', cd)
      vinylFiles = lp.files
      remasterFiles = cdRip.files
      albumId = (await match(vinylFiles, release(100, 'The Dark Side of the Moon', vinyl))).albumId
      expect((await match(remasterFiles, release(100, 'The Dark Side of the Moon', remaster))).albumId).toBe(albumId)
    })

    it('keeps each file on its own edition and the first edition as the album’s, whatever is matched next', async () => {
      const files = await db.select({ id: mediaFiles.id, release: releases.mbid, album: mediaFiles.albumId }).from(mediaFiles)
        .innerJoin(releases, eq(releases.id, mediaFiles.releaseId)).where(inArray(mediaFiles.id, [...vinylFiles, ...remasterFiles].map((file) => file.id)))
      expect(new Set(files.map((file) => file.album))).toEqual(new Set([albumId]))
      expect(files.filter((file) => file.release === mbid(101))).toHaveLength(3)
      expect(files.filter((file) => file.release === mbid(102))).toHaveLength(3)
      // The second edition matched used to take the album over.
      expect(await canonicalOf(albumId)).toBe(mbid(101))
      // Matching either folder again changes nothing.
      await match(remasterFiles, release(100, 'The Dark Side of the Moon', remaster))
      await match(vinylFiles, release(100, 'The Dark Side of the Moon', vinyl))
      expect(await canonicalOf(albumId)).toBe(mbid(101))
      const [stored] = await db.select({ disambiguation: releases.disambiguation }).from(releases).where(eq(releases.mbid, mbid(102)))
      expect(stored!.disambiguation).toBe('2011 remaster')
    })

    it('lists both versions once each, and the songs once', async () => {
      const album = await page(albumId)
      expect(listed(album)).toHaveLength(3)
      expect(album.versionId).toBeNull()
      expect(album.ownedVersions).toEqual([
        expect.objectContaining({
          title: 'The Dark Side of the Moon', releaseDate: '1973-03-01', country: 'GB', label: 'Harvest', catalogNumber: 'SHVL 804', format: '12" Vinyl',
          disambiguation: null, identified: true, trackCount: 3, ownedTrackCount: 3,
          quality: { tier: 'hi_res_lossless', codec: 'flac', sampleRate: 96_000, bitDepth: 24, bitrate: 3_000_000 },
        }),
        expect.objectContaining({
          releaseDate: '2011-09-26', label: 'EMI', format: 'CD', disambiguation: '2011 remaster', identified: true, trackCount: 3, ownedTrackCount: 3,
          quality: { tier: 'lossless', codec: 'flac', sampleRate: 44_100, bitDepth: 16, bitrate: 900_000 },
        }),
      ])
      expect(album).toMatchObject({ trackCount: 3, ownedTrackCount: 3, availability: 'full' })
    })

    it('plays the best copy of each song, then the picked version, then a song’s own pick', async () => {
      const album = await page(albumId)
      const [first, second] = listed(album)
      const [hiResVersion, cdVersion] = album.ownedVersions!
      // Automatic: the hi-res rip.
      let descriptor = await playback(first!, `albumId=${albumId}`)
      expect(vinylFiles.map((file) => file.id)).toContain(descriptor.fileId)
      expect(descriptor.source!.versionId).toBe(hiResVersion!.id)

      body(await pick('album', albumId, cdVersion!.id), Ok)
      expect((await page(albumId)).versionId).toBe(cdVersion!.id)
      descriptor = await playback(first!, `albumId=${albumId}`)
      expect(remasterFiles.map((file) => file.id)).toContain(descriptor.fileId)
      // Without the album's context too: the pick is the album's default everywhere.
      expect((await playback(first!)).source!.versionId).toBe(cdVersion!.id)

      // One song's pick wins over the album's.
      const versions = body(await get(`/tracks/${second}/versions?albumId=${albumId}`), TrackVersions)
      expect(versions.versions.map((version) => version.id)).toEqual([hiResVersion!.id, cdVersion!.id])
      expect(versions).toMatchObject({ versionId: null, albumVersionId: cdVersion!.id })
      body(await pick('track', second!, hiResVersion!.id), Ok)
      expect(body(await get(`/tracks/${second}/versions?albumId=${albumId}`), TrackVersions).versionId).toBe(hiResVersion!.id)
      expect((await playback(second!, `albumId=${albumId}`)).source!.versionId).toBe(hiResVersion!.id)
      expect((await playback(first!, `albumId=${albumId}`)).source!.versionId).toBe(cdVersion!.id)

      // Subsonic shows and streams the same files.
      const [subFirst, subSecond] = await songs(user.id, [{ id: first!, albumId }, { id: second!, albumId }])
      expect(subFirst!.path).toMatch(/^CD\//)
      expect(subSecond!.path).toMatch(/^Vinyl\//)

      body(await pick('track', second!, null), Ok)
      body(await pick('album', albumId, null), Ok)
      expect((await page(albumId)).versionId).toBeNull()
      expect(tierOf((await playback(first!, `albumId=${albumId}`)).source!.versionId)).toBe('hi_res_lossless')
    })

    it('plays the sharer’s pick on their links and exports it in their playlists', async () => {
      const album = await page(albumId)
      const [first, second] = listed(album)
      const [, cdVersion] = album.ownedVersions!
      const token = await share({ kind: 'track', id: first!, albumId })
      const playlist = await createPlaylist(user.id, { name: 'Versions' }, [{ trackId: first!, albumId }, { trackId: second!, albumId }])
      const exported = async () => (JSON.parse(await exportPlaylist(user.id, playlist.id, 'json')) as { tracks: { path: string }[] }).tracks.map((track) => track.path)
      expect(vinylFiles.map((file) => file.id)).toContain(await sharedFile(token, first!))
      expect(await exported()).toEqual([expect.stringMatching(/^Vinyl\//), expect.stringMatching(/^Vinyl\//)])

      body(await pick('album', albumId, cdVersion!.id), Ok)
      expect(remasterFiles.map((file) => file.id)).toContain(await sharedFile(token, first!))
      expect(await exported()).toEqual([expect.stringMatching(/^CD\//), expect.stringMatching(/^CD\//)])
      body(await pick('track', second!, album.ownedVersions![0]!.id), Ok)
      expect(await exported()).toEqual([expect.stringMatching(/^CD\//), expect.stringMatching(/^Vinyl\//)])
      body(await pick('track', second!, null), Ok)
      body(await pick('album', albumId, null), Ok)
    })

    it('refuses a version the server does not hold, and ignores a pick whose files left until they return', async () => {
      const [, cdVersion] = (await page(albumId)).ownedVersions!
      expect(errorCode(await pick('album', albumId, `${mbid(999)}:lossless`), 404)).toBe('version_not_found')
      expect(errorCode(await pick('album', albumId, `${mbid(101)}:lossy`), 404)).toBe('version_not_found')
      expect(errorCode(await pick('album', newId(), cdVersion!.id), 404)).toBe('album_not_found')

      body(await pick('album', albumId, cdVersion!.id), Ok)
      await db.update(mediaFiles).set({ missingSince: new Date() }).where(inArray(mediaFiles.id, remasterFiles.map((file) => file.id)))
      let album = await page(albumId)
      expect(album.versionId).toBeNull()
      expect(album.ownedVersions).toHaveLength(1)
      expect(await db.select().from(versionPicks).where(eq(versionPicks.entityId, albumId))).toHaveLength(1)
      await db.update(mediaFiles).set({ missingSince: null }).where(inArray(mediaFiles.id, remasterFiles.map((file) => file.id)))
      album = await page(albumId)
      expect(album.versionId).toBe(cdVersion!.id)
      body(await pick('album', albumId, null), Ok)
    })
  })

  describe('two editions with recordings of their own', () => {
    let albumId = ''
    let original: string[] = []
    let remix: string[] = []

    beforeAll(async () => {
      const lp = await rip(rootId, 'Animals/1977', cd)
      const cdRip = await rip(rootId, 'Animals/2018', mp3)
      albumId = (await match(lp.files, release(200, 'Animals', { ...vinyl, release: 201, recordings: [21, 22, 23] }))).albumId
      await match(cdRip.files, release(200, 'Animals', { ...remaster, release: 202, date: '2018-09-28', disambiguation: '2018 remix', recordings: [31, 32, 33] }))
      const ids = async (mbids: number[]) => (await db.select({ id: recordings.id }).from(recordings).where(inArray(recordings.mbid, mbids.map(mbid)))).map((row) => row.id)
      original = await ids([21, 22, 23])
      remix = await ids([31, 32, 33])
    })

    it('lists the songs of one edition, not both', async () => {
      const album = await page(albumId)
      // Both editions used to be listed: the album's release, then the other's songs as extras.
      expect(new Set(listed(album))).toEqual(new Set(original))
      expect(album).toMatchObject({ trackCount: 3, ownedTrackCount: 3, availability: 'full' })
      expect(album.ownedVersions!.map((version) => version.disambiguation)).toEqual([null, '2018 remix'])
    })

    it('lists the picked edition’s songs, for the page and Subsonic', async () => {
      const remixVersion = (await page(albumId)).ownedVersions![1]!
      body(await pick('album', albumId, remixVersion.id), Ok)
      const album = await page(albumId)
      expect(new Set(listed(album))).toEqual(new Set(remix))
      expect(album).toMatchObject({ releaseDate: '2018-09-28', label: 'EMI' })
      const played = await playback(remix[0]!, `albumId=${albumId}`)
      expect(played.source!.versionId).toBe(remixVersion.id)
      // An album link shows and plays the edition its creator's page lists.
      const token = await share({ kind: 'album', id: albumId })
      const shared = body(await app.inject({ url: `/api/v1/share/${token}` }), PublicShare)
      expect(new Set(shared.tracks.map((track) => track.id))).toEqual(new Set(remix))
      const [file] = await db.select({ recordingId: mediaFiles.recordingId }).from(mediaFiles).where(eq(mediaFiles.id, await sharedFile(token, remix[0]!)))
      expect(file!.recordingId).toBe(remix[0])
      body(await pick('album', albumId, null), Ok)
    })
  })

  it('counts a copy on a track list without an MBID as a version of the album’s own edition', async () => {
    const lp = await rip(rootId, 'Meddle/LP', cd)
    const { albumId, releaseId } = await match(lp.files, release(300, 'Meddle', { ...vinyl, release: 301, recordings: [41, 42, 43] }))
    // A provider delivered AAC copies onto a track list a store built.
    const storeRelease = newId()
    await db.insert(releases).values({ id: storeRelease, albumId, title: 'Meddle', trackCount: 3, fetchedAt: new Date() })
    const tracks = await db.select().from(releaseTracks).where(eq(releaseTracks.releaseId, releaseId)).orderBy(releaseTracks.position)
    for (const track of tracks) {
      const trackId = newId()
      await db.insert(releaseTracks).values({ id: trackId, releaseId: storeRelease, disc: 1, position: track.position, recordingId: track.recordingId, title: track.title })
      const fileId = await createFile({ rootId, recordingId: track.recordingId, albumId, source: 'provider:test', relPath: `_Fetched/Meddle/${track.position}.m4a` })
      await db.update(mediaFiles).set({ codec: 'aac', container: 'mp4', lossless: false, bitrate: 256_000, sampleRate: 44_100, releaseId: storeRelease, releaseTrackId: trackId })
        .where(eq(mediaFiles.id, fileId))
    }
    const { versions } = await albumVersions(albumId)
    expect(versions.map((version) => [version.id.split(':')[0], version.quality.tier, version.identified, version.ownedTrackCount])).toEqual([
      [releaseId, 'lossless', true, 3],
      [releaseId, 'lossy', false, 3],
    ])
    expect(listed(await page(albumId))).toHaveLength(3)
  })

  it('plays the copy the client receives best', async () => {
    const album = await createAlbum({ owned: true, tracks: [{ title: 'Echoes' }] })
    const [track] = album.tracks
    await db.update(mediaFiles).set({ sampleRate: 96_000, bitDepth: 24, bitrate: 3_000_000 }).where(eq(mediaFiles.id, track!.fileId!))
    const alac = await createFile({ rootId, recordingId: track!.recordingId, albumId: album.albumId, relPath: 'alac/Echoes.m4a' })
    await db.update(mediaFiles).set({ codec: 'alac', container: 'mp4', sampleRate: 44_100, bitDepth: 16, bitrate: 800_000 }).where(eq(mediaFiles.id, alac))
    // Every codec: the hi-res FLAC as it is.
    expect((await playback(track!.recordingId)).fileId).toBe(track!.fileId)
    // No FLAC: the ALAC file reaches the client lossless; the FLAC would be a transcode.
    expect(await playback(track!.recordingId, 'codecs=alac,aac,mp3')).toMatchObject({ fileId: alac, transcoded: false, lossless: true })
    // Both are transcodes at High: the lossless source with more to give.
    expect((await playback(track!.recordingId, 'quality=high&codecs=alac,aac,mp3')).fileId).toBe(track!.fileId)
  })

  it('moves picks with merges, keeping the later one', async () => {
    const a = await createAlbum({ owned: true })
    const b = await createAlbum({ owned: true })
    const [releaseA] = await db.select({ id: releases.id }).from(releases).where(eq(releases.albumId, a.albumId))
    const [releaseB] = await db.select({ id: releases.id }).from(releases).where(eq(releases.albumId, b.albumId))
    const other = await signIn()
    await db.insert(versionPicks).values([
      { userId: user.id, entityType: 'album', entityId: a.albumId, releaseId: releaseA!.id, tier: 'lossless', pickedAt: new Date(Date.now() - 60_000) },
      { userId: user.id, entityType: 'album', entityId: b.albumId, releaseId: releaseB!.id, tier: 'lossless' },
      { userId: other.id, entityType: 'album', entityId: a.albumId, releaseId: releaseA!.id, tier: 'lossless' },
    ])
    await mergeAlbum(a.albumId, b.albumId)
    const picks = await db.select().from(versionPicks).where(inArray(versionPicks.userId, [user.id, other.id]))
    expect(picks.filter((row) => row.entityId === a.albumId)).toEqual([])
    expect(picks.find((row) => row.userId === user.id && row.entityId === b.albumId)!.releaseId).toBe(releaseB!.id)
    expect(picks.find((row) => row.userId === other.id && row.entityId === b.albumId)!.releaseId).toBe(releaseA!.id)
    // A pick goes with its release.
    await db.execute(sql`delete from releases where id = ${releaseA!.id}`)
    expect(await db.select().from(versionPicks).where(eq(versionPicks.userId, other.id))).toEqual([])
  })
})
