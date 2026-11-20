import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { and, asc, eq, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import {
  albumArtists, albums, artists, assets, likes, lyrics, mediaFiles, recordingArtists, recordings, releases, releaseTracks,
} from '../../database/schema.js'
import { drainJobs, enqueue, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { updateServerSettings } from '../../lib/settings.js'
import { makeAlbum, makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { VARIOUS_ARTISTS_MBID } from './grouping.js'
import { libraryModule } from './index.js'
import { insertRoot } from './roots.js'
import { scanRoot } from './scan.js'

const mb = {
  releaseGroup: '0d2b0a39-0bd4-4b8a-a1f8-0c1f8e6f9e01',
  release: '6f1c4a7e-6c4b-4d0e-9f53-2a9c0f6a3a02',
  artist: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
  recordings: ['1c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01', '1c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02'],
  mp3Release: '7e2d5b8f-7d5c-4e1f-8a64-3b0d1f7b4b03',
}

describe('library pipeline', () => {
  useTestDatabase()
  let library = ''
  let outside = ''
  let rootId = ''

  const scan = async () => {
    const stats = await scanRoot({ rootId })
    await drainJobs({ timeoutMs: 60_000 })
    return stats!
  }
  const albumByTitle = async (title: string) => {
    const [album] = await db.select().from(albums).where(eq(albums.title, title))
    return album!
  }
  const albumCredit = async (albumId: string) => db.select({ name: artists.name, mbid: artists.mbid, joinPhrase: albumArtists.joinPhrase })
    .from(albumArtists).innerJoin(artists, eq(artists.id, albumArtists.artistId)).where(eq(albumArtists.albumId, albumId)).orderBy(asc(albumArtists.position))
  const tracksOf = async (albumId: string) => db.select({ disc: releaseTracks.disc, position: releaseTracks.position, title: releaseTracks.title, recordingId: releaseTracks.recordingId })
    .from(releaseTracks).innerJoin(releases, eq(releases.id, releaseTracks.releaseId)).where(eq(releases.albumId, albumId))
    .orderBy(asc(releaseTracks.disc), asc(releaseTracks.position))
  const fileAt = async (relPath: string) => {
    const [file] = await db.select().from(mediaFiles).where(and(eq(mediaFiles.rootId, rootId), eq(mediaFiles.relPath, relPath)))
    return file
  }
  const counts = async () => {
    const [row] = await db.execute<Record<string, number>>(sql`select
      (select count(*) from artists)::int as artists, (select count(*) from albums)::int as albums,
      (select count(*) from releases)::int as releases, (select count(*) from recordings)::int as recordings,
      (select count(*) from release_tracks)::int as tracks, (select count(*) from media_files)::int as files,
      (select count(*) from assets)::int as assets`)
    return row!
  }

  beforeAll(async () => {
    library = await mkdtemp(path.join(tmpdir(), 'squirmy-library-'))
    outside = await mkdtemp(path.join(tmpdir(), 'squirmy-outside-'))

    for (const disc of [1, 2]) {
      await makeAlbum(library, {
        artist: 'Pink Floyd', album: 'The Wall', year: 1979, folder: `Pink Floyd/The Wall/CD${disc}`, cover: '0x4a6fa5',
        tracks: [{ title: `Disc ${disc} Song A`, durationSec: 1 }, { title: `Disc ${disc} Song B`, durationSec: 1 }],
        tags: { disc: `${disc}/2` },
      })
    }
    // Disc folders without disc tags: the folder supplies the disc number.
    for (const disc of [1, 2]) {
      await makeTone(library, { path: `Boards/Geogaddi/Disc ${disc}/01 Opening.flac`, durationSec: 1, tags: { title: `Opening ${disc}`, artist: 'Boards', album: 'Geogaddi', track: 1 } })
    }
    await makeAlbum(library, {
      artist: 'Various Artists', album: 'Awesome Mix', year: 2014, format: 'mp3', tags: { compilation: 1 }, folder: 'Compilations/Awesome Mix',
      tracks: [{ title: 'Hooked on a Feeling', artist: 'Blue Swede', durationSec: 1 }, { title: 'Go All the Way', artist: 'Raspberries', durationSec: 1 }],
    })
    // A compilation without an album artist tag: the track artists disagree.
    for (const [index, artist] of ['Alpha', 'Beta'].entries()) {
      await makeTone(library, { path: `Mixes/Summer/0${index + 1} ${artist}.flac`, durationSec: 1, tags: { title: `${artist} Song`, artist, album: 'Summer Mix', track: index + 1 } })
    }
    await makeAlbum(library, {
      artist: 'Daft Punk', album: 'Random Access Memories', year: 2013, genre: 'Electronic; Disco',
      tracks: [
        { title: 'Get Lucky', artist: 'Daft Punk feat. Pharrell Williams & Nile Rodgers', durationSec: 1 },
        { title: 'Instant Crush', artist: 'Daft Punk (ft. Julian Casablancas)', durationSec: 1 },
        { title: 'Contact', durationSec: 1, tags: { REPLAYGAIN_TRACK_GAIN: '-7.50 dB', REPLAYGAIN_TRACK_PEAK: '0.98' } },
      ],
    })
    await makeAlbum(library, { artist: '椎名林檎', album: '無罪モラトリアム', year: 1999, tracks: [{ title: '正しい街', durationSec: 1 }, { title: '歌舞伎町の女王', durationSec: 1 }] })
    await makeTone(library, { path: 'misc rips/track01.mp3', durationSec: 1 })
    await makeTone(library, { path: 'misc rips/02 - Karma Police.mp3', durationSec: 1, tags: { title: 'Karma Police', artist: 'Radiohead' } })
    await makeTone(library, { path: 'Singles/bad guy.m4a', durationSec: 1, tags: { title: 'bad guy', artist: 'Billie Eilish' } })
    // Loose files by one artist in one folder form a synthetic album.
    await makeTone(library, { path: 'Demos/a.ogg', durationSec: 1, tags: { title: 'Demo A', artist: 'Lune Park' } })
    await makeTone(library, { path: 'Demos/b.opus', durationSec: 1, tags: { title: 'Demo B', artist: 'Lune Park', R128_TRACK_GAIN: -2560 } })
    await makeAlbum(library, {
      artist: 'Tagged Artist', album: 'With Ids', format: 'flac',
      tags: { MUSICBRAINZ_RELEASEGROUPID: mb.releaseGroup, MUSICBRAINZ_ALBUMID: mb.release, MUSICBRAINZ_ARTISTID: mb.artist, MUSICBRAINZ_ALBUMARTISTID: mb.artist },
      tracks: [
        { title: 'First', durationSec: 1, tags: { MUSICBRAINZ_TRACKID: mb.recordings[0]!, LYRICS: 'Just words\nno timing' } },
        { title: 'Second', durationSec: 1, tags: { MUSICBRAINZ_TRACKID: mb.recordings[1]! } },
      ],
    })
    // foobar2000-style ids in an MP3 (TXXX:MUSICBRAINZ_ALBUMID), which music-metadata leaves unmapped.
    await makeAlbum(library, { artist: 'Mp3 Artist', album: 'Mp3 Ids', format: 'mp3', tags: { MUSICBRAINZ_ALBUMID: mb.mp3Release }, tracks: [{ title: 'Only', durationSec: 1 }] })
    await writeFile(path.join(library, 'Tagged Artist/With Ids/02 Second.lrc'), '[ar:Tagged Artist]\n[00:01.00]First line\n[00:02.50]Second line\n')
    // A folder image larger than the embedded cover wins, and an artist folder image.
    await sharp({ create: { width: 400, height: 400, channels: 3, background: '#c46a2b' } }).jpeg().toFile(path.join(library, 'Daft Punk/Random Access Memories/cover.jpg'))
    await sharp({ create: { width: 200, height: 200, channels: 3, background: '#223344' } }).jpeg().toFile(path.join(library, 'Daft Punk/artist.jpg'))
    await makeTone(library, { path: '.hidden/secret.flac', durationSec: 1, tags: { title: 'Hidden' } })
    await makeTone(library, { path: '@eaDir/thumb.flac', durationSec: 1, tags: { title: 'Synology' } })
    await writeFile(path.join(library, 'misc rips/broken.flac'), 'this is not audio at all')
    await writeFile(path.join(library, 'misc rips/notes.txt'), 'ignored')

    await libraryModule.jobs!(jobs)
    await startJobs({ work: true })
    rootId = (await insertRoot({ name: 'Music', path: library, mode: 'read_only', watch: false })).id
  }, 120_000)

  afterAll(async () => {
    await stopJobs()
    await rm(library, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('scans, probes, ingests and analyzes a mixed library', async () => {
    const stats = await scan()
    expect(stats).toMatchObject({ filesSeen: 24, filesAdded: 24, filesChanged: 0, filesMissing: 0 })

    const files = await db.select().from(mediaFiles)
    expect(files).toHaveLength(24)
    expect(files.some((file) => file.relPath.includes('.hidden') || file.relPath.includes('@eaDir'))).toBe(false)
    const broken = files.find((file) => file.relPath === 'misc rips/broken.flac')!
    expect(broken).toMatchObject({ probeStage: 0, recordingId: null })
    expect(broken.probeError).toMatch(/unreadable/i)
    for (const file of files.filter((candidate) => candidate !== broken)) {
      expect(file).toMatchObject({ probeStage: 2, matchStatus: 'pending', matchSource: 'tags', probeError: null })
      expect(file.audioHash).toMatch(/^[0-9a-f]{64}$/)
      expect(file.recordingId && file.releaseId && file.albumId).toBeTruthy()
      expect(file.durationMs).toBeGreaterThan(900)
    }

    const wall = await albumByTitle('The Wall')
    expect(await albumCredit(wall.id)).toEqual([{ name: 'Pink Floyd', mbid: null, joinPhrase: '' }])
    expect((await tracksOf(wall.id)).map((track) => [track.disc, track.position, track.title])).toEqual([
      [1, 1, 'Disc 1 Song A'], [1, 2, 'Disc 1 Song B'], [2, 1, 'Disc 2 Song A'], [2, 2, 'Disc 2 Song B'],
    ])
    expect(wall).toMatchObject({ year: 1979, type: 'album' })
    expect(wall.artworkAssetId).not.toBeNull()
    const [wallRelease] = await db.select().from(releases).where(eq(releases.albumId, wall.id))
    expect(wallRelease).toMatchObject({ trackCount: 4, discCount: 2 })
    expect((await tracksOf((await albumByTitle('Geogaddi')).id)).map((track) => [track.disc, track.position])).toEqual([[1, 1], [2, 1]])

    const mix = await albumByTitle('Awesome Mix')
    expect(mix.type).toBe('compilation')
    expect(await albumCredit(mix.id)).toEqual([{ name: 'Various Artists', mbid: VARIOUS_ARTISTS_MBID, joinPhrase: '' }])
    const summer = await albumByTitle('Summer Mix')
    expect(await albumCredit(summer.id)).toEqual([{ name: 'Various Artists', mbid: VARIOUS_ARTISTS_MBID, joinPhrase: '' }])
    expect((await tracksOf(summer.id)).map((track) => track.title)).toEqual(['Alpha Song', 'Beta Song'])

    const ram = await albumByTitle('Random Access Memories')
    expect(ram.genres).toEqual(['Electronic', 'Disco'])
    expect(await albumCredit(ram.id)).toEqual([{ name: 'Daft Punk', mbid: null, joinPhrase: '' }])
    const [getLucky] = await db.select().from(recordings).where(eq(recordings.title, 'Get Lucky'))
    expect(getLucky!.artistCredit).toBe('Daft Punk feat. Pharrell Williams & Nile Rodgers')
    expect(await db.select({ name: recordingArtists.creditedName, joinPhrase: recordingArtists.joinPhrase }).from(recordingArtists)
      .where(eq(recordingArtists.recordingId, getLucky!.id)).orderBy(asc(recordingArtists.position)))
      .toEqual([{ name: 'Daft Punk', joinPhrase: ' feat. ' }, { name: 'Pharrell Williams & Nile Rodgers', joinPhrase: '' }])
    const [instantCrush] = await db.select().from(recordings).where(eq(recordings.title, 'Instant Crush'))
    expect(instantCrush!.artistCredit).toBe('Daft Punk ft. Julian Casablancas')
    expect(await db.select().from(artists).where(eq(artists.name, 'Daft Punk'))).toHaveLength(1)
    // The 400px folder image beats the 96px embedded cover; the artist folder has a photo.
    const [ramArt] = await db.select().from(assets).where(eq(assets.id, ram.artworkAssetId!))
    expect(ramArt).toMatchObject({ width: 400, height: 400, kind: 'cover' })
    expect(ramArt!.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(ramArt!.thumbhash).toBeTruthy()
    const [daftPunk] = await db.select().from(artists).where(eq(artists.name, 'Daft Punk'))
    expect(daftPunk!.imageAssetId).not.toBeNull()
    expect(await fileAt('Daft Punk/Random Access Memories/03 Contact.flac')).toMatchObject({ tagTrackGainDb: -7.5, tagTrackPeak: 0.98 })

    const shiina = await albumByTitle('無罪モラトリアム')
    expect(await albumCredit(shiina.id)).toEqual([{ name: '椎名林檎', mbid: null, joinPhrase: '' }])
    expect((await db.select().from(artists).where(eq(artists.name, '椎名林檎')))[0]!.nameKey).toBe('椎名林檎')

    const karma = await albumByTitle('Karma Police')
    expect(karma.type).toBe('single')
    expect(await albumCredit(karma.id)).toEqual([{ name: 'Radiohead', mbid: null, joinPhrase: '' }])
    const untitled = await albumByTitle('track01')
    expect(await albumCredit(untitled.id)).toEqual([{ name: 'Unknown Artist', mbid: null, joinPhrase: '' }])
    expect((await albumByTitle('bad guy')).type).toBe('single')
    const demos = await albumByTitle('Demos')
    expect(demos.type).toBe('album')
    expect((await tracksOf(demos.id)).map((track) => track.title)).toEqual(['Demo A', 'Demo B'])
    expect(await fileAt('Demos/b.opus')).toMatchObject({ codec: 'opus', container: 'ogg', tagTrackGainDb: -5 })

    const tagged = await albumByTitle('With Ids')
    expect(tagged.mbid).toBe(mb.releaseGroup)
    expect((await db.select().from(releases).where(eq(releases.albumId, tagged.id)))[0]!.mbid).toBe(mb.release)
    expect(await albumCredit(tagged.id)).toEqual([{ name: 'Tagged Artist', mbid: mb.artist, joinPhrase: '' }])
    const taggedRecordings = await db.select({ mbid: recordings.mbid, id: recordings.id, title: recordings.title }).from(recordings)
      .where(sql`${recordings.title} in ('First', 'Second')`).orderBy(asc(recordings.title))
    expect(taggedRecordings.map((recording) => recording.mbid)).toEqual(mb.recordings)
    const [mp3Release] = await db.select().from(releases).where(eq(releases.title, 'Mp3 Ids'))
    expect(mp3Release!.mbid).toBe(mb.mp3Release)

    const [plain] = await db.select().from(lyrics).where(eq(lyrics.recordingId, taggedRecordings[0]!.id))
    expect(plain).toMatchObject({ source: 'embedded', synced: null, plain: 'Just words\nno timing' })
    const [synced] = await db.select().from(lyrics).where(eq(lyrics.recordingId, taggedRecordings[1]!.id))
    expect(synced).toMatchObject({ source: 'sidecar', plain: 'First line\nSecond line' })
    expect(synced!.synced).toContain('[00:02.50]Second line')

    const [queued] = await db.execute<{ matching: number; loudness: number }>(sql`select
      count(*) filter (where name = 'matching.match-album')::int as matching,
      count(*) filter (where name = 'loudness.measure')::int as loudness from pgboss.job`)
    expect(queued!.loudness).toBe(23)
    expect(queued!.matching).toBe(new Set(files.filter((file) => file.groupKey).map((file) => file.groupKey)).size)
  })

  it('changes nothing when scanned again', async () => {
    const before = await counts()
    const ids = (await db.select({ id: mediaFiles.id, recordingId: mediaFiles.recordingId, albumId: mediaFiles.albumId }).from(mediaFiles).orderBy(asc(mediaFiles.id)))
    expect(await scan()).toMatchObject({ filesSeen: 24, filesAdded: 0, filesChanged: 0, filesMissing: 0 })
    // Re-ingesting every group must not create or rename anything either.
    const groups = await db.selectDistinct({ groupKey: mediaFiles.groupKey }).from(mediaFiles)
    for (const { groupKey } of groups) if (groupKey) await enqueue('library.ingest', { rootId, groupKey }, { singletonKey: groupKey })
    await drainJobs()
    expect(await counts()).toEqual(before)
    expect(await db.select({ id: mediaFiles.id, recordingId: mediaFiles.recordingId, albumId: mediaFiles.albumId }).from(mediaFiles).orderBy(asc(mediaFiles.id))).toEqual(ids)
  })

  it('only relinks a group that has been identified', async () => {
    const files = await db.select().from(mediaFiles).where(sql`${mediaFiles.relPath} like 'Boards/Geogaddi/%'`).orderBy(asc(mediaFiles.relPath))
    const albumId = files[0]!.albumId!
    await db.update(mediaFiles).set({ matchStatus: 'matched' }).where(sql`${mediaFiles.relPath} like 'Boards/Geogaddi/%'`)
    await db.update(albums).set({ title: 'Geogaddi (identified)' }).where(eq(albums.id, albumId))
    await db.update(recordings).set({ title: 'Opening (identified)' }).where(eq(recordings.id, files[0]!.recordingId!))

    await makeTone(library, { path: 'Boards/Geogaddi/Disc 1/01 Opening.flac', durationSec: 1, frequency: 500, tags: { title: 'Retagged', artist: 'Boards', album: 'Geogaddi', track: 1 } })
    await makeTone(library, { path: 'Boards/Geogaddi/Disc 1/02 Second.flac', durationSec: 1, tags: { title: 'Second', artist: 'Boards', album: 'Geogaddi', track: 2 } })
    await scan()

    expect((await db.select().from(albums).where(eq(albums.id, albumId)))[0]!.title).toBe('Geogaddi (identified)')
    expect((await db.select().from(recordings).where(eq(recordings.id, files[0]!.recordingId!)))[0]!.title).toBe('Opening (identified)')
    expect(await fileAt('Boards/Geogaddi/Disc 1/01 Opening.flac')).toMatchObject({ recordingId: files[0]!.recordingId, matchStatus: 'matched' })
    const added = (await fileAt('Boards/Geogaddi/Disc 1/02 Second.flac'))!
    expect(added).toMatchObject({ albumId, releaseId: files[0]!.releaseId, matchStatus: 'pending', matchSource: 'tags' })
    expect(added.recordingId).not.toBeNull()
  })

  it('re-reads a retagged file and a replaced one', async () => {
    const relPath = 'Daft Punk/Random Access Memories/03 Contact.flac'
    const before = (await fileAt(relPath))!
    await makeTone(library, { path: relPath, durationSec: 1, frequency: 300, tags: { title: 'Contact (Edit)', artist: 'Daft Punk', album_artist: 'Daft Punk', album: 'Random Access Memories', track: 3 } })
    expect(await scan()).toMatchObject({ filesChanged: 1, filesAdded: 0 })
    const after = (await fileAt(relPath))!
    expect(after.id).toBe(before.id)
    expect(after.recordingId).toBe(before.recordingId)
    expect(after.audioHash).not.toBe(before.audioHash)
    const [recording] = await db.select().from(recordings).where(eq(recordings.id, after.recordingId!))
    expect(recording!.title).toBe('Contact (Edit)')
    expect((await tracksOf(after.albumId!)).map((track) => track.title)).toEqual(['Get Lucky', 'Instant Crush', 'Contact (Edit)'])

    // A new album name moves the file to its own album and the old track goes away.
    await makeTone(library, { path: relPath, durationSec: 1, frequency: 300, tags: { title: 'Contact', artist: 'Daft Punk', album_artist: 'Daft Punk', album: 'Contact EP', track: 1 } })
    expect(await scan()).toMatchObject({ filesChanged: 1 })
    expect(await fileAt(relPath)).toMatchObject({ probeStage: 2, probeError: null })
    const moved = (await fileAt(relPath))!
    expect(moved.albumId).not.toBe(before.albumId)
    expect((await tracksOf(before.albumId!)).map((track) => track.title)).toEqual(['Get Lucky', 'Instant Crush'])
    expect((await albumByTitle('Contact EP')).id).toBe(moved.albumId)
  })

  it('marks missing files, restores them, and purges them after the grace period', async () => {
    const relPath = 'Singles/bad guy.m4a'
    const before = (await fileAt(relPath))!
    await rename(path.join(library, relPath), path.join(outside, 'bad guy.m4a'))
    expect(await scan()).toMatchObject({ filesMissing: 1 })
    expect((await fileAt(relPath))!.missingSince).not.toBeNull()
    expect((await db.select().from(albums).where(eq(albums.id, before.albumId!)))).toHaveLength(1)

    await rename(path.join(outside, 'bad guy.m4a'), path.join(library, relPath))
    expect(await scan()).toMatchObject({ filesMissing: 0, filesChanged: 0, filesAdded: 0 })
    expect(await fileAt(relPath)).toMatchObject({ id: before.id, missingSince: null, recordingId: before.recordingId })

    await rm(path.join(library, relPath))
    await scan()
    await enqueue('library.purge-missing', {})
    await drainJobs()
    expect(await fileAt(relPath)).toBeDefined()
    await updateServerSettings({ missingFileGraceDays: 0 })
    await enqueue('library.purge-missing', {})
    await drainJobs()
    expect(await fileAt(relPath)).toBeUndefined()
    expect(await db.select().from(albums).where(eq(albums.id, before.albumId!))).toHaveLength(0)
    expect(await db.select().from(recordings).where(eq(recordings.id, before.recordingId!))).toHaveLength(0)
    expect(await db.select().from(artists).where(eq(artists.name, 'Billie Eilish'))).toHaveLength(0)
    await updateServerSettings({ missingFileGraceDays: 14 })
  })

  it('recognizes a moved album by its audio hash and keeps the file ids', async () => {
    const before = await db.select().from(mediaFiles).where(sql`${mediaFiles.relPath} like '椎名林檎/%'`).orderBy(asc(mediaFiles.relPath))
    expect(before).toHaveLength(2)
    const user = await createUser()
    await db.insert(likes).values({ userId: user.id, entityType: 'album', entityId: before[0]!.albumId! })
    await mkdir(path.join(library, 'Japanese'), { recursive: true })
    await rename(path.join(library, '椎名林檎'), path.join(library, 'Japanese/椎名林檎'))
    const albumCount = (await counts()).albums
    await scan()
    const after = await db.select().from(mediaFiles).where(sql`${mediaFiles.relPath} like 'Japanese/椎名林檎/%'`).orderBy(asc(mediaFiles.relPath))
    expect(after.map((file) => file.id)).toEqual(before.map((file) => file.id))
    expect(after.map((file) => [file.recordingId, file.albumId, file.missingSince])).toEqual(before.map((file) => [file.recordingId, file.albumId, null]))
    expect(await db.select().from(mediaFiles).where(sql`${mediaFiles.relPath} like '椎名林檎/%'`)).toHaveLength(0)
    expect((await counts()).albums).toBe(albumCount)
  })

  it('removes unused local rows but keeps the ones users point at', async () => {
    const karma = (await fileAt('misc rips/02 - Karma Police.mp3'))!
    const user = await createUser()
    await db.insert(likes).values({ userId: user.id, entityType: 'recording', entityId: karma.recordingId! })
    const demoFiles = await db.select().from(mediaFiles).where(sql`${mediaFiles.relPath} like 'Demos/%'`)
    await rm(path.join(library, 'misc rips/02 - Karma Police.mp3'))
    await rm(path.join(library, 'Demos'), { recursive: true })
    await scan()
    await updateServerSettings({ missingFileGraceDays: 0 })
    await enqueue('library.purge-missing', {})
    await drainJobs()
    await updateServerSettings({ missingFileGraceDays: 14 })

    // The liked recording and its artist stay; its single goes, as does everything of Demos.
    expect(await db.select().from(recordings).where(eq(recordings.id, karma.recordingId!))).toHaveLength(1)
    expect(await db.select().from(artists).where(eq(artists.name, 'Radiohead'))).toHaveLength(1)
    expect(await db.select().from(albums).where(eq(albums.id, karma.albumId!))).toHaveLength(0)
    expect(await db.select().from(albums).where(eq(albums.id, demoFiles[0]!.albumId!))).toHaveLength(0)
    expect(await db.select().from(artists).where(eq(artists.name, 'Lune Park'))).toHaveLength(0)
    // Rows with MusicBrainz ids are never removed by cleanup.
    expect(await db.select().from(albums).where(eq(albums.mbid, mb.releaseGroup))).toHaveLength(1)
  })
})
