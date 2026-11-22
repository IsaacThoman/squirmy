import type { StreamQuality } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, mediaFiles } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot } from '../../test/factories.js'
import { buildPlaybackDescriptor } from './playback.js'
import { codecFamily, mimeFor, parseCodecs } from './profiles.js'
import { chooseProfile, selectFile } from './select.js'

const flac = { codec: 'FLAC', container: 'FLAC', relPath: 'a/01.flac', lossless: true, bitrate: 900_000 }
const mp3 = (kbps: number) => ({ codec: 'MPEG 1 Layer 3', container: 'MPEG', relPath: 'a/01.mp3', lossless: false, bitrate: kbps * 1000 })
const vorbis = (kbps: number) => ({ codec: 'Vorbis I', container: 'Ogg', relPath: 'a/01.ogg', lossless: false, bitrate: kbps * 1000 })
const alac = { codec: 'ALAC', container: 'M4A/isom', relPath: 'a/01.m4a', lossless: true, bitrate: 800_000 }

describe('profile decisions', () => {
  const browser = parseCodecs(undefined)
  const avPlayer = parseCodecs('aac,alac,mp3,flac,wav,aiff')
  const legacy = parseCodecs('mp3')

  it.each<[string, Parameters<typeof chooseProfile>[0], StreamQuality, ReadonlySet<string>, string]>([
    ['lossless original, browser', flac, 'original', browser, 'original'],
    ['lossless high', flac, 'high', browser, 'aac_256'],
    ['lossless data saver with opus', flac, 'data_saver', browser, 'opus_128'],
    ['lossless data saver without opus', flac, 'data_saver', avPlayer, 'mp3_192'],
    ['lossless original, client without flac', flac, 'original', parseCodecs('aac,mp3'), 'aac_256'],
    ['alac original on AVPlayer', alac, 'original', avPlayer, 'original'],
    ['alac original, mp3-only client', alac, 'original', legacy, 'mp3_320'],
    ['192k mp3 asked high: already enough', mp3(192), 'high', browser, 'original'],
    ['320k mp3 asked high: smaller transcode', mp3(320), 'high', browser, 'aac_256'],
    ['192k mp3 data saver without opus: already enough', mp3(192), 'data_saver', avPlayer, 'original'],
    ['192k mp3 data saver with opus', mp3(192), 'data_saver', browser, 'opus_128'],
    ['128k mp3 data saver with opus: already enough', mp3(128), 'data_saver', browser, 'original'],
    ['160k vorbis on AVPlayer, high: smallest profile that holds it', vorbis(160), 'high', avPlayer, 'mp3_192'],
    ['96k vorbis on an aac-only client', vorbis(96), 'original', parseCodecs('aac'), 'aac_256'],
    ['320k vorbis on AVPlayer', vorbis(320), 'original', avPlayer, 'aac_256'],
  ])('%s', (_name, file, quality, codecs, expected) => {
    expect(chooseProfile(file, quality, codecs)).toBe(expected)
  })

  it('names codecs and content types', () => {
    expect(codecFamily(mp3(320))).toBe('mp3')
    expect(codecFamily({ codec: 'MPEG-4/AAC', container: 'M4A', relPath: 'x.m4a' })).toBe('aac')
    expect(codecFamily({ codec: 'PCM', container: 'AIFF', relPath: 'x.aif' })).toBe('aiff')
    expect(codecFamily({ codec: 'PCM', container: 'WAVE', relPath: 'x.wav' })).toBe('wav')
    expect(codecFamily({ codec: 'Opus', container: 'Ogg', relPath: 'x.opus' })).toBe('opus')
    expect(mimeFor({ relPath: 'a/B.FLAC' })).toBe('audio/flac')
    expect(mimeFor({ relPath: 'a/b.m4a' })).toBe('audio/mp4')
    expect(mimeFor({ relPath: 'a/b.opus' })).toBe('audio/ogg')
    expect(mimeFor({ relPath: 'a/b.xyz' })).toBe('application/octet-stream')
    expect([...parseCodecs(' FLAC, mp3 ,,')]).toEqual(['flac', 'mp3'])
  })
})

describe('file selection', () => {
  useTestDatabase()

  it('prefers the album, then lossless, then bitrate, and skips missing files', async () => {
    const root = await createLibraryRoot()
    const first = await createAlbum({ owned: true, rootId: root.id, tracks: [{ title: 'Song' }] })
    const second = await createAlbum({ tracks: [{ title: 'Song' }] })
    const recordingId = first.tracks[0]!.recordingId
    const addFile = async (relPath: string, values: Partial<typeof mediaFiles.$inferInsert>) => {
      const id = newId()
      await db.insert(mediaFiles).values({ id, rootId: root.id, relPath, size: 1, mtime: new Date(), container: 'MPEG', codec: 'MPEG 1 Layer 3', recordingId, ...values })
      return id
    }
    const lossyOnSecond = await addFile('b/320.mp3', { bitrate: 320_000, albumId: second.albumId })
    const lossy128 = await addFile('b/128.mp3', { bitrate: 128_000, albumId: first.albumId })
    const flacId = first.tracks[0]!.fileId!

    expect((await selectFile(recordingId, { quality: 'original' }))!.file.id).toBe(flacId)
    expect((await selectFile(recordingId, { quality: 'original', albumId: second.albumId }))!.file.id).toBe(lossyOnSecond)
    await db.update(mediaFiles).set({ missingSince: new Date() }).where(eq(mediaFiles.id, flacId))
    const fallback = await selectFile(recordingId, { quality: 'high', albumId: first.albumId })
    expect(fallback!.file.id).toBe(lossy128)
    expect(fallback!.profile).toBe('original')
    expect(await selectFile(newId(), { quality: 'original' })).toBeNull()
  })

  it('prefers the file on an album the client names by an id that lost a merge', async () => {
    const root = await createLibraryRoot()
    const studio = await createAlbum({ owned: true, rootId: root.id, tracks: [{ title: 'Song' }] })
    const compilation = await createAlbum({ tracks: [{ title: 'Song' }] })
    const recordingId = studio.tracks[0]!.recordingId
    const onCompilation = newId()
    await db.insert(mediaFiles).values({
      id: onCompilation, rootId: root.id, relPath: 'c/01.mp3', size: 1, mtime: new Date(), container: 'MPEG', codec: 'MPEG 1 Layer 3',
      bitrate: 320_000, recordingId, albumId: compilation.albumId,
    })
    // The queue entry still names the compilation's old id after a duplicate of it was merged away.
    const stale = (await createAlbum({ tracks: [{ title: 'Song' }] })).albumId
    await db.update(albums).set({ mergedIntoId: compilation.albumId }).where(eq(albums.id, stale))

    const descriptor = await buildPlaybackDescriptor(newId(), recordingId, { quality: 'original', albumId: stale })
    expect(descriptor.fileId).toBe(onCompilation)
    expect(descriptor.albumId).toBe(compilation.albumId)
  })
})
