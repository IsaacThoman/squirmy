/**
 * stream, download, getCoverArt and lyrics against real files: quiet generated tones
 * (test/audio.ts), checked with ffprobe.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import type { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, artists, lyrics, mediaFiles, transcodes } from '../../database/schema.js'
import { startJobs } from '../../jobs/index.js'
import { runFfprobe } from '../../lib/ffmpeg.js'
import { makeTone, writeHostileInputs } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot, createUser } from '../../test/factories.js'
import { storeImage } from '../artwork/store.js'
import { createAppPassword } from '../auth/service.js'
import { subsonicClient, type SubsonicClient } from '../../test/subsonic-client.js'
import { setTranscodeSlotLimit } from '../streaming/transcode.js'
import { LIVE_ENCODES_PER_USER, liveEncode, planStream } from './transcode.js'

type Probe = { streams: { codec_name: string; sample_rate?: string }[]; format: { duration: string; bit_rate?: string } }

describe('subsonic media', () => {
  useTestDatabase()
  let app: FastifyInstance
  let client: SubsonicClient
  let secret: string
  let root: string
  let scratch: string
  let flac: { id: string; bytes: Buffer; albumId: string }
  let mp3: { id: string; bytes: Buffer }
  let coverId: string
  let artistId: string
  let userId: string

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
    const user = await createUser({ username: 'mira' })
    userId = user.id
    secret = (await createAppPassword(user.id, 'test')).secret!
    client = subsonicClient(app, { username: 'mira', secret })

    root = await mkdtemp(path.join(tmpdir(), 'squirmy-subsonic-'))
    scratch = await mkdtemp(path.join(tmpdir(), 'squirmy-subsonic-out-'))
    const rootId = (await createLibraryRoot({ path: root })).id
    await makeTone(root, { path: 'Mira Vale/Blue Hour/01 Night.flac', durationSec: 6 })
    await makeTone(root, { path: 'Mira Vale/Blue Hour/02 Day.mp3', durationSec: 6 })
    const album = await createAlbum({ title: 'Blue Hour', owned: true, rootId, tracks: [{ title: 'Night' }, { title: 'Day' }] })
    artistId = album.artist.id
    const flacBytes = await readFile(path.join(root, 'Mira Vale/Blue Hour/01 Night.flac'))
    const mp3Bytes = await readFile(path.join(root, 'Mira Vale/Blue Hour/02 Day.mp3'))
    await db.update(mediaFiles).set({ relPath: 'Mira Vale/Blue Hour/01 Night.flac', size: flacBytes.length, durationMs: 6000 })
      .where(eq(mediaFiles.id, album.tracks[0]!.fileId!))
    await db.update(mediaFiles).set({
      relPath: 'Mira Vale/Blue Hour/02 Day.mp3', size: mp3Bytes.length, durationMs: 6000, codec: 'MPEG 1 Layer 3', container: 'MPEG',
      lossless: false, bitrate: 128_000, bitDepth: null,
    }).where(eq(mediaFiles.id, album.tracks[1]!.fileId!))
    flac = { id: `tr-${album.tracks[0]!.recordingId}`, bytes: flacBytes, albumId: album.albumId }
    mp3 = { id: `tr-${album.tracks[1]!.recordingId}`, bytes: mp3Bytes }

    const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#335577' } }).png().toBuffer()
    coverId = (await storeImage(png, { kind: 'cover', source: 'test' })).id
    await db.update(albums).set({ artworkAssetId: coverId }).where(eq(albums.id, album.albumId))

    await db.insert(lyrics).values([
      { recordingId: album.tracks[0]!.recordingId, source: 'sidecar', synced: '[ar:Mira Vale]\n[offset:+250]\n[00:01.50]First line\n[00:00.20][00:03.000]Twice\n', plain: 'First line\nTwice' },
      { recordingId: album.tracks[1]!.recordingId, source: 'lrclib', plain: 'Only words\n\nAnd more' },
    ])
  })
  afterAll(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  async function probe(response: LightMyRequestResponse): Promise<Probe> {
    const file = path.join(scratch, `${Math.random().toString(36).slice(2)}.bin`)
    await writeFile(file, response.rawPayload)
    return await runFfprobe(file) as Probe
  }

  const get = (endpoint: string, params: Record<string, string | number>, headers?: Record<string, string>) =>
    client.raw(endpoint, params, { headers })

  it('streams the original with Range, and HEAD without a body', async () => {
    const whole = await get('stream', { id: flac.id })
    expect(whole.statusCode).toBe(200)
    expect(whole.headers).toMatchObject({ 'content-type': 'audio/flac', 'accept-ranges': 'bytes', 'content-length': String(flac.bytes.length) })
    expect(whole.rawPayload.equals(flac.bytes)).toBe(true)

    const part = await get('stream', { id: flac.id }, { range: 'bytes=100-199' })
    expect(part.statusCode).toBe(206)
    expect(part.headers['content-range']).toBe(`bytes 100-199/${flac.bytes.length}`)
    expect(part.rawPayload.equals(flac.bytes.subarray(100, 200))).toBe(true)

    const head = await app.inject({ method: 'HEAD', url: `/rest/stream.view?${new URLSearchParams({ u: 'mira', p: secret, id: flac.id })}` })
    expect(head.headers['content-length']).toBe(String(flac.bytes.length))
    expect(head.rawPayload.length).toBe(0)

    // format=raw always means the file as it is.
    expect((await get('stream', { id: flac.id, format: 'raw', maxBitRate: 96 })).rawPayload.equals(flac.bytes)).toBe(true)
    // A lossy file under the limit is not transcoded.
    expect((await get('stream', { id: mp3.id, maxBitRate: 320 })).rawPayload.equals(mp3.bytes)).toBe(true)
  })

  it('streams a file a provider delivered, though no list shows it', async () => {
    const [file] = await db.select({ id: mediaFiles.id, source: mediaFiles.source }).from(mediaFiles).where(eq(mediaFiles.relPath, 'Mira Vale/Blue Hour/01 Night.flac'))
    await db.update(mediaFiles).set({ source: 'provider:deezer' }).where(eq(mediaFiles.id, file!.id))
    try {
      const whole = await get('stream', { id: flac.id })
      expect(whole.statusCode).toBe(200)
      expect(whole.rawPayload.equals(flac.bytes)).toBe(true)
      const album = (await client.json('getAlbum', { id: `al-${flac.albumId}` })).album
      expect(album.song.map((song: { id: string }) => song.id)).toEqual([mp3.id])
    } finally {
      await db.update(mediaFiles).set({ source: file!.source }).where(eq(mediaFiles.id, file!.id))
    }
  })

  it('transcodes to the best profile under maxBitRate, then serves the cached copy with Range', async () => {
    const live = await get('stream', { id: flac.id, maxBitRate: 256 })
    expect(live.statusCode).toBe(200)
    expect(live.headers['content-type']).toBe('audio/mpeg')
    const info = await probe(live)
    expect(info.streams[0]!.codec_name).toBe('mp3')
    expect(Number(info.format.bit_rate)).toBeGreaterThan(180_000)
    expect(Number(info.format.bit_rate)).toBeLessThan(200_000)
    expect(Number(info.format.duration)).toBeCloseTo(6, 0)

    for (let attempt = 0; attempt < 50; attempt++) {
      const [row] = await db.select().from(transcodes).where(and(eq(transcodes.profile, 'mp3_192'), eq(transcodes.status, 'ready')))
      if (row) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const cached = await get('stream', { id: flac.id, maxBitRate: 256 }, { range: 'bytes=0-99' })
    expect(cached.statusCode).toBe(206)
    expect(cached.rawPayload.equals(live.rawPayload.subarray(0, 100))).toBe(true)
  })

  it('encodes live below every profile, in the requested format', async () => {
    const low = await get('stream', { id: flac.id, maxBitRate: 96 })
    expect(low.headers['accept-ranges']).toBe('none')
    const lowInfo = await probe(low)
    expect(lowInfo.streams[0]!.codec_name).toBe('mp3')
    expect(Number(lowInfo.format.bit_rate)).toBeLessThan(110_000)

    const opus = await get('stream', { id: mp3.id, format: 'opus' })
    expect(opus.headers['content-type']).toBe('audio/ogg')
    expect((await probe(opus)).streams[0]!.codec_name).toBe('opus')
  })

  it('starts at timeOffset (transcodeOffset)', async () => {
    const response = await get('stream', { id: flac.id, timeOffset: 4 })
    expect(response.headers['content-type']).toBe('audio/mpeg')
    const info = await probe(response)
    expect(Number(info.format.duration)).toBeGreaterThan(1.5)
    expect(Number(info.format.duration)).toBeLessThan(2.5)
  })

  it('sets an estimated Content-Length when asked, and keeps the body to it', async () => {
    const response = await get('stream', { id: flac.id, maxBitRate: 64, estimateContentLength: 'true' })
    const expected = Math.ceil(6 * 64_000 / 8)
    expect(response.headers['content-length']).toBe(String(expected))
    expect(response.rawPayload.length).toBe(expected)
    expect((await probe(response)).streams[0]!.codec_name).toBe('mp3')
  })

  it('sends no audio from a file whose content makes ffmpeg read another file', async () => {
    await makeTone(root, { path: 'hostile/real.flac', durationSec: 2 })
    await writeHostileInputs(path.join(root, 'hostile'), { target: 'real.flac', url: 'http://127.0.0.1:9' })
    const [night] = await db.select().from(mediaFiles).where(eq(mediaFiles.relPath, 'Mira Vale/Blue Hour/01 Night.flac'))
    const album = await createAlbum({ title: 'Hostile', owned: true, rootId: night!.rootId, tracks: [{ title: 'Script' }] })
    await db.update(mediaFiles).set({ relPath: 'hostile/concat.flac', durationMs: 6000 }).where(eq(mediaFiles.id, album.tracks[0]!.fileId!))
    const response = await get('stream', { id: `tr-${album.tracks[0]!.recordingId}`, maxBitRate: 96 })
    expect(response.rawPayload.length).toBe(0)
  })

  it('counts live encodes against the transcode slots and per user, and gives them back', async () => {
    // Long enough that an unread encode stalls on the pipe instead of finishing.
    await makeTone(root, { path: 'long/tone.flac', durationSec: 120 })
    const [night] = await db.select().from(mediaFiles).where(eq(mediaFiles.relPath, 'Mira Vale/Blue Hour/01 Night.flac'))
    const album = await createAlbum({ title: 'Long', owned: true, rootId: night!.rootId, tracks: [{ title: 'Long' }] })
    const [file] = await db.update(mediaFiles).set({ relPath: 'long/tone.flac', durationMs: 120_000 }).where(eq(mediaFiles.id, album.tracks[0]!.fileId!)).returning()
    const plan = planStream(file!, { maxBitRateKbps: 96 })
    if (plan.kind !== 'live') throw new Error('expected a live encode')
    const other = (await createUser({ username: 'noor' })).id
    const open: Readable[] = []
    const close = async () => {
      for (const stream of open.splice(0)) {
        stream.destroy()
        await once(stream, 'close')
      }
    }
    try {
      setTranscodeSlotLimit(2)
      open.push(await liveEncode(file!, plan, userId), await liveEncode(file!, plan, other))
      await expect(liveEncode(file!, plan, userId)).rejects.toMatchObject({ status: 503, code: 'transcoder_busy' })
      const busy = await client.json('stream', { id: `tr-${album.tracks[0]!.recordingId}`, maxBitRate: 96 })
      expect(busy.error).toMatchObject({ code: 0, message: expect.stringMatching(/try again/) })
      await close()
      // The slots came back once the encoders were gone.
      open.push(await liveEncode(file!, plan, userId), await liveEncode(file!, plan, other))
      await close()

      setTranscodeSlotLimit(20)
      for (let count = 0; count < LIVE_ENCODES_PER_USER; count++) open.push(await liveEncode(file!, plan, userId))
      await expect(liveEncode(file!, plan, userId)).rejects.toMatchObject({ status: 429, code: 'too_many_live_encodes' })
      open.push(await liveEncode(file!, plan, other))
      await close()
      open.push(await liveEncode(file!, plan, userId))
    } finally {
      await close()
      setTranscodeSlotLimit(null)
    }
  })

  it('downloads the original as an attachment', async () => {
    const response = await get('download', { id: flac.id })
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename=/)
    expect(response.rawPayload.equals(flac.bytes)).toBe(true)
  })

  it('reports songs it cannot stream as Subsonic errors', async () => {
    const response = await client.json('stream', { id: `tr-${flac.albumId}` })
    expect(response.error.code).toBe(70)
    await db.update(mediaFiles).set({ relPath: 'Mira Vale/Blue Hour/gone.flac' }).where(eq(mediaFiles.relPath, 'Mira Vale/Blue Hour/02 Day.mp3'))
    expect((await client.json('stream', { id: mp3.id })).error.code).toBe(70)
    expect((await client.json('stream', { id: mp3.id, timeOffset: 2 })).error).toBeDefined()
  })

  it('serves cover art at the requested size, by cover, album or song id', async () => {
    const original = await get('getCoverArt', { id: `ca-${coverId}` })
    expect(original.headers['content-type']).toBe('image/png')
    expect(original.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect((await sharp(original.rawPayload).metadata()).width).toBe(800)

    for (const [size, width] of [[300, 300], [500, 600], [2000, 1200], [40, 96]] as const) {
      const sized = await get('getCoverArt', { id: `ca-${coverId}`, size })
      expect(sized.headers['content-type']).toBe('image/webp')
      expect((await sharp(sized.rawPayload).metadata()).width).toBe(width)
    }
    for (const id of [`al-${flac.albumId}`, flac.id]) {
      const byEntity = await get('getCoverArt', { id, size: 300 })
      expect(byEntity.headers['content-type']).toBe('image/webp')
      expect(byEntity.headers['cache-control']).toBe('public, max-age=3600')
    }
    expect((await client.json('getCoverArt', { id: `ar-${artistId}` })).error.code).toBe(70)
    await db.update(artists).set({ imageAssetId: coverId }).where(eq(artists.id, artistId))
    expect((await get('getCoverArt', { id: `ar-${artistId}`, size: 96 })).headers['content-type']).toBe('image/webp')
    expect((await client.json('getCoverArt', { id: `ca-${flac.albumId}` })).error.code).toBe(70)
    expect((await client.json('getCoverArt', { id: 'nonsense' })).error.code).toBe(70)
  })

  it('returns synced lyrics by song id, and plain lyrics by artist and title', async () => {
    const synced = (await client.call('getLyricsBySongId', { id: flac.id })).lyricsList.structuredLyrics
    expect(synced).toEqual([{
      displayArtist: expect.any(String), displayTitle: 'Night', lang: 'und', offset: 250, synced: true,
      line: [{ start: 200, value: 'Twice' }, { start: 1500, value: 'First line' }, { start: 3000, value: 'Twice' }],
    }])
    const plain = (await client.call('getLyricsBySongId', { id: mp3.id })).lyricsList.structuredLyrics
    expect(plain).toEqual([expect.objectContaining({ synced: false, line: [{ value: 'Only words' }, { value: '' }, { value: 'And more' }] })])
    const xml = (await client.raw('getLyricsBySongId', { id: flac.id })).body
    expect(xml).toContain('<line start="200">Twice</line>')

    const [artist] = await db.select({ name: artists.name }).from(artists).where(eq(artists.id, artistId))
    const classic = (await client.call('getLyrics', { artist: artist!.name, title: 'night' })).lyrics
    expect(classic).toEqual({ artist: artist!.name, title: 'Night', value: 'First line\nTwice' })
    expect((await client.call('getLyrics', { artist: 'Someone Else', title: 'Night' })).lyrics).toEqual({ artist: 'Someone Else', title: 'Night' })
  })

  it('describes the real file in song objects', async () => {
    const { song } = await client.call('getSong', { id: flac.id })
    expect(song).toMatchObject({ suffix: 'flac', contentType: 'audio/flac', size: flac.bytes.length, duration: 6, path: 'Mira Vale/Blue Hour/01 Night.flac' })
    expect((await stat(path.join(root, song.path))).size).toBe(flac.bytes.length)
  })
})
