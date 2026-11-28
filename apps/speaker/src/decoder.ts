import type { EngineMedia } from '@squirmy/client-core'
import type { StreamProfile } from '@squirmy/contracts'
import { type ChildProcess, spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { bytesPerFrame, type PcmFormat } from './pcm.js'

/** What one entry's decode starts from. */
export type DecodeRequest = {
  url: string
  /** The frame of the track, at `format.sampleRate`, the first frame read is. */
  startFrame: number
  format: PcmFormat
  media?: EngineMedia
}

/**
 * PCM of one entry from `startFrame` on, in `format`, trimmed to the track's real length.
 * `read` gives whole frames; null at the end. It rejects when the stream fails, and the
 * engine starts a new decoder where this one stopped.
 */
export interface Decoder {
  read(): Promise<Buffer | null>
  close(): void
}

export type DecoderFactory = (request: DecodeRequest) => Decoder

/** Decoded audio held per decoder before ffmpeg is paused: a few seconds, so the next song is ready well before its turn. */
const HIGH_WATER_SECONDS = 4

/** The server's fragmented MP4 transcodes, which carry no edit list and seek with `start`. */
const FRAGMENTED = new Set<StreamProfile>(['flac_mp4', 'opus_mp4_192', 'opus_mp4_96', 'aac_mp4_256', 'aac_mp4_128'])

/** The server's header naming the frame a live transcode that started at `start` really starts on. */
const START_FRAME_HEADER = 'x-squirmy-start-frame'

/**
 * How a stream is opened and trimmed.
 *
 * - **Originals** go to ffmpeg by URL, which seeks with Range requests and applies the file's
 *   own gapless information (MP3's LAME tag, MP4 edit lists, Opus pre-skip), the same decode
 *   the server measured `gapless.frames` with.
 * - **Fragmented MP4 transcodes** (`flac_mp4`, `opus_mp4_*`, `aac_mp4_*`) carry no edit list.
 *   They are fetched here, seeking with the URL's `start` and the `X-Squirmy-Start-Frame`
 *   answer, and piped to ffmpeg; the encoder's priming is dropped from the decoded stream,
 *   except Opus's, which ffmpeg drops itself from the `dOps` box.
 * - Either way the end is cut at `gapless.frames`, unless that would cut more than a quarter
 *   of a second: then the numbers are wrong and the whole decode plays.
 */
export function planDecode(request: DecodeRequest) {
  const { media, format } = request
  const gapless = media?.gapless ?? null
  const ratio = gapless ? format.sampleRate / gapless.sampleRate : 1
  const fragmented = media?.transcoded === true && media.profile !== undefined && FRAGMENTED.has(media.profile)
  const priming = fragmented && gapless && media?.codec !== 'opus' ? Math.round(gapless.primingFrames * ratio) : 0
  const totalFrames = gapless ? Math.ceil(gapless.frames * ratio) : null
  return {
    fragmented,
    priming,
    limit: totalFrames === null ? null : Math.max(0, totalFrames - request.startFrame),
    tolerance: Math.round(format.sampleRate / 4),
  }
}

export type FfmpegOptions = {
  /** Defaults to `FFMPEG_PATH`, else `ffmpeg` on the PATH. */
  ffmpegPath?: string
  fetch?: typeof globalThis.fetch
  /** ffmpeg's errors, for the log. */
  onLog?: (line: string) => void
}

/** Decodes with ffmpeg, as `planDecode` describes. */
export function ffmpegDecoder(options: FfmpegOptions = {}): DecoderFactory {
  return request => new FfmpegDecoder(request, options)
}

const pcmCodec = (format: PcmFormat) => (format.encoding === 's16le' ? 'pcm_s16le' : 'pcm_s32le')

class FfmpegDecoder implements Decoder {
  private readonly frameBytes: number
  private readonly highWater: number
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private remainder = Buffer.alloc(0)
  private ended = false
  private failure: Error | null = null
  private waiting: (() => void) | null = null
  private process: ChildProcess | null = null
  private readonly abort = new AbortController()
  private closed = false
  /** Frames still to drop from the start (priming, and a live seek's lead-in). */
  private drop: number
  /** Frames left before the track's end; null when the length is unknown or proved wrong. */
  private limit: number | null
  /** Frames past `limit`, held until the stream shows whether they are padding or music. */
  private held: Buffer[] = []
  private heldFrames = 0
  private readonly tolerance: number

  constructor(private readonly request: DecodeRequest, private readonly options: FfmpegOptions) {
    this.frameBytes = bytesPerFrame(request.format)
    this.highWater = HIGH_WATER_SECONDS * request.format.sampleRate * this.frameBytes
    const plan = planDecode(request)
    this.drop = plan.priming
    this.limit = plan.limit
    this.tolerance = plan.tolerance
    void this.start(plan.fragmented).catch(error => this.fail(error))
  }

  private async start(fragmented: boolean) {
    const { request } = this
    const { format } = request
    const output = ['-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', String(format.channels), '-ar', String(format.sampleRate), '-c:a', pcmCodec(format), '-f', format.encoding, 'pipe:1']
    const quiet = ['-hide_banner', '-nostats', '-loglevel', 'error']
    let input: string[]
    let body: Readable | null = null
    if (fragmented) {
      const url = new URL(request.url)
      const startMs = Math.floor((request.startFrame * 1000) / format.sampleRate)
      if (startMs > 0) url.searchParams.set('start', String(startMs))
      const response = await (this.options.fetch ?? fetch)(url, { signal: this.abort.signal })
      if (!response.ok || !response.body) throw new Error(`The stream answered ${response.status}`)
      // Where the stream starts, at the delivered rate. A server that ignored `start` starts at 0.
      const delivered = Number(response.headers.get(START_FRAME_HEADER) ?? 0)
      const ratio = request.media?.gapless ? format.sampleRate / request.media.gapless.sampleRate : 1
      const startsAt = Number.isFinite(delivered) ? Math.round(delivered * ratio) : 0
      this.drop += Math.max(0, request.startFrame - startsAt)
      body = Readable.fromWeb(response.body as never)
      input = ['-i', 'pipe:0']
    } else {
      const seconds = request.startFrame / format.sampleRate
      const http = /^https?:/i.test(request.url)
        // Reconnects ride out a dropped connection; the read timeout turns a stalled one into an error the engine retries.
        ? ['-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000']
        : []
      input = [...http, ...(seconds > 0 ? ['-ss', seconds.toFixed(6)] : []), '-i', request.url]
    }
    if (this.closed) return
    const child = spawn(this.options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg', [...(body ? [] : ['-nostdin']), ...quiet, ...input, ...output], {
      stdio: [body ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    this.process = child
    let errors = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (text: string) => {
      errors = (errors + text).slice(-2000)
      for (const line of text.split('\n')) if (line.trim()) this.options.onLog?.(line.trim())
    })
    if (body) {
      child.stdin!.on('error', () => {})
      body.on('error', error => {
        if (!this.closed) this.fail(error)
      })
      body.pipe(child.stdin!)
    }
    child.stdout!.on('data', (chunk: Buffer) => this.take(chunk))
    child.on('error', error => this.fail(error))
    child.on('close', code => {
      if (this.closed) return
      if (code === 0) this.finish()
      else this.fail(new Error(errors.trim().split('\n').pop() || `ffmpeg exited with ${code}`))
    })
  }

  private take(data: Buffer) {
    const joined = this.remainder.length ? Buffer.concat([this.remainder, data]) : data
    const whole = joined.length - (joined.length % this.frameBytes)
    this.remainder = Buffer.from(joined.subarray(whole))
    let chunk = joined.subarray(0, whole)
    if (this.drop > 0) {
      const dropped = Math.min(this.drop, chunk.length / this.frameBytes)
      this.drop -= dropped
      chunk = chunk.subarray(dropped * this.frameBytes)
    }
    if (chunk.length === 0) return
    if (this.limit !== null) {
      const frames = chunk.length / this.frameBytes
      const keep = Math.min(frames, this.limit)
      this.limit -= keep
      if (keep < frames) {
        this.held.push(chunk.subarray(keep * this.frameBytes))
        this.heldFrames += frames - keep
        chunk = chunk.subarray(0, keep * this.frameBytes)
        if (this.heldFrames > this.tolerance) {
          // More than padding follows the stated end: the length was wrong, so play all of it.
          this.limit = null
          this.push(chunk)
          for (const extra of this.held.splice(0)) this.push(extra)
          this.heldFrames = 0
          return
        }
      }
    }
    this.push(chunk)
  }

  private push(chunk: Buffer) {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.bytes += chunk.length
    if (this.bytes >= this.highWater) this.process?.stdout?.pause()
    this.wake()
  }

  private finish() {
    this.ended = true
    this.wake()
  }

  private fail(error: unknown) {
    if (this.closed || this.ended) return
    this.failure = error instanceof Error ? error : new Error(String(error))
    this.wake()
  }

  private wake() {
    const waiting = this.waiting
    this.waiting = null
    waiting?.()
  }

  async read(): Promise<Buffer | null> {
    for (;;) {
      const chunk = this.chunks.shift()
      if (chunk) {
        this.bytes -= chunk.length
        if (this.bytes < this.highWater / 2) this.process?.stdout?.resume()
        return chunk
      }
      if (this.failure) throw this.failure
      if (this.ended || this.closed) return null
      await new Promise<void>(resolve => { this.waiting = resolve })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    this.process?.kill('SIGKILL')
    this.chunks.length = 0
    this.wake()
  }
}
