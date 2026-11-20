import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { parseFile } from 'music-metadata'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, artists, mediaFiles, recordings, releaseLoudness, releases } from '../../database/schema.js'
import { audioHash } from '../../lib/ffmpeg.js'
import { makeTone, type ToneFormat } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createArtist } from '../../test/factories.js'
import { applyBatch } from './apply.js'
import { getBatch } from './batches.js'
import { planOrganize } from './plan.js'
import { revertBatch } from './revert.js'
import { catalogTagValues, TAG_WRITABLE, writeTags, type TagValues } from './tags.js'
import { addAlbum, makeRoot, manifest } from './test-library.js'

describe('organize: tags', () => {
  useTestDatabase()

  const values: TagValues = {
    title: 'Ünïcode “Title” ✓',
    artist: 'Track Artist feat. Guest',
    album: 'Album / Name',
    albumArtist: 'Album Artist',
    track: 3,
    trackTotal: 12,
    disc: 2,
    discTotal: 2,
    year: 1999,
    genres: ['Rock'],
    musicbrainz: {
      recordingId: '11111111-1111-4111-8111-111111111111',
      releaseId: '22222222-2222-4222-8222-222222222222',
      releaseGroupId: '33333333-3333-4333-8333-333333333333',
      artistId: '44444444-4444-4444-8444-444444444444',
      albumArtistId: '55555555-5555-4555-8555-555555555555',
    },
    replayGain: { trackGain: -6.5, trackPeak: 0.912345, albumGain: -7.25, albumPeak: 0.98 },
  }

  const scratch = () => mkdtemp(path.join(tmpdir(), 'squirmy-tags-'))
  const formats: ToneFormat[] = ['flac', 'mp3', 'm4a', 'ogg', 'opus']

  describe('writeTags', () => {
    it.each(formats)('round-trips every field in %s without touching the audio', async (format) => {
      const dir = await scratch()
      const file = await makeTone(dir, { path: `tone.${format}`, tags: { title: 'Old', composer: 'Keep Me' }, cover: true })
      const hash = await audioHash(file)

      const result = await writeTags(file, values, { temp: path.join(dir, `.tmp.${format}`), expectedAudioHash: hash })
      expect(result).toMatchObject({ written: true })
      expect(await audioHash(file)).toBe(hash)
      expect(await readdir(dir)).toEqual([`tone.${format}`])

      const { common } = await parseFile(file)
      expect(common).toMatchObject({
        title: values.title,
        artist: values.artist,
        album: values.album,
        albumartist: values.albumArtist,
        track: { no: 3, of: 12 },
        disk: { no: 2, of: 2 },
        year: 1999,
        genre: ['Rock'],
        musicbrainz_recordingid: values.musicbrainz.recordingId,
        musicbrainz_albumid: values.musicbrainz.releaseId,
        musicbrainz_releasegroupid: values.musicbrainz.releaseGroupId,
        musicbrainz_artistid: [values.musicbrainz.artistId],
        musicbrainz_albumartistid: [values.musicbrainz.albumArtistId],
      })
      expect(common.replaygain_track_gain?.dB).toBeCloseTo(-6.5, 2)
      expect(common.replaygain_track_peak?.ratio).toBeCloseTo(0.912345, 5)
      expect(common.replaygain_album_gain?.dB).toBeCloseTo(-7.25, 2)
      expect(common.replaygain_album_peak?.ratio).toBeCloseTo(0.98, 5)
      // Fields Squirmy does not manage are kept.
      expect(common.composer).toEqual(['Keep Me'])
      if (format !== 'ogg' && format !== 'opus') expect(common.picture).toHaveLength(1)
    })

    it('covers exactly the formats that were tested', () => {
      expect([...TAG_WRITABLE].sort()).toEqual([...formats].sort())
    })

    it('refuses other formats and leaves them untouched', async () => {
      const dir = await scratch()
      const file = await makeTone(dir, { path: 'tone.wav' })
      const before = await readFile(file)
      expect(await writeTags(file, values, { temp: path.join(dir, '.tmp.wav') })).toEqual({ written: false, reason: 'Writing tags into .wav files is not supported' })
      expect(await readFile(file)).toEqual(before)
    })

    it('refuses a file whose audio is not what the library expects', async () => {
      const dir = await scratch()
      const file = await makeTone(dir, { path: 'tone.flac' })
      const before = await readFile(file)
      const result = await writeTags(file, values, { temp: path.join(dir, '.tmp.flac'), expectedAudioHash: 'f'.repeat(64) })
      expect(result).toEqual({ written: false, reason: 'The audio does not match what the library has on record' })
      expect(await readFile(file)).toEqual(before)
    })

    it('leaves the original alone when the tag library cannot write the file', async () => {
      const dir = await scratch()
      const file = path.join(dir, 'broken.m4a')
      await writeFile(file, Buffer.alloc(4096, 7))
      const before = await readFile(file)
      expect(await writeTags(file, values, { temp: path.join(dir, '.tmp.m4a') })).toEqual({ written: false, reason: 'The audio stream could not be read' })
      expect(await readFile(file)).toEqual(before)
      expect(await readdir(dir)).toEqual(['broken.m4a'])
    })
  })

  describe('organizing with tags', () => {
    it('writes catalog tags while applying, records them, and undo leaves them in place', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'Tagged Artist', mbid: '44444444-4444-4444-8444-444444444444' })
      const album = await addAlbum(root, { artist, title: 'Tagged', year: 2005, mbid: '33333333-3333-4333-8333-333333333333', tracks: [{ title: 'Song', mbid: undefined }] },
        ['in/song.flac'], { audio: true })
      await addAlbum(root, { artist, title: 'Wave', year: 2005, tracks: [{ title: 'Raw' }] }, ['in2/raw.wav'], { audio: true })
      const [file] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, album.fileIds[0]!))
      const originalHash = await audioHash(path.join(root.path, file!.relPath))
      await db.update(mediaFiles).set({ audioHash: originalHash, loudnessLufs: -12, truePeakDb: -1 }).where(eq(mediaFiles.id, file!.id))
      await db.update(recordings).set({ mbid: '11111111-1111-4111-8111-111111111111' }).where(eq(recordings.id, album.tracks[0]!.recordingId))
      await db.update(releases).set({ mbid: '22222222-2222-4222-8222-222222222222' }).where(eq(releases.id, album.releaseId))
      await db.update(albums).set({ genres: ['Jazz'] }).where(eq(albums.id, album.albumId))
      await db.insert(releaseLoudness).values({ releaseId: album.releaseId, loudnessLufs: -11, truePeakDb: -0.5, fileCount: 1 })

      const expected = await catalogTagValues(file!.id)
      expect(expected).toMatchObject({
        title: 'Song', artist: 'Tagged Artist', album: 'Tagged', albumArtist: 'Tagged Artist', track: 1, trackTotal: 1, disc: 1, discTotal: 1, year: 2005, genres: ['Jazz'],
        musicbrainz: {
          recordingId: '11111111-1111-4111-8111-111111111111', releaseId: '22222222-2222-4222-8222-222222222222', releaseGroupId: '33333333-3333-4333-8333-333333333333',
          artistId: '44444444-4444-4444-8444-444444444444', albumArtistId: '44444444-4444-4444-8444-444444444444',
        },
        replayGain: { trackGain: -6, trackPeak: 0.891251, albumGain: -7, albumPeak: 0.944061 },
      })

      const batchId = await planOrganize({ rootId: root.id, userId: null, writeTags: true })
      await applyBatch(batchId)
      const view = await getBatch(batchId)
      expect(view.counts).toMatchObject({ applied: 2, tagsWritten: 1, tagsSkipped: 1 })
      expect(view.notice).toMatch(/tags written by this batch stay/)
      const moves = view.albums.flatMap((group) => group.moves)
      expect(moves.find((move) => move.from === 'in2/raw.wav')?.reason).toBe('Tags not written: Writing tags into .wav files is not supported')

      const [moved] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, file!.id))
      const target = path.join(root.path, moved!.relPath)
      expect(moved!.relPath).toBe('Tagged Artist/Tagged (2005)/01 Song.flac')
      const onDisk = await stat(target)
      expect(moved!.size).toBe(onDisk.size)
      expect(moved!.mtime.getTime()).toBe(onDisk.mtime.getTime())
      expect(moved!.tags).toMatchObject({ title: 'Song', album: 'Tagged', genres: ['Jazz'], mbRecordingId: '11111111-1111-4111-8111-111111111111' })
      expect(await audioHash(target)).toBe(originalHash)
      expect((await parseFile(target)).common).toMatchObject({ title: 'Song', genre: ['Jazz'], musicbrainz_artistid: ['44444444-4444-4444-8444-444444444444'] })

      await revertBatch(batchId)
      const back = path.join(root.path, 'in/song.flac')
      expect((await parseFile(back)).common.title).toBe('Song')
      expect(Object.keys(await manifest(root.path)).sort()).toEqual(['in/', 'in/song.flac', 'in2/', 'in2/raw.wav'])
    })

    it('writes tags into files that are already in place', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'Here' })
      await db.update(artists).set({ mbid: null }).where(eq(artists.id, artist.id))
      await addAlbum(root, { artist, title: 'Done', year: 2000, tracks: [{ title: 'A' }] }, ['Here/Done (2000)/01 A.mp3'], { audio: true })
      const batchId = await planOrganize({ rootId: root.id, userId: null, writeTags: true })
      await applyBatch(batchId)
      expect((await getBatch(batchId)).counts).toMatchObject({ applied: 1, tagsWritten: 1 })
      expect((await parseFile(path.join(root.path, 'Here/Done (2000)/01 A.mp3'))).common).toMatchObject({ title: 'A', album: 'Done', year: 2000 })
    })
  })
})
