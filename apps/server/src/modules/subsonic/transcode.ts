/**
 * What `stream` sends for `format`, `maxBitRate` and `timeOffset`.
 *
 * - `format=raw`, or nothing that asks for a change: the original file, with Range.
 * - A format other than the file's codec, or a file above `maxBitRate`: the best
 *   streaming profile of that codec (MP3 when none is named) within the limit. Profiles
 *   are cached by the streaming module, so a repeated request gets Range too.
 * - A limit below every profile of the codec, or a `timeOffset` (the transcodeOffset
 *   extension): a live encode at that bitrate from that offset, not cached.
 */
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { PassThrough, Readable, Transform } from 'node:stream'
import { getConfig } from '../../config.js'
import { notFound } from '../../lib/errors.js'
import { audioInput } from '../../lib/ffmpeg.js'
import { libraryPath } from '../streaming/files.js'
import { transcoderBusy, tryAcquireSlot } from '../streaming/transcode.js'
import { codecFamily, outputSampleRate, profiles, type MediaFile, type TranscodeProfile } from '../streaming/profiles.js'

export type Codec = 'mp3' | 'opus' | 'aac'

export type StreamPlan =
  | { kind: 'original' }
  | { kind: 'profile'; profile: TranscodeProfile }
  | { kind: 'live'; codec: Codec; bitrate: number; offsetSeconds: number }

/** Profiles per codec, best first. */
const codecProfiles: Record<Codec, TranscodeProfile[]> = { mp3: ['mp3_320', 'mp3_192'], opus: ['opus_128'], aac: ['aac_256'] }

const formatCodecs: Record<string, Codec> = { mp3: 'mp3', opus: 'opus', ogg: 'opus', oga: 'opus', aac: 'aac', m4a: 'aac', adts: 'aac' }

/** The lowest bitrate a live encode is asked for; below this the encoders refuse or sound broken. */
const MIN_BITRATE = 32_000

export function planStream(
  file: Pick<MediaFile, 'codec' | 'container' | 'relPath' | 'lossless' | 'bitrate'>,
  request: { format?: string; maxBitRateKbps?: number; timeOffsetSeconds?: number },
): StreamPlan {
  const format = request.format?.trim().toLowerCase()
  if (format === 'raw') return { kind: 'original' }
  const limit = request.maxBitRateKbps ? request.maxBitRateKbps * 1000 : null
  const offsetSeconds = Math.max(0, request.timeOffsetSeconds ?? 0)
  const requested = format ? formatCodecs[format] : undefined
  const family = codecFamily(file)
  const overLimit = limit !== null && (file.lossless || !file.bitrate || file.bitrate > limit)
  const changeCodec = requested !== undefined && requested !== family
  if (!overLimit && !changeCodec && offsetSeconds === 0) return { kind: 'original' }

  const codec = requested ?? (!overLimit && family in codecProfiles ? family as Codec : 'mp3')
  const profile = codecProfiles[codec].find((candidate) => limit === null || profiles[candidate].bitrate <= limit)
  if (profile && offsetSeconds === 0) return { kind: 'profile', profile }
  // A live encode spends no more than the limit, the codec's best profile, or a lossy source has.
  const source = file.lossless || !file.bitrate ? Infinity : file.bitrate
  const ceiling = Math.min(limit ?? Infinity, profiles[codecProfiles[codec][0]!].bitrate, source)
  return { kind: 'live', codec, bitrate: Math.round(Math.max(MIN_BITRATE, ceiling) / 1000) * 1000, offsetSeconds }
}

/** The MIME type a live encode is sent with. */
export const liveMime = (codec: Codec) => profiles[codecProfiles[codec][0]!].mime

/** Live encodes one user may run at once: a player and a prefetch, with room for a seek. */
export const LIVE_ENCODES_PER_USER = 3

/**
 * Encodes `file` from `offsetSeconds` at `bitrate` and streams it as it is produced.
 * The encoder is the streaming profile's, with its bitrate replaced; it is killed when
 * the client goes away. It runs in one of the streaming module's encoder slots, taken
 * without waiting: a client asking for a live encode is waiting for its first bytes.
 * Throws 503 `transcoder_busy` when no slot is free and 429 `too_many_live_encodes` when
 * the user already runs LIVE_ENCODES_PER_USER.
 */
export async function liveEncode(file: MediaFile, plan: Extract<StreamPlan, { kind: 'live' }>, userId: string): Promise<Readable> {
  const release = tryAcquireSlot(userId, LIVE_ENCODES_PER_USER)
  if (!release) throw transcoderBusy()
  try {
    const input = await libraryPath(file)
    await stat(input).catch(() => {
      throw notFound('The file is missing from disk', 'file_missing')
    })
    const base = codecProfiles[plan.codec][0]!
    const args = [...profiles[base].args]
    args[args.indexOf('-b:a') + 1] = `${Math.round(plan.bitrate / 1000)}k`
    const sampleRate = outputSampleRate(file, base)
    const child = spawn(getConfig().FFMPEG_PATH, [
      '-v', 'error', '-nostdin',
      ...(plan.offsetSeconds > 0 ? ['-ss', String(plan.offsetSeconds)] : []),
      ...audioInput(input),
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      ...(sampleRate ? ['-ar', String(sampleRate)] : []),
      ...args,
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    const exited = new Promise<void>((resolve) => child.once('close', () => {
      release()
      resolve()
    }))
    const output = new PassThrough({
      destroy(error, callback) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        // Keep the slot reserved until ffmpeg has actually stopped.
        void exited.then(() => callback(error))
      },
    })
    child.stdout.pipe(output)
    child.once('error', (error) => output.destroy(error))
    return output
  } catch (error) {
    release()
    throw error
  }
}

/**
 * Makes a stream exactly `bytes` long, for `estimateContentLength`: an estimate that
 * turns out too long is padded with zeros, which MP3, ADTS and Ogg decoders skip as
 * junk; one too short is cut. Either way the body matches its Content-Length.
 */
export function exactLength(source: Readable, bytes: number): Readable {
  let sent = 0
  const shaped = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const room = bytes - sent
      if (room <= 0) return done()
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk
      sent += part.length
      done(null, part)
    },
    flush(done) {
      const missing = bytes - sent
      done(null, missing > 0 ? Buffer.alloc(missing) : undefined)
    },
  })
  source.once('error', (error) => shaped.destroy(error))
  shaped.once('close', () => source.destroy())
  return source.pipe(shaped)
}
