import type { Decoder, DecoderFactory, DecodeRequest } from './decoder.js'
import { bytesPerFrame, type PcmFormat } from './pcm.js'
import type { PcmSink } from './sinks.js'

/**
 * A sound card for tests, on the engine's clock: what is written plays from the moment the
 * sink opens, at its sample rate, and closing it drops what had not played. `heard` is what
 * reached the speakers, in order, across every open.
 */
export class FakeSink implements PcmSink {
  readonly opens: PcmFormat[] = []
  private format: PcmFormat | null = null
  private pending = Buffer.alloc(0)
  /** Bytes of `pending` played, as of `at`. */
  private cursor = 0
  private at = 0
  private readonly played: Buffer[] = []
  private onError: ((error: Error) => void) | null = null

  constructor(private readonly now: () => number) {}

  open(format: PcmFormat, onError: (error: Error) => void): void {
    this.close()
    this.format = format
    this.opens.push(format)
    this.at = this.now()
    this.onError = onError
  }

  write(chunk: Buffer): void {
    if (!this.format) throw new Error('Write to a closed sink')
    this.progress()
    this.pending = Buffer.concat([this.pending, chunk])
  }

  close(): void {
    if (!this.format) return
    this.progress()
    this.played.push(this.pending.subarray(0, this.cursor))
    this.pending = Buffer.alloc(0)
    this.cursor = 0
    this.format = null
  }

  /** The device fails, as an unplugged DAC does. */
  fail(): void {
    this.close()
    this.onError?.(new Error('device gone'))
  }

  get isOpen(): boolean {
    return this.format !== null
  }

  /** Everything heard so far: closed opens in full, and the open one up to now. */
  heard(): Buffer {
    this.progress()
    return Buffer.concat([...this.played, this.pending.subarray(0, this.cursor)])
  }

  /** Plays on from `at` to now at the sample rate. Starved, it plays nothing, as a device that underruns. */
  private progress() {
    if (!this.format) return
    const now = this.now()
    const frames = Math.floor(((now - this.at) * this.format.sampleRate) / 1000)
    this.at += (frames * 1000) / this.format.sampleRate
    this.cursor = Math.min(this.pending.length, this.cursor + frames * bytesPerFrame(this.format))
  }
}

/**
 * Decodes a fake stream: `url` names a track in `tracks`, whose every frame carries its own
 * index in the left channel and the track's `id` in the right (32-bit), so a test can read back
 * exactly which frames played. Chunks come at once unless `hold` keeps them back.
 */
export class FakeDecoders {
  readonly requests: DecodeRequest[] = []
  /** Holds back reads past this many frames of a track (a slow network) until `release`. */
  readonly holds = new Map<string, number>()
  /** Fails the next decoder of a track after this many frames. */
  readonly failures = new Map<string, number>()
  chunkFrames = 4410
  private readonly waiters = new Set<() => void>()

  constructor(readonly tracks: Record<string, { id: number; frames: number }>) {}

  release(url: string): void {
    this.holds.delete(url)
    for (const waiter of [...this.waiters]) waiter()
  }

  readonly factory: DecoderFactory = request => {
    this.requests.push(request)
    const track = this.tracks[request.url]
    if (!track) throw new Error(`No fake track ${request.url}`)
    let frame = request.startFrame
    const failAfter = this.failures.get(request.url)
    if (failAfter !== undefined) this.failures.delete(request.url)
    let closed = false
    const decoder: Decoder = {
      read: async () => {
        for (;;) {
          if (closed || frame >= track.frames) return null
          const hold = this.holds.get(request.url)
          if (hold === undefined || frame < hold) break
          await new Promise<void>(resolve => {
            const wake = () => { this.waiters.delete(wake); resolve() }
            this.waiters.add(wake)
          })
        }
        if (failAfter !== undefined && frame >= request.startFrame + failAfter) throw new Error('connection reset')
        const hold = this.holds.get(request.url) ?? Infinity
        const count = Math.min(this.chunkFrames, track.frames - frame, hold - frame,
          failAfter === undefined ? Infinity : request.startFrame + failAfter - frame)
        const chunk = Buffer.alloc(count * 8)
        for (let index = 0; index < count; index++) {
          chunk.writeInt32LE(frame + index, index * 8)
          chunk.writeInt32LE(track.id, index * 8 + 4)
        }
        frame += count
        return chunk
      },
      close: () => { closed = true },
    }
    return decoder
  }
}

/** Reads `FakeDecoders` PCM back: [track id, frame] per frame. */
export function framesOf(pcm: Buffer): [id: number, frame: number][] {
  const frames: [number, number][] = []
  for (let offset = 0; offset + 8 <= pcm.length; offset += 8) frames.push([pcm.readInt32LE(offset + 4), pcm.readInt32LE(offset)])
  return frames
}
