import type { EngineEvent, EngineLoad, EngineMedia, EnginePreload, EngineState, EngineStatus, PlayerEngine } from '@squirmy/client-core'
import type { Decoder, DecoderFactory } from './decoder.js'
import { applyGain, framesIn, framesToMs, msToFrames, type PcmFormat, sameFormat, splitAt } from './pcm.js'
import type { PcmSink } from './sinks.js'

export type PcmEngineOptions = {
  decoder: DecoderFactory
  sink: PcmSink
  /** The format to decode an entry to and open the sink in. */
  formatFor: (media: EngineMedia | undefined) => PcmFormat
  /** How far ahead of what plays PCM is written to the sink. Defaults to 300 ms. */
  leadMs?: number
  /** How often the engine writes and checks its clock. Defaults to 20 ms. */
  tickMs?: number
  /** The de-click fade-in of a start that is not gapless (load, seek, resume). Defaults to 5 ms; 0 turns it off. */
  fadeInMs?: number
  /** Defaults to `Date.now`. Every position follows it. */
  now?: () => number
  onLog?: (message: string, error?: unknown) => void
}

/** Decoded PCM the engine keeps of an entry before it stops asking its decoder for more. */
const FILL_SECONDS = 1
/** Buffered before a loaded entry starts. */
const START_SECONDS = 0.1
/** Buffered before playback goes on after it ran dry. */
const RESUME_SECONDS = 0.5
const DECODE_RETRIES = 3
const SINK_RETRY_MS = 2000

/** One entry: its decoder and the decoded PCM not yet written. */
type Item = {
  entryId: string
  url: string
  media: EngineMedia | undefined
  gain: number
  format: PcmFormat
  decoder: Decoder | null
  /** Bumped with each new decoder, so a read that comes back for an old one is ignored. */
  generation: number
  chunks: Buffer[]
  /** Frames in `chunks`. */
  frames: number
  /** Track frame of the first frame in `chunks`. */
  writeFrame: number
  /** Track frame of the next frame to reach the speakers, as of the last `advance`. */
  playhead: number
  /** The decoder gave its last frame. */
  done: boolean
  reading: boolean
  failures: number
  failed: boolean
  fade: { done: number; frames: number } | undefined
}

/** PCM written to the sink and not yet heard, kept so a pause or flush can give it back. */
type Segment = { item: Item; trackFrame: number; frames: number; outStart: number; pcm: Buffer }

/**
 * `PlayerEngine` for the speaker: decodes each entry to PCM (`DecoderFactory`) and writes it to
 * one continuous sink (`PcmSink`).
 *
 * **Clock.** The engine paces the sink itself: it writes `leadMs` ahead of the frame it
 * reckons is playing, which it counts from the system clock since the sink was opened. So
 * position, the end of a song and the start of the next follow one sample clock, and a song
 * boundary is a frame count, not a timer.
 *
 * **Gapless.** When the loaded entry has given all its frames and the preloaded one has the
 * same format, the preloaded one's frames follow in the same write, with nothing between. The
 * switch to it (and `ended` for the finished entry) happens when the clock reaches its first
 * frame. A preload in another format (sample rate) starts once the loaded entry has played out,
 * with the sink reopened: the only gap there is.
 *
 * **Pause, seek and load** close the sink, which drops the few hundred milliseconds it holds,
 * and give the unplayed PCM back to its entry, so nothing is lost or repeated and the music
 * stops at once.
 *
 * **Stalls.** When the clock catches up with what was written while the decoder has not
 * finished, the engine reports `buffering` and stops its clock; it goes on once half a second
 * is decoded. A decoder that fails is restarted where it stopped, a few times, before the
 * entry fails. A sink that fails (the device went away) is reopened every two seconds.
 */
export class PcmEngine implements PlayerEngine {
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private readonly now: () => number
  private readonly leadMs: number
  private readonly tickMs: number
  private readonly fadeInMs: number
  private state: EngineState = 'idle'
  private loaded: Item | null = null
  private preloaded: Item | null = null
  private autoplay = false
  private timer: ReturnType<typeof setInterval> | null = null

  private sinkFormat: PcmFormat | null = null
  private sinkRetryAt: number | null = null
  /** Frames written since the sink opened. */
  private written = 0
  /** When output frame 0 played (moved on after a stall), by `now`. */
  private clockAt = 0
  /** Output frames played when the clock stopped (buffering), or null while it runs. */
  private frozen: number | null = null
  private segments: Segment[] = []
  /** Seconds buffered before `buffering` goes on: more after a stall than after a seek or resume. */
  private needed = START_SECONDS

  constructor(private readonly options: PcmEngineOptions) {
    this.now = options.now ?? Date.now
    this.leadMs = options.leadMs ?? 300
    this.tickMs = options.tickMs ?? 20
    this.fadeInMs = options.fadeInMs ?? 5
  }

  // ---------------------------------------------------------------------------
  // PlayerEngine

  load(request: EngineLoad): void {
    this.flush()
    const old = this.loaded
    const reuse = this.preloaded?.entryId === request.entryId && request.startMs === 0 && !this.preloaded.failed ? this.preloaded : null
    if (reuse) this.preloaded = null
    if (old && old !== reuse) old.decoder?.close()
    const item = reuse ?? this.item(request, request.startMs)
    item.gain = request.gain
    item.fade = this.fadeIn(item.format)
    this.loaded = item
    this.autoplay = request.autoplay
    this.setState('loading', true)
    this.ensureTimer()
    this.fill(item)
    this.checkReady()
  }

  preload(request: EnginePreload | null): void {
    const current = this.preloaded
    if (current && request && current.entryId === request.entryId && current.url === request.url) {
      current.gain = request.gain
      return
    }
    // Its first frames may already be in the sink behind the loaded entry's last.
    const inFlight = current !== null && this.segments.some(segment => segment.item === current)
    if (inFlight) this.flush()
    current?.decoder?.close()
    this.preloaded = request ? this.item(request, 0) : null
    if (this.preloaded) this.fill(this.preloaded)
    if (inFlight && this.state === 'playing') this.startOutput()
    if (this.state === 'buffering') this.checkReady()
  }

  play(): void {
    if (!this.loaded || this.state === 'playing' || this.state === 'loading' || this.state === 'buffering') return
    if (this.state !== 'paused') return
    this.loaded.fade = this.fadeIn(this.loaded.format)
    this.waitFor()
  }

  pause(): void {
    const item = this.loaded
    if (!item) return
    if (this.state === 'loading') {
      this.autoplay = false
      return
    }
    if (this.state !== 'playing' && this.state !== 'buffering') return
    this.flush()
    this.setState('paused')
  }

  seek(positionMs: number): void {
    const item = this.loaded
    if (!item) return
    this.flush()
    const duration = this.durationFrames(item)
    const frame = Math.max(0, Math.min(duration ?? Infinity, msToFrames(positionMs, item.format.sampleRate)))
    this.restart(item, frame)
    item.playhead = frame
    item.fade = this.fadeIn(item.format)
    this.fill(item)
    if (this.state === 'playing' || this.state === 'buffering') {
      this.waitFor()
    } else if (this.state === 'loading') {
      this.emit({ type: 'status', status: this.getStatus() })
    } else {
      this.setState('paused', true)
    }
  }

  setGain(gain: number): void {
    if (this.loaded) this.loaded.gain = gain
  }

  stop(): void {
    this.flush()
    this.loaded?.decoder?.close()
    this.preloaded?.decoder?.close()
    this.loaded = null
    this.preloaded = null
    this.stopTimer()
    this.setState('idle', true)
  }

  getStatus(): EngineStatus {
    const item = this.loaded
    if (!item) return { entryId: null, state: this.state, positionMs: 0 }
    const played = this.played()
    let position = item.playhead
    for (const segment of this.segments) {
      if (segment.item !== item) break
      const heard = Math.max(0, Math.min(segment.frames, played - segment.outStart))
      position = segment.trackFrame + heard
      if (heard < segment.frames) break
    }
    return { entryId: item.entryId, state: this.state, positionMs: framesToMs(position, item.format.sampleRate) }
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Stops the timer and every decoder; the engine is unusable after. */
  dispose(): void {
    this.stop()
    this.listeners.clear()
  }

  // ---------------------------------------------------------------------------
  // Items and decoding

  private item(request: { entryId: string; url: string; gain: number; media?: EngineMedia }, startMs: number): Item {
    const format = this.options.formatFor(request.media)
    const frame = msToFrames(startMs, format.sampleRate)
    const item: Item = {
      entryId: request.entryId, url: request.url, media: request.media, gain: request.gain, format,
      decoder: null, generation: 0, chunks: [], frames: 0, writeFrame: frame, playhead: frame,
      done: false, reading: false, failures: 0, failed: false, fade: undefined,
    }
    this.restart(item, frame)
    return item
  }

  /** Replaces the item's decoder with one that starts at `frame`, dropping what was buffered. */
  private restart(item: Item, frame: number) {
    item.decoder?.close()
    item.generation++
    item.chunks = []
    item.frames = 0
    item.writeFrame = frame
    item.done = false
    item.reading = false
    item.failed = false
    item.decoder = this.options.decoder({ url: item.url, startFrame: frame, format: item.format, media: item.media })
  }

  private fill(item: Item) {
    if (item.reading || item.done || item.failed || !item.decoder) return
    if (item.frames >= FILL_SECONDS * item.format.sampleRate) return
    item.reading = true
    const generation = item.generation
    item.decoder.read().then(chunk => {
      if (item.generation !== generation) return
      item.reading = false
      item.failures = 0
      if (chunk === null) {
        item.done = true
      } else {
        item.chunks.push(chunk)
        item.frames += framesIn(chunk, item.format)
      }
      this.onData(item)
      this.fill(item)
    }, (error: unknown) => {
      if (item.generation !== generation) return
      item.reading = false
      this.decodeFailed(item, error)
    })
  }

  private decodeFailed(item: Item, error: unknown) {
    const live = item === this.loaded || item === this.preloaded
    if (!live) return
    item.failures++
    if (item.failures <= DECODE_RETRIES) {
      this.options.onLog?.(`Decoding ${item.entryId} failed; retrying (${item.failures} of ${DECODE_RETRIES})`, error)
      item.decoder?.close()
      item.decoder = null
      const generation = ++item.generation
      setTimeout(() => {
        if (item.generation !== generation || (item !== this.loaded && item !== this.preloaded)) return
        // Where the PCM held so far ends: the new decoder takes up from there.
        const resumeAt = item.writeFrame + item.frames
        const kept = { chunks: item.chunks, frames: item.frames, writeFrame: item.writeFrame }
        this.restart(item, resumeAt)
        Object.assign(item, kept)
        this.fill(item)
      }, 1000 * item.failures)
      return
    }
    item.failed = true
    item.decoder?.close()
    item.decoder = null
    if (item === this.preloaded) {
      // The contract: a preload that fails is dropped silently; the session loads it when its turn comes.
      this.options.onLog?.(`Preloading ${item.entryId} failed`, error)
      const inFlight = this.segments.some(segment => segment.item === item)
      if (inFlight) this.flush()
      this.preloaded = null
      if (inFlight && this.state === 'playing') this.startOutput()
      return
    }
    this.flush()
    this.setState('error')
    this.emit({ type: 'error', entryId: item.entryId, message: error instanceof Error ? error.message : String(error) })
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private onData(item: Item) {
    if (item === this.loaded && this.state === 'loading') return this.checkReady()
    if (this.state === 'buffering') return this.checkReady()
    if (this.state === 'playing') this.pump()
  }

  /** Starts output once enough is buffered: from `loading`, and from `buffering` (a stall, a seek, a resume). */
  private checkReady() {
    const item = this.loaded
    if (!item) return
    if (this.state === 'loading') {
      if (!item.done && item.frames < START_SECONDS * item.format.sampleRate) return
      if (!this.autoplay) return this.setState('paused')
      this.setState('playing')
      this.startOutput()
      return
    }
    if (this.state !== 'buffering') return
    const next = this.writer()
    const source = next ?? item
    if (!source.done && source.frames < this.needed * source.format.sampleRate) return
    this.setState('playing')
    this.startOutput()
  }

  // ---------------------------------------------------------------------------
  // Output

  private fadeIn(format: PcmFormat) {
    return { done: 0, frames: msToFrames(this.fadeInMs, format.sampleRate) }
  }

  private played(): number {
    if (this.sinkFormat === null) return 0
    if (this.frozen !== null) return this.frozen
    const elapsed = Math.floor(((this.now() - this.clockAt) * this.sinkFormat.sampleRate) / 1000)
    return Math.max(0, Math.min(this.written, elapsed))
  }

  /** Opens the sink in the loaded entry's format if it is not, and runs the clock from what is written. */
  private startOutput() {
    const item = this.loaded
    if (!item) return
    // The sound card failed a moment ago; `tick` opens it again when the wait is over.
    if (this.sinkRetryAt !== null && this.now() < this.sinkRetryAt) return
    if (!this.sinkFormat || !sameFormat(this.sinkFormat, item.format)) this.openSink(item.format)
    if (!this.sinkFormat) return
    this.clockAt = this.now() - framesToMs(this.written, this.sinkFormat.sampleRate)
    this.frozen = null
    this.pump()
  }

  private openSink(format: PcmFormat) {
    this.closeSink()
    try {
      this.options.sink.open(format, error => this.sinkFailed(error))
    } catch (error) {
      this.sinkFailed(error)
      return
    }
    this.sinkFormat = format
    this.written = 0
    this.clockAt = this.now()
    this.frozen = null
    this.sinkRetryAt = null
  }

  private closeSink() {
    if (this.sinkFormat) this.options.sink.close()
    this.sinkFormat = null
    this.written = 0
    this.frozen = null
  }

  private sinkFailed(error: unknown) {
    this.options.onLog?.('The sound card stopped; reopening it', error)
    this.giveBack()
    this.sinkFormat = null
    this.written = 0
    this.sinkRetryAt = this.now() + SINK_RETRY_MS
    this.needed = START_SECONDS
    if (this.state === 'playing') this.setState('buffering')
  }

  /** Stops the sound now: closes the sink and gives what it had not played back to its entries. */
  private flush() {
    if (!this.sinkFormat) return
    this.advance()
    this.giveBack()
    this.closeSink()
  }

  /** Puts PCM written but not heard back in front of its entry's buffer. */
  private giveBack() {
    const played = this.played()
    for (const segment of this.segments.reverse()) {
      const heard = Math.max(0, Math.min(segment.frames, played - segment.outStart))
      const [, rest] = splitAt(segment.pcm, segment.item.format, heard)
      if (rest.length === 0) continue
      segment.item.chunks.unshift(rest)
      segment.item.frames += segment.frames - heard
      segment.item.writeFrame = segment.trackFrame + heard
      if (heard > 0) segment.item.playhead = segment.trackFrame + heard
    }
    this.segments = []
  }

  /** The entry whose frames go next: the loaded one, then a preloaded one that can follow it gaplessly. */
  private writer(): Item | null {
    const item = this.loaded
    if (!item || item.failed) return null
    if (!item.done || item.frames > 0) return item
    const next = this.preloaded
    if (next && !next.failed && this.sinkFormat && sameFormat(next.format, this.sinkFormat)) return next
    return null
  }

  /** Writes up to `leadMs` ahead of the clock. */
  private pump() {
    if (this.state !== 'playing' || !this.sinkFormat) return
    const format = this.sinkFormat
    const target = this.played() + msToFrames(this.leadMs, format.sampleRate)
    while (this.written < target) {
      const item = this.writer()
      if (!item || item.frames === 0) break
      const chunk = item.chunks[0]!
      const wanted = target - this.written
      const [head, rest] = splitAt(chunk, format, wanted)
      if (rest.length) item.chunks[0] = rest
      else item.chunks.shift()
      const frames = framesIn(head, format)
      item.frames -= frames
      this.segments.push({ item, trackFrame: item.writeFrame, frames, outStart: this.written, pcm: head })
      item.writeFrame += frames
      this.written += frames
      this.options.sink.write(applyGain(head, format, item.gain, item.fade))
      this.fill(item)
    }
  }

  /** Moves playheads over what the clock says was heard, and switches to the next entry at its first frame. */
  private advance() {
    const played = this.played()
    while (this.segments.length) {
      const segment = this.segments[0]!
      if (played <= segment.outStart) break
      if (segment.item !== this.loaded) {
        if (segment.item !== this.preloaded) {
          this.segments.shift()
          continue
        }
        this.boundary(segment.trackFrame)
        continue
      }
      if (played < segment.outStart + segment.frames) break
      this.segments.shift()
      segment.item.playhead = segment.trackFrame + segment.frames
    }
  }

  /** The preloaded entry starts: it becomes the loaded one, and the finished entry ends. */
  private boundary(frame: number) {
    const finished = this.loaded!
    const next = this.preloaded!
    finished.decoder?.close()
    this.loaded = next
    this.preloaded = null
    next.playhead = frame
    this.emit({ type: 'ended', entryId: finished.entryId })
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private tick() {
    if (this.sinkRetryAt !== null && this.now() >= this.sinkRetryAt && (this.state === 'buffering' || this.state === 'playing')) {
      this.sinkRetryAt = null
      this.checkReady()
      if (!this.sinkFormat && this.loaded) this.startOutput()
    }
    if (this.state !== 'playing') return
    if (!this.sinkFormat) return this.startOutput()
    this.advance()
    this.pump()
    const item = this.loaded
    if (!item || this.state !== 'playing' || this.played() < this.written) return
    // Everything written has been heard.
    const next = this.writer()
    if (next && next.frames === 0 && !next.done) {
      this.frozen = this.written
      this.needed = RESUME_SECONDS
      this.setState('buffering')
      return
    }
    if (next) return
    const following = this.preloaded
    if (following && !following.failed) {
      // A different format: reopen the sink for it.
      this.closeSink()
      this.boundary(following.writeFrame)
      this.loaded!.fade = undefined
      this.startOutput()
      return
    }
    item.playhead = item.writeFrame
    this.closeSink()
    this.state = 'ended'
    this.emit({ type: 'ended', entryId: item.entryId })
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private durationFrames(item: Item): number | null {
    const gapless = item.media?.gapless
    if (gapless) return Math.ceil((gapless.frames * item.format.sampleRate) / gapless.sampleRate)
    const duration = item.media?.durationMs
    return duration ? msToFrames(duration, item.format.sampleRate) : null
  }

  // ---------------------------------------------------------------------------
  // State and events

  private ensureTimer() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.tickMs)
    this.timer.unref?.()
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Goes on playing (after a resume or seek) once enough is buffered, saying `buffering` only
   * when it has to wait, so a resume with its PCM at hand reports `playing` alone.
   */
  private waitFor() {
    this.state = 'buffering'
    this.frozen = null
    this.needed = START_SECONDS
    this.checkReady()
    if (this.state === 'buffering') this.emit({ type: 'status', status: this.getStatus() })
  }

  private setState(state: EngineState, always = false) {
    if (state === this.state && !always) return
    if (state === 'buffering' && this.frozen === null && this.sinkFormat) this.frozen = this.played()
    this.state = state
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private emit(event: EngineEvent) {
    for (const listener of [...this.listeners]) listener(event)
  }
}
