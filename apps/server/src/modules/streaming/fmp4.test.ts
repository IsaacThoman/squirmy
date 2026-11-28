import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { PlaybackDescriptor } from '@squirmy/contracts'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { mediaFiles, transcodes } from '../../database/schema.js'
import { makeSplitTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot } from '../../test/factories.js'
import { measureLoudness } from '../loudness/measure.js'
import { sampleDurations } from './mp4.js'
import { cacheRoot, isTranscoding, setTranscodeSlotLimit } from './transcode.js'

const encoder = vi.hoisted(() => ({ throttle: false }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    const command = args[1]
    if (!encoder.throttle || !Array.isArray(command) || !command.includes('-progress') || command.includes('-ss')) return actual.spawn(...args)
    const input = command.indexOf('-i')
    return actual.spawn(args[0], [...command.slice(0, input), '-readrate', '0.5', ...command.slice(input)], args[2])
  }) as typeof actual.spawn
  return { ...actual, spawn }
})

const exec = promisify(execFile)
const execOptions = { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 } as const

/** How many packets of each duration the file's audio has. */
async function packetDurations(file: string) {
  const { stdout } = await exec(process.env.FFPROBE_PATH ?? 'ffprobe', [
    '-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pts,duration', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' })
  const packets = stdout.trim().split('\n').map((line) => line.split(',').map(Number) as [number, number])
  // Some ffprobe builds report no packet duration (N/A) for a fragment written as it streams;
  // the step to the next packet's timestamp is the same number.
  return packets.map(([pts, duration], index) => (Number.isFinite(duration) ? duration : (packets[index + 1]?.[0] ?? NaN) - pts))
}

async function decode(file: string, rate: number) {
  const { stdout } = await exec(process.env.FFMPEG_PATH ?? 'ffmpeg', [
    '-v', 'error', '-i', file, '-ar', String(rate), '-acodec', 'pcm_f32le', '-f', 'f32le', '-',
  ], execOptions)
  return new Float32Array(Uint8Array.from(stdout).buffer)
}

/** Match both channels around a boundary. The two chirps sweep at different rates. */
function lag(actual: Float32Array, actualFrame: number, reference: Float32Array, referenceFrame: number) {
  let winner = 0
  let highest = -Infinity
  for (let shift = -8; shift <= 8; shift++) {
    let both = 0
    let energy = 0
    for (let index = 0; index < 2048; index++) {
      const sample = actual[2 * actualFrame + index]!
      const target = reference[2 * (referenceFrame + shift) + index]!
      both += sample * target
      energy += target * target
    }
    const score = both / Math.sqrt(energy)
    if (score > highest) {
      highest = score
      winner = shift
    }
  }
  expect(highest).toBeGreaterThan(0.4)
  return winner
}

function finalPacketDuration(bytes: Buffer) {
  let fragment: Buffer | undefined
  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset)
    if (size < 8 || offset + size > bytes.length) throw new Error('Incomplete top-level MP4 box')
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'moof') fragment = bytes.subarray(offset, offset + size)
    offset += size
  }
  if (!fragment) throw new Error('No MP4 fragments in the stream')
  const { first, last } = sampleDurations(fragment)
  return fragment.readUInt32BE(last ?? first)
}

describe('fragmented MP4 delivery', () => {
  useTestDatabase()
  let app: FastifyInstance
  let root: string
  let rootId: string
  let headers: { authorization: string }
  let flac: Awaited<ReturnType<typeof source>>
  let alac: Awaited<ReturnType<typeof source>>
  let aac: Awaited<ReturnType<typeof source>>
  let mp3: Awaited<ReturnType<typeof source>>

  async function source(format: 'flac' | 'm4a' | 'mp3' | 'alac', name: string = format, rate = 44_100) {
    const fixture = await makeSplitTone(path.join(root, name), { format, rate })
    const { tracks } = await createAlbum({ owned: true, rootId, tracks: [{ title: 'First' }, { title: 'Second' }] })
    const lengths: number[] = []
    for (const [index, file] of fixture.halves.entries()) {
      const measured = await measureLoudness(file)
      // Before FFmpeg applied AAC end trimming in the demuxer, the source decoded
      // to the packet boundary. Remuxes describe what the original actually decodes.
      if (format !== 'm4a') expect(measured.decodedFrames).toBe(fixture.frames[index])
      lengths.push(measured.decodedFrames)
      await db.update(mediaFiles).set({
        relPath: path.relative(root, file), size: (await stat(file)).size,
        container: format === 'm4a' || format === 'alac' ? 'mp4' : format, codec: format === 'm4a' ? 'aac' : format,
        lossless: format === 'flac' || format === 'alac', sampleRate: fixture.rate, bitDepth: format === 'flac' || format === 'alac' ? 24 : null,
        durationMs: Math.round(measured.decodedFrames * 1000 / fixture.rate),
        decodedFrames: measured.decodedFrames, decodedRate: measured.decodedRate,
        primingFrames: measured.primingFrames, paddingFrames: measured.paddingFrames,
      }).where(eq(mediaFiles.id, tracks[index]!.fileId!))
    }
    return { fixture, tracks, lengths }
  }

  beforeAll(async () => {
    app = await buildApp()
    const setup = await app.inject({
      method: 'POST', url: '/api/v1/setup', payload: { username: 'root', password: 'root password' },
    })
    headers = { authorization: `Bearer ${setup.json().token}` }
    root = await mkdtemp(path.join(tmpdir(), 'squirmy-fmp4-'))
    rootId = (await createLibraryRoot({ path: root })).id
    flac = await source('flac')
    alac = await source('alac')
    aac = await source('m4a')
    mp3 = await source('mp3')
  })
  afterAll(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  async function descriptor(trackId: string, query: string) {
    const response = await app.inject({
      url: `/api/v1/tracks/${trackId}/playback?containers=fmp4&${query}`, headers,
    })
    expect(response.statusCode).toBe(200)
    return PlaybackDescriptor.parse(response.json())
  }

  it.each([
    { profile: 'flac_mp4', query: 'codecs=aac,flac&engine=native', input: 'alac', rate: 44100, priming: 0, packet: 0 },
    { profile: 'opus_mp4_192', query: 'quality=high&codecs=opus,flac', input: 'flac', rate: 48000, priming: 312, packet: 960 },
    { profile: 'opus_mp4_192', query: 'quality=high&codecs=opus', input: 'm4a', rate: 48000, priming: 312, packet: 960 },
    { profile: 'opus_mp4_96', query: 'quality=data_saver&codecs=opus,flac', input: 'flac', rate: 48000, priming: 312, packet: 960 },
    { profile: 'aac_mp4_256', query: 'quality=high&codecs=aac,flac', input: 'flac', rate: 44100, priming: 1024, packet: 1024 },
    { profile: 'aac_mp4_128', query: 'quality=data_saver&codecs=aac,flac', input: 'flac', rate: 44100, priming: 1024, packet: 1024 },
    { profile: 'copy_mp4', query: 'codecs=aac,flac', input: 'flac', rate: 44100, priming: 0, packet: 0 },
    { profile: 'copy_mp4', query: 'codecs=aac,flac', input: 'm4a', rate: 44100, priming: 1024, packet: 1024 },
    { profile: 'copy_mp4', query: 'codecs=aac,mp3_mp4', input: 'mp3', rate: 44100, priming: 1105, packet: 1152 },
  ])('joins $input halves through $profile, live and cached', async ({ profile, query, input, rate, priming, packet }) => {
    const { tracks, fixture } = input === 'm4a' ? aac : input === 'mp3' ? mp3 : input === 'alac' ? alac : flac
    const reference = await decode(fixture.whole, rate)
    const expectedBoundary = Math.round(fixture.frames[0] * rate / fixture.rate)
    const tolerance = rate === fixture.rate ? 0 : 1
    const joinedFrames = { live: 0, cached: 0 }
    for (const [index, track] of tracks.entries()) {
      const playback = await descriptor(track.recordingId, query)
      const frames = Math.ceil(fixture.frames[index]! * rate / fixture.rate)
      expect(playback).toMatchObject({ profile, mime: 'audio/mp4', bytes: null, gapless: { sampleRate: rate, primingFrames: priming, frames } })
      const live = await app.inject({ url: playback.url })
      expect(live.statusCode).toBe(200)
      expect(live.headers['accept-ranges']).toBe('none')

      const ready = await descriptor(track.recordingId, query)
      const cached = await app.inject({ url: playback.url, headers: { range: `bytes=0-${live.rawPayload.length - 1}` } })
      expect(cached.statusCode).toBe(206)
      expect(cached.headers['accept-ranges']).toBe('bytes')
      expect(ready.bytes).toBe(live.rawPayload.length)
      expect(cached.rawPayload.equals(live.rawPayload)).toBe(true)

      for (const [kind, bytes] of [['live', live.rawPayload], ['cached', cached.rawPayload]] as const) {
        const file = path.join(root, `${input}-${profile}-${index}-${kind}.mp4`)
        await writeFile(file, bytes)
        expect(bytes.includes(Buffer.from('elst'))).toBe(false)
        const decoded = await decode(file, rate)
        // FFmpeg applies Opus pre-skip from dOps itself. AAC and MP3 here have no edit list.
        const applied = rate === 48000 ? priming : 0
        if (applied) {
          const dOps = bytes.indexOf(Buffer.from('dOps'))
          expect(dOps).toBeGreaterThan(0)
          expect(bytes.readUInt16BE(dOps + 6)).toBe(priming)
        }
        const delay = priming - applied
        expect(decoded.length / 2 - delay).toBeGreaterThanOrEqual(frames)
        if (packet) {
          expect(finalPacketDuration(bytes)).toBe(packet)
          expect(decoded.length / 2 - delay - frames).toBeLessThan(packet)
        } else {
          expect(decoded.length / 2).toBe(frames)
        }
        const trimmed = decoded.subarray(delay * 2, (delay + frames) * 2)
        joinedFrames[kind] += trimmed.length / 2
        expect(Math.abs(lag(trimmed, 512, reference, (index ? expectedBoundary : 0) + 512))).toBeLessThanOrEqual(tolerance)
        const end = frames - 2048
        expect(Math.abs(lag(trimmed, end, reference, (index ? expectedBoundary : 0) + end))).toBeLessThanOrEqual(tolerance)
      }
    }
    const uncutFrames = reference.length / 2
    expect(Math.abs(joinedFrames.live - uncutFrames)).toBeLessThanOrEqual(tolerance)
    expect(Math.abs(joinedFrames.cached - uncutFrames)).toBeLessThanOrEqual(tolerance)
  })

  it.each([
    { inputRate: 32_000, aacRate: 32_000, flacRate: 32_000 },
    { inputRate: 48_000, aacRate: 48_000, flacRate: 48_000 },
    { inputRate: 88_200, aacRate: 44_100, flacRate: 88_200 },
    { inputRate: 96_000, aacRate: 48_000, flacRate: 96_000 },
    { inputRate: 176_400, aacRate: 44_100, flacRate: 176_400 },
    { inputRate: 192_000, aacRate: 48_000, flacRate: 192_000 },
    { inputRate: 352_800, aacRate: 44_100, flacRate: 176_400 },
    { inputRate: 384_000, aacRate: 48_000, flacRate: 192_000 },
  ])('preserves the playable frame count at $inputRate Hz', async ({ inputRate, aacRate, flacRate }) => {
    const { tracks, lengths } = await source('alac', `rate-${inputRate}`, inputRate)
    for (const [query, rate, delay, packet] of [
      ['quality=high&codecs=aac', aacRate, 1024, 1024],
      ['quality=high&codecs=opus', 48_000, 312, 960],
      ['quality=original&codecs=flac', flacRate, 0, 0],
    ] as const) {
      const playback = await descriptor(tracks[0]!.recordingId, query)
      const frames = Math.ceil(lengths[0]! * rate / inputRate)
      expect(playback.gapless).toEqual({ sampleRate: rate, primingFrames: delay, frames })
      if (delay === 0) expect(playback.bitDepth).toBe(24)
      const response = await app.inject({ url: playback.url })
      expect(response.statusCode).toBe(200)
      const file = path.join(root, `rate-${inputRate}-${playback.profile}.mp4`)
      await writeFile(file, response.rawPayload)
      const decoded = await decode(file, rate)
      const rawFrames = decoded.length / 2 + (delay === 312 ? delay : 0)
      expect(rawFrames).toBe(packet ? Math.ceil((frames + delay) / packet) * packet : frames)
    }
  })

  it('seeks at the requested sample while the full transcode is still running', async () => {
    const { tracks, fixture } = await source('alac', 'seek')
    const track = tracks[0]!
    const playback = await descriptor(track.recordingId, 'codecs=aac,flac')
    expect(playback.profile).toBe('flac_mp4')
    const row = async () => (await db.select().from(transcodes).where(and(
      eq(transcodes.fileId, track.fileId!), eq(transcodes.profile, playback.profile),
    )))[0]
    encoder.throttle = true
    setTranscodeSlotLimit(2)
    const full = app.inject({ url: playback.url, method: 'GET' }).then((result) => result)
    try {
      await expect.poll(async () => (await row())?.status).toBe('pending')
      const requested = 1234.5
      const frame = Math.round(requested * fixture.rate / 1000)
      const seek = await app.inject({ url: `${playback.url}&start=${requested}` })
      expect(seek.statusCode).toBe(200)
      expect(seek.headers).toMatchObject({
        'x-squirmy-start-frame': String(frame), 'cache-control': 'no-store', 'accept-ranges': 'none',
      })
      expect(isTranscoding(track.fileId!, playback.profile)).toBe(true)
      expect((await row())?.status).toBe('pending')
      const file = path.join(root, 'seek.mp4')
      await writeFile(file, seek.rawPayload)
      const decoded = await decode(file, fixture.rate)
      const reference = await decode(fixture.halves[0], fixture.rate)
      expect(decoded.length / 2).toBe(fixture.frames[0] - frame)
      expect(lag(decoded, 0, reference, frame)).toBe(0)
      // Fixed FLAC blocks, though the seek starts part way into the source's block.
      expect(new Set((await packetDurations(file)).slice(0, -1))).toEqual(new Set([4096]))
    } finally {
      await full
      encoder.throttle = false
      setTranscodeSlotLimit(null)
    }
    expect((await row())?.status).toBe('ready')
    await expect.poll(() => readdir(path.join(cacheRoot(), track.fileId!))).toEqual([path.basename((await row())!.storagePath)])
    expect((await app.inject({ url: `${playback.url}&start=99999` })).json().error.code).toBe('invalid_start')
  })

  it.each(['aac', 'mp3'] as const)('reports the actual preroll packet for a %s remux seek', async (codec) => {
    const { tracks, fixture } = codec === 'aac' ? aac : mp3
    const query = codec === 'aac' ? 'codecs=aac' : 'codecs=aac,mp3_mp4'
    const playback = await descriptor(tracks[0]!.recordingId, query)
    const requested = 1234.5
    const seek = await app.inject({ url: `${playback.url}&start=${requested}` })
    expect(seek.statusCode).toBe(200)
    const actual = Number(seek.headers['x-squirmy-start-frame'])
    expect(actual).toBeGreaterThan((requested - 250) * fixture.rate / 1000)
    expect(actual).toBeLessThanOrEqual((requested - 100) * fixture.rate / 1000)
    const file = path.join(root, `seek-${codec}.mp4`)
    await writeFile(file, seek.rawPayload)
    const decoded = await decode(file, fixture.rate)
    const reference = await decode(fixture.halves[0], fixture.rate)
    expect(lag(decoded, 4096, reference, actual + 4096)).toBe(0)
  })

  it('seeks at the requested position in the delivered clock after resampling', async () => {
    const { tracks, fixture } = flac
    const playback = await descriptor(tracks[0]!.recordingId, 'quality=high&codecs=opus')
    const requested = 1234.4
    const frame = Math.round(requested * 48)
    const seek = await app.inject({ url: `${playback.url}&start=${requested}` })
    expect(seek.statusCode).toBe(200)
    expect(seek.headers['x-squirmy-start-frame']).toBe(String(frame))
    const file = path.join(root, 'seek-opus.mp4')
    await writeFile(file, seek.rawPayload)
    const decoded = await decode(file, 48_000)
    const reference = await decode(fixture.whole, 48_000)
    expect(lag(decoded, 960, reference, frame + 960)).toBe(0)
  })
})
