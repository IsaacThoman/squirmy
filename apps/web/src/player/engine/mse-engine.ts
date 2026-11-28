import type { EngineEvent, EngineLoad, EngineMedia, EnginePreload, EngineState, EngineStatus } from '@squirmy/client-core'
import type { PlaybackQuery, StreamIntent, StreamProfile } from '@squirmy/contracts'
import { mseTypesFor } from '@/lib/codecs'
import { AUDIO_BLOCKED_MESSAGE, clampPosition, mediaErrorMessage, playFailure } from './errors'
import type { BrowserEngine } from './types'

export type MseEngineOptions = {
  createAudio?: () => HTMLAudioElement
  createContext?: () => AudioContext
  /** The node the element plays into. Defaults to the context's destination; the dev page inserts its instruments. */
  output?: (context: AudioContext) => AudioNode
  createMediaSource?: () => MediaSource
  createObjectUrl?: (source: MediaSource) => string
  fetch?: typeof fetch
  /** `SourceBuffer` type per codec (see `mseTypesFor`). Defaults to what `MediaSource.isTypeSupported` accepts. */
  types?: ReadonlyMap<string, string>
  /** How long a suspended `AudioContext` gets to resume before audio counts as blocked. */
  resumeTimeoutMs?: number
  /** Playing without the position moving for this long counts as buffering. */
  stallMs?: number
  /** Seconds appended ahead of the playhead. */
  leadSeconds?: number
  /** Seconds kept behind the playhead. */
  keepBehindSeconds?: number
}

const HAVE_METADATA = 1
const HAVE_FUTURE_DATA = 3
const WATCHDOG_MS = 250
/** Gain changes on a playing entry settle (to 95%) over this long instead of jumping. */
const GAIN_RAMP_SECONDS = 0.01
/** At a boundary the gain moves to the next entry's over this long, centred on nothing audible. */
const BOUNDARY_RAMP_SECONDS = 0.005
/** Within this much of a boundary, a timer reports it rather than the next `timeupdate`. */
const BOUNDARY_WINDOW_SECONDS = 1
const LEAD_SECONDS = 30
const KEEP_BEHIND_SECONDS = 60
/** Trimming behind the playhead waits until there is this much more than the limit. */
const TRIM_SLACK_SECONDS = 10
/** A seek this far past what is appended (at most the lead) waits for the stream rather than starting another. */
const INSIDE_AHEAD_SECONDS = 3
/** A stream started again for a seek replaces what was appended from this long before it. */
const CLEAR_BEFORE_SEEK_SECONDS = 0.25
/** A stream started for a seek starts at least this long before the end. */
const END_START_MS = 250
/** A remux or a stream read from its start keeps this much before a seek, for browsers that drop the frame a window cuts. */
const SEEK_MARGIN_SECONDS = 0.05
/** The download stops reading while this much is waiting to be appended. */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024
/** One append is at most this, and at most what the lead has room for once the stream's bitrate is known. */
const APPEND_BYTES = 1024 * 1024
const MIN_APPEND_BYTES = 16 * 1024
/** What `looksLike` reads of a stream's start. */
const SNIFF_BYTES = 8
/**
 * Chromium drops an MP3 decoder's delay (529 samples) itself, and the descriptor's priming,
 * from the file's LAME tag, includes it.
 */
const MP3_DECODER_DELAY = 529
/** At the end of the last entry the element runs dry before it is paused, so nothing still playing is cut. */
const END_PAUSE_MS = 250
/** The `MediaSource` duration: far past anything appended; extended if playback gets near it. */
const TIMELINE_SECONDS = 10_000_000
/** Buffered ranges this close count as one. */
const EPSILON = 0.002
/** A stream's data can start this much after its window (a frame the window cut, dropped whole). */
const FRONTIER_SLACK_SECONDS = 0.1

/** Profiles whose streams start at another position with `start` (fragmented MP4). */
const SEEKABLE = new Set<StreamProfile>(['flac_mp4', 'opus_mp4_192', 'opus_mp4_96', 'aac_mp4_256', 'aac_mp4_128', 'copy_mp4'])

const UNSUPPORTED_MESSAGE = 'The browser cannot play this stream'

/**
 * One entry on the element's timeline: its stream, and where its frame 0 sits. `exact` holds
 * the descriptor's gapless numbers; without them (a file the server has not measured yet)
 * nothing is trimmed, and the entry ends where its data does.
 */
type Item = {
  entryId: string
  url: string
  gain: number
  media: EngineMedia | null
  /** `SourceBuffer` type, or null when this browser cannot append the stream. */
  type: string | null
  exact: { rate: number; priming: number; frames: number } | null
  durationMs: number
  /** Seconds on the element's timeline; null until placed. */
  start: number | null
  /** Known from `exact`, otherwise once the whole stream is appended. */
  end: number | null
  fill: Fill | null
}

/** A download of an item's stream from `fromMs`, appended as it arrives. */
type Fill = {
  fromMs: number
  controller: AbortController
  chunks: Uint8Array[]
  bytes: number
  /** The stream's first frame on the track (`X-Squirmy-Start-Frame`); null until the response arrives. */
  startFrame: number | null
  done: boolean
  error: string | null
  /** Some bytes went to a `SourceBuffer`; another pipeline needs a fresh download. */
  taken: boolean
  /** Everything is appended. */
  complete: boolean
  /** Where the appended data ends on the timeline. */
  frontier: number
  /** Bytes appended, and where the first of them went, for the stream's rate in bytes per second. */
  appended: number
  origin: number | null
  /** Resumes a download waiting for the queue to drain. */
  drained: (() => void) | null
}

/** A `MediaSource` attached to the element. A load or a failure replaces it. */
type Pipeline = {
  source: MediaSource
  url: string
  buffer: SourceBuffer | null
  type: string | null
  /** The fill whose bytes the parser is in the middle of. */
  parsing: Fill | null
  /** The item being appended, and the one being appended when the buffer failed. */
  appending: Item | null
  failed: Item | null
  removals: [from: number, to: number][]
  /** Where the playhead goes once `removals` are done: moved before, it would play the data they remove. */
  seekTo: number | null
  /** The buffer refused more data; appending waits until the playhead passes this. */
  fullUntil: number | null
  closed: boolean
  waiters: Set<() => void>
}

/**
 * `PlayerEngine` on one `<audio>` element fed through Media Source Extensions, so the loaded
 * and the preloaded entries play on one timeline with nothing timed between them.
 *
 * Each stream is fetched and appended as it arrives into one `SourceBuffer`. The server's
 * fragmented MP4 carries no edit list; the descriptor's numbers place each entry: its
 * `timestampOffset` is its start less the encoder's priming, and the append window cuts it
 * to its real frames, so the next entry starts on the sample after the last one. Seeks
 * inside what is appended move `currentTime`; others fetch the stream again from there with
 * `start`, and `X-Squirmy-Start-Frame` places it. The element runs through a `GainNode`, so
 * normalization can boost; at a boundary the gain moves to the next entry's on the audio
 * clock. A 250 ms interval, `timeupdate` and a timer near the end report boundaries: in a
 * background tab the report can come late, the audio does not.
 *
 * Blocked audio and `unlock()` work as in `WebPlayerEngine`.
 */
export class MseEngine implements BrowserEngine {
  readonly canBoost = true
  private readonly options: MseEngineOptions
  private readonly audio: HTMLAudioElement
  private readonly types: ReadonlyMap<string, string>
  private context: AudioContext | null = null
  private gainNode: GainNode | null = null
  private pipeline: Pipeline | null = null
  private current: Item | null = null
  private next: Item | null = null
  private state: EngineState = 'idle'
  /** Where a load or seek is heading; reported until the element gets there. */
  private target: number | null = null
  /** The target still has to be set on the element once it has metadata. */
  private targetPending = false
  private wantPlay = false
  private blocked = false
  /** Bumped by every load and stop, so late callbacks of an earlier entry do nothing. */
  private generation = 0
  /** The generation whose play() is out; its `playing` event, not readiness, says it plays. */
  private started = -1
  private pumping = false
  private pumpAgain = false
  private watchdog: ReturnType<typeof setInterval> | null = null
  private boundaryTimer: ReturnType<typeof setTimeout> | null = null
  private lastProgress = { position: 0, at: 0 }
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private readonly detach: (() => void)[] = []

  /** Whether this browser has what the engine needs: MSE with `changeType`, and FLAC or AAC in MP4. */
  static isSupported(): boolean {
    if (typeof MediaSource === 'undefined' || typeof SourceBuffer === 'undefined') return false
    if (typeof MediaSource.isTypeSupported !== 'function' || !('changeType' in SourceBuffer.prototype)) return false
    const types = mseTypesFor(type => MediaSource.isTypeSupported(type))
    return types.has('flac') && types.has('aac')
  }

  constructor(options: MseEngineOptions = {}) {
    this.options = options
    this.types = options.types ?? mseTypesFor(type => MediaSource.isTypeSupported(type))
    this.audio = options.createAudio?.() ?? new Audio()
    this.audio.preload = 'auto'
    this.listen()
  }

  playbackQuery(): Pick<PlaybackQuery, 'codecs' | 'containers' | 'engine'> {
    return { codecs: [...this.types.keys()].join(','), containers: 'fmp4', engine: 'mse' }
  }

  load(request: EngineLoad): void {
    this.generation += 1
    this.clearBoundaryTimer()
    const reuse = this.next?.entryId === request.entryId && this.pipeline !== null && !this.pipeline.closed
    this.wantPlay = request.autoplay
    this.blocked = false
    // A new entry always announces itself, even when the previous one was loading too.
    this.state = 'loading'
    if (reuse) {
      const item = this.next!
      if (this.current) this.cancelFill(this.current)
      this.current = item
      this.next = null
      item.gain = request.gain
      item.start ??= this.frontier()
      item.end ??= item.exact ? item.start + item.exact.frames / item.exact.rate : null
      this.target = clampPosition(request.startMs, item.durationMs / 1000)
      if (!request.autoplay) this.audio.pause()
      this.syncWatchdog()
      this.emitStatus()
      this.applyGain()
      this.moveTo(this.target)
      this.kick()
      return this.continueLoading()
    }
    if (this.current) this.cancelFill(this.current)
    // Loaded without its buffer, the preloaded entry is no longer what follows.
    if (this.next?.entryId === request.entryId) this.dropNext()
    const item = this.itemOf(request)
    this.current = item
    this.target = clampPosition(request.startMs, item.durationMs / 1000)
    this.syncWatchdog()
    this.emitStatus()
    if (!item.type) {
      // What played before must not go on under the error.
      this.close()
      return this.fail(UNSUPPORTED_MESSAGE)
    }
    // The element joins the audio graph before it gets a source: joined afterwards, Chromium
    // sometimes ran it at the device's rate and resampled twice.
    this.ensureContext()
    this.open(item)
    this.startFill(item, this.target, 'play')
    if (this.next) this.unplace(this.next)
    this.place()
    this.applyGain()
    this.targetPending = true
    this.kick()
  }

  preload(request: EnginePreload | null): void {
    // The playhead is already in the preloaded entry: report that first. The client asks
    // again for whatever follows the new entry.
    if (this.crossed()) return this.check()
    const next = this.next
    if (request && next?.entryId === request.entryId && next.url === request.url) {
      next.gain = request.gain
      return this.applyGain()
    }
    if (next) this.dropNext()
    if (!request) return
    const item = this.itemOf(request)
    // A stream this browser cannot append is dropped as a failed preload is; the entry loads when its turn comes.
    if (!item.type) return
    this.next = item
    this.startFill(item, 0, 'next')
    this.place()
    this.applyGain()
    this.kick()
  }

  play(): void {
    if (!this.current || this.state === 'loading' || this.state === 'playing' || this.state === 'buffering') return
    if (this.state === 'error' && !this.blocked) return
    this.blocked = false
    this.clearBoundaryTimer()
    // As an element that played to its end does, play starts the entry again.
    if (this.state === 'ended') this.moveTo(0)
    this.setState('playing')
    this.startAudio()
    this.kick()
  }

  pause(): void {
    if (!this.current) return
    this.wantPlay = false
    this.audio.pause()
    if (this.state === 'loading') return this.continueLoading()
    if (this.state === 'error' && !this.blocked) return
    this.blocked = false
    this.setState('paused')
  }

  seek(positionMs: number): void {
    const item = this.current
    if (!item || item.start === null || (this.state === 'error' && !this.blocked)) return
    this.clearBoundaryTimer()
    this.target = clampPosition(positionMs, item.durationMs / 1000)
    if (this.state === 'ended') {
      // The element may still be running dry at the end.
      this.state = 'paused'
      this.audio.pause()
    }
    this.moveTo(this.target)
    if (this.state === 'loading') this.continueLoading()
  }

  setGain(gain: number): void {
    if (!this.current) return
    this.current.gain = gain
    this.applyGain()
  }

  stop(): void {
    this.generation += 1
    this.clearBoundaryTimer()
    for (const item of [this.current, this.next]) if (item) this.cancelFill(item)
    this.current = null
    this.next = null
    this.close()
    this.target = null
    this.wantPlay = false
    this.blocked = false
    this.state = 'idle'
    this.syncWatchdog()
    this.emitStatus()
  }

  getStatus(): EngineStatus {
    const item = this.current
    if (!item) return { entryId: null, state: this.state, positionMs: 0 }
    const positionMs = this.state === 'ended' ? item.durationMs : this.target ?? this.positionOf(item)
    return { entryId: item.entryId, state: this.state, positionMs }
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  isBlocked(): boolean {
    return this.blocked
  }

  unlock(): void {
    this.warm()
    if (!this.blocked) return
    this.blocked = false
    this.state = 'paused'
    this.play()
  }

  warm(): void {
    void this.ensureContext().resume().catch(() => {})
  }

  dispose(): void {
    this.stop()
    for (const detach of this.detach.splice(0)) detach()
    void this.context?.close().catch(() => {})
    this.context = null
  }

  /** What the dev page and the end-to-end check read: the timeline and what is buffered. */
  inspect() {
    const buffered = this.pipeline?.buffer?.buffered
    const ranges: [number, number][] = []
    for (let index = 0; buffered && index < buffered.length; index += 1) ranges.push([buffered.start(index), buffered.end(index)])
    const describe = (item: Item | null) => item && {
      entryId: item.entryId, start: item.start, end: item.end, fromMs: item.fill?.fromMs ?? null, complete: item.fill?.complete ?? false,
    }
    return { currentTime: this.audio.currentTime, buffered: ranges, current: describe(this.current), next: describe(this.next) }
  }

  private listen(): void {
    const audio = this.audio
    const on = (type: string, handler: () => void) => {
      audio.addEventListener(type, handler)
      this.detach.push(() => audio.removeEventListener(type, handler))
    }
    const live = (handler: () => void) => () => { if (this.current && this.pipeline && !this.pipeline.closed) handler() }
    on('loadedmetadata', live(() => this.continueLoading()))
    on('canplay', live(() => this.continueLoading()))
    on('seeked', live(() => this.onSeeked()))
    on('playing', live(() => this.onPlaying()))
    on('waiting', live(() => this.onWaiting()))
    on('pause', live(() => this.onPaused()))
    on('timeupdate', live(() => this.check()))
    on('error', () => this.onError())
  }

  private itemOf(request: EnginePreload): Item {
    const media = request.media ?? null
    const gapless = media?.gapless
    const exact = gapless ? { rate: gapless.sampleRate, priming: gapless.primingFrames, frames: gapless.frames } : null
    return {
      entryId: request.entryId,
      url: request.url,
      gain: request.gain,
      media,
      type: media ? this.typeOf(media) : null,
      exact,
      durationMs: exact ? Math.round(exact.frames / exact.rate * 1000) : media?.durationMs ?? 0,
      start: null,
      end: null,
      fill: null,
    }
  }

  /** The stream's `SourceBuffer` type; null without the descriptor's container and codec, or when this browser cannot append them. */
  private typeOf(media: EngineMedia): string | null {
    if (media.mime === 'audio/mpeg') return this.types.get('mp3') ?? null
    if (media.mime !== 'audio/mp4' || !media.codec) return null
    return this.types.get(media.codec === 'mp3' ? 'mp3_mp4' : media.codec) ?? null
  }

  /** Places the preloaded entry after the loaded one, once the loaded one's end is known. */
  private place(): void {
    const current = this.current
    const next = this.next
    if (!current || !next || next.start !== null || current.end === null) return
    next.start = current.end
    next.end = next.exact ? next.start + next.exact.frames / next.exact.rate : null
  }

  /** Takes the preloaded entry off the timeline; it is placed and appended again later. */
  private unplace(item: Item): void {
    item.start = null
    item.end = null
    if (item.fill?.taken) {
      this.cancelFill(item)
      item.fill = null
    }
  }

  private dropNext(): void {
    const next = this.next!
    this.cancelFill(next)
    if (next.fill?.taken && next.start !== null) this.pipeline?.removals.push([next.start, Infinity])
    this.next = null
    this.applyGain()
  }

  /** Starts a fresh `MediaSource` on the element, with `item` at 0 on its timeline. */
  private open(item: Item): void {
    this.close()
    const source = this.options.createMediaSource?.() ?? new MediaSource()
    const url = this.options.createObjectUrl?.(source) ?? URL.createObjectURL(source)
    const pipeline: Pipeline = {
      source, url, buffer: null, type: null, parsing: null, appending: null, failed: null,
      removals: [], seekTo: null, fullUntil: null, closed: false, waiters: new Set(),
    }
    this.pipeline = pipeline
    source.addEventListener('sourceopen', () => {
      if (pipeline !== this.pipeline) return
      if (!this.options.createObjectUrl) URL.revokeObjectURL(url)
      this.kick()
    }, { once: true })
    item.start = 0
    item.end = item.exact ? item.exact.frames / item.exact.rate : null
    this.audio.src = url
  }

  private close(): void {
    const pipeline = this.pipeline
    if (!pipeline) return
    pipeline.closed = true
    for (const wake of pipeline.waiters) wake()
    pipeline.waiters.clear()
    this.pipeline = null
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
  }

  private startFill(item: Item, fromMs: number, intent: StreamIntent): Fill {
    const profile = item.media?.profile
    const seekable = profile !== undefined && SEEKABLE.has(profile) && this.rateOf(item) !== null
    // A stream that starts at the very end would have nothing in it; the server refuses one past it.
    const from = fromMs > 0 && seekable ? Math.min(fromMs, Math.max(0, item.durationMs - END_START_MS)) : fromMs
    const fill: Fill = {
      fromMs: from, controller: new AbortController(), chunks: [], bytes: 0, startFrame: null,
      done: false, error: null, taken: false, complete: false, frontier: 0, appended: 0, origin: null, drained: null,
    }
    item.fill = fill
    void this.download(item, fill, seekable && from > 0, intent)
    return fill
  }

  private async download(item: Item, fill: Fill, fromStart: boolean, intent: StreamIntent): Promise<void> {
    const { signal } = fill.controller
    try {
      const url = streamUrl(item.url, intent, fromStart ? fill.fromMs : null)
      const response = await (this.options.fetch ?? fetch)(url, { signal })
      // A refusal (gone, expired, not allowed) is the stream's own; anything else is the download.
      if (!response.ok || !response.body) throw new StreamError(mediaErrorMessage(response.status >= 400 && response.status < 500 ? 4 : 2)!)
      const header = response.headers.get('x-squirmy-start-frame')
      fill.startFrame = fromStart ? Number(header) : 0
      if (!Number.isSafeInteger(fill.startFrame)) throw new StreamError(mediaErrorMessage(4)!)
      this.kick()
      const reader = response.body.getReader()
      for (;;) {
        while (fill.bytes >= MAX_QUEUED_BYTES) await new Promise<void>(resolve => { fill.drained = resolve })
        const { done, value } = await reader.read()
        if (done) break
        fill.chunks.push(value)
        fill.bytes += value.byteLength
        this.kick()
      }
      fill.done = true
    } catch (error) {
      if (signal.aborted) return
      fill.error = error instanceof StreamError ? error.message : mediaErrorMessage(2)!
    }
    this.kick()
  }

  private cancelFill(item: Item): void {
    const fill = item.fill
    if (!fill) return
    fill.controller.abort()
    fill.drained?.()
  }

  private kick(): void {
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    void this.pump()
  }

  /** The one loop that touches the `SourceBuffer`, so its operations never overlap. */
  private async pump(): Promise<void> {
    this.pumping = true
    try {
      do {
        this.pumpAgain = false
        while (await this.step()) { /* more to do */ }
      } while (this.pumpAgain)
    } catch (error) {
      this.pumpFailed(error)
    } finally {
      this.pumping = false
    }
  }

  /** One operation on the buffer. False when nothing can happen until something changes. */
  private async step(): Promise<boolean> {
    const pipeline = this.pipeline
    if (!pipeline || pipeline.closed || pipeline.source.readyState !== 'open') return false
    if (pipeline.buffer?.updating) {
      await this.updated(pipeline)
      return true
    }
    const furthest = Math.max(this.current?.end ?? 0, this.next?.end ?? 0)
    if (pipeline.buffer && furthest > pipeline.source.duration - TIMELINE_SECONDS / 2) {
      pipeline.source.duration += TIMELINE_SECONDS
      return true
    }
    const removal = pipeline.buffer && pipeline.removals.shift()
    if (removal) {
      const [from, to] = removal
      const end = Math.min(to, this.bufferedEnd(pipeline))
      if (end - from > EPSILON) {
        pipeline.buffer!.remove(Math.max(0, from), end)
        await this.updated(pipeline)
      }
      return true
    }
    if (pipeline.seekTo !== null) {
      this.audio.currentTime = pipeline.seekTo
      pipeline.seekTo = null
      return true
    }
    const item = this.fillTarget()
    if (!item) return false
    const fill = item.fill ?? this.startFill(item, 0, item === this.current ? 'play' : 'next')
    if (fill.error) {
      this.fillFailed(item, fill)
      return true
    }
    if (fill.startFrame === null) return false
    if (pipeline.fullUntil !== null) {
      if (this.audio.currentTime < pipeline.fullUntil) return false
      pipeline.fullUntil = null
    }
    if (!fill.chunks.length) {
      if (!fill.done) return false
      this.finishFill(item, fill)
      return true
    }
    // Its first bytes are checked before any reaches the buffer, so wait for enough of them.
    if (!fill.taken && fill.bytes < SNIFF_BYTES && !fill.done) return false
    const room = (this.options.leadSeconds ?? LEAD_SECONDS) - this.ahead()
    if (room <= 0) return false
    if (pipeline.parsing !== fill) this.configure(pipeline, item, fill)
    const bytes = this.take(fill, this.budget(fill, room))
    if (!fill.taken && !looksLike(item.type!, bytes)) {
      fill.error = mediaErrorMessage(3)!
      return true
    }
    fill.taken = true
    pipeline.appending = item
    try {
      pipeline.buffer!.appendBuffer(bytes as BufferSource)
    } catch (error) {
      pipeline.appending = null
      if ((error as { name?: string }).name !== 'QuotaExceededError') throw error
      fill.chunks.unshift(bytes)
      fill.bytes += bytes.byteLength
      return this.full(pipeline)
    }
    await this.updated(pipeline)
    pipeline.appending = null
    if (pipeline !== this.pipeline || item.fill !== fill) return true
    fill.appended += bytes.byteLength
    fill.origin ??= fill.frontier
    fill.frontier = Math.min(item.end ?? Infinity, this.rangeEnd(pipeline, fill.frontier, FRONTIER_SLACK_SECONDS))
    this.trimBehind(pipeline)
    this.check()
    return true
  }

  /** The entry whose stream is appended next: the loaded one, then the preloaded one after it. */
  private fillTarget(): Item | null {
    const current = this.current
    // A failed entry fetches nothing more: a load or a seek gives it a stream again.
    if (!current?.type || current.start === null || !current.fill || (this.state === 'error' && !this.blocked)) return null
    if (!current.fill.complete) return current.fill.controller.signal.aborted ? null : current
    // After the last entry ended, a preload waits for play: the element must not run on into it.
    const next = this.next
    return next && next.start !== null && !next.fill?.complete && this.state !== 'ended' ? next : null
  }

  /** Points the parser at `fill`: its type, and its place and cut on the timeline. */
  private configure(pipeline: Pipeline, item: Item, fill: Fill): void {
    const type = item.type!
    let buffer = pipeline.buffer
    if (!buffer) {
      // Entries are appended at their own places, so the timeline gets a length of its own. Not
      // an infinite one: then only what is buffered is seekable, and a seek past it is cut short.
      // Set before the buffer exists (`readyState` can be open before `sourceopen` has run).
      pipeline.source.duration = TIMELINE_SECONDS
      buffer = pipeline.source.addSourceBuffer(type)
      pipeline.buffer = buffer
      pipeline.type = type
      buffer.addEventListener('error', () => { pipeline.failed = pipeline.appending })
    } else {
      // Another stream was cut off mid-way: its partial segment must not run into this one.
      if (pipeline.parsing && !pipeline.parsing.complete) buffer.abort()
      if (pipeline.type !== type) {
        buffer.changeType(type)
        pipeline.type = type
      }
    }
    // MPEG byte streams carry no timestamps, so their buffer stays in `sequence` mode.
    if (type !== 'audio/mpeg' && buffer.mode !== 'segments') buffer.mode = 'segments'
    const { offset, from, to } = this.windowOf(item, fill)
    buffer.appendWindowEnd = Infinity
    buffer.appendWindowStart = from
    buffer.appendWindowEnd = to
    buffer.timestampOffset = offset
    fill.frontier = from
    pipeline.parsing = fill
  }

  /**
   * Where `fill`'s stream goes. From its start: priming before the entry's start, cut at its
   * start and end. An encode started later (`start`) begins at `X-Squirmy-Start-Frame` less
   * the same priming; a remux begins at its preroll packet with no priming, and a stream read
   * from its start for a seek is cut just before the seek.
   */
  private windowOf(item: Item, fill: Fill): { offset: number; from: number; to: number } {
    const start = item.start!
    const to = item.end ?? Infinity
    const rate = this.rateOf(item)
    const priming = Math.max(0, (item.exact?.priming ?? 0) - (item.type === 'audio/mpeg' ? MP3_DECODER_DELAY : 0))
    const startFrame = fill.startFrame ?? 0
    if (!rate) return { offset: start, from: start + Math.max(0, fill.fromMs / 1000 - SEEK_MARGIN_SECONDS), to }
    if (fill.fromMs === 0) return { offset: start - priming / rate, from: start, to }
    if (startFrame === 0) return { offset: start - priming / rate, from: start + Math.max(0, fill.fromMs / 1000 - SEEK_MARGIN_SECONDS), to }
    if (item.media?.profile === 'copy_mp4') return { offset: start + startFrame / rate, from: start + Math.max(0, fill.fromMs / 1000 - SEEK_MARGIN_SECONDS), to }
    return { offset: start + (startFrame - priming) / rate, from: start + Math.min(startFrame / rate, fill.fromMs / 1000), to }
  }

  private rateOf(item: Item): number | null {
    return item.exact?.rate ?? item.media?.sampleRate ?? null
  }

  /** How many bytes fill `room` seconds of lead, from what the stream's appends covered so far. */
  private budget(fill: Fill, room: number): number {
    const seconds = fill.origin === null ? 0 : fill.frontier - fill.origin
    if (seconds < 0.25) return MIN_APPEND_BYTES
    return Math.min(APPEND_BYTES, Math.max(MIN_APPEND_BYTES, Math.ceil(room * fill.appended / seconds)))
  }

  /** Up to `budget` bytes from the front of the queue; a parser takes a stream cut anywhere. */
  private take(fill: Fill, budget: number): Uint8Array {
    let size = 0
    let count = 0
    while (count < fill.chunks.length && size < budget) {
      const chunk = fill.chunks[count]!
      if (size + chunk.byteLength > budget) {
        const keep = budget - size
        fill.chunks.splice(count, 1, chunk.subarray(0, keep), chunk.subarray(keep))
      }
      size += fill.chunks[count]!.byteLength
      count += 1
    }
    const parts = fill.chunks.splice(0, count)
    fill.bytes -= size
    if (fill.bytes < MAX_QUEUED_BYTES) {
      fill.drained?.()
      fill.drained = null
    }
    if (parts.length === 1) return parts[0]!
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    return bytes
  }

  private finishFill(item: Item, fill: Fill): void {
    fill.complete = true
    const pipeline = this.pipeline
    // Without exact numbers the entry ends where its data does. With them, a stream shorter
    // than they say would leave a hole the next entry's data could not fill.
    if (pipeline && fill.taken) {
      const end = this.rangeEnd(pipeline, fill.frontier, FRONTIER_SLACK_SECONDS)
      if (item.end === null || end < item.end - EPSILON) item.end = end
    }
    if (item.end === null && item.start !== null) item.end = item.start
    // A preloaded entry not appended yet moves to where this one really ends.
    const next = this.next
    if (item === this.current && next && !next.fill?.taken) next.start = null
    this.place()
    this.check()
  }

  private fillFailed(item: Item, fill: Fill): void {
    item.fill = null
    if (item === this.next) {
      // A preload that fails is dropped silently; the entry loads afresh when its turn comes.
      if (fill.taken && item.start !== null) this.pipeline?.removals.push([item.start, Infinity])
      this.next = null
      return
    }
    if (item === this.current) this.fail(fill.error ?? mediaErrorMessage(2)!)
  }

  private full(pipeline: Pipeline): boolean {
    const now = this.audio.currentTime
    const behind = this.rangeStart(pipeline, now)
    if (now - behind > 1) {
      pipeline.removals.push([0, now - 1])
      return true
    }
    pipeline.fullUntil = now + Math.max(1, this.ahead() / 3)
    return false
  }

  private trimBehind(pipeline: Pipeline): void {
    const keep = this.options.keepBehindSeconds ?? KEEP_BEHIND_SECONDS
    const now = this.audio.currentTime
    const limit = now - keep
    if (limit - this.rangeStart(pipeline, now) > TRIM_SLACK_SECONDS) pipeline.removals.push([0, limit])
  }

  private updated(pipeline: Pipeline): Promise<void> {
    const buffer = pipeline.buffer
    if (!buffer?.updating || pipeline.closed) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        buffer.removeEventListener('updateend', done)
        pipeline.waiters.delete(done)
        resolve()
      }
      buffer.addEventListener('updateend', done)
      pipeline.waiters.add(done)
    })
  }

  private pumpFailed(error: unknown): void {
    const pipeline = this.pipeline
    if (!pipeline || pipeline.closed) return
    const failed = pipeline.appending ?? this.current
    pipeline.appending = null
    if (failed && failed === this.next) {
      this.cancelFill(failed)
      this.next = null
      return this.recover()
    }
    if (this.current) this.fail(error instanceof StreamError ? error.message : mediaErrorMessage(3)!)
  }

  /** The element failed on the preloaded entry's data: play the loaded one again on a fresh pipeline, without it. */
  private recover(): void {
    const item = this.current
    if (!item?.type) return
    const positionMs = this.positionOf(item)
    const playing = this.state === 'playing' || this.state === 'buffering'
    this.cancelFill(item)
    this.generation += 1
    this.open(item)
    this.startFill(item, positionMs, 'play')
    this.target = positionMs
    this.targetPending = true
    this.wantPlay = playing
    this.state = 'loading'
    this.syncWatchdog()
    this.emitStatus()
    this.kick()
  }

  /**
   * Moves the playhead to `positionMs` of the loaded entry. Inside what its stream has
   * appended (or will in a moment) that is all; otherwise the stream starts again from there.
   */
  private moveTo(positionMs: number): void {
    const item = this.current!
    const pipeline = this.pipeline
    const time = item.start! + positionMs / 1000
    const restart = !this.reaches(item, time) && pipeline !== null
    if (pipeline) pipeline.seekTo = null
    if (restart) {
      this.cancelFill(item)
      const end = item.end ?? Infinity
      // What it had appended past the new start is replaced; the preloaded entry after it stays.
      // An old frame left straddling the start would play instead of the new stream's first.
      pipeline.removals.push([Math.max(item.start!, Math.min(time, item.fill?.frontier ?? time) - CLEAR_BEFORE_SEEK_SECONDS), end])
      const next = this.next
      if (next?.fill && pipeline.parsing === next.fill && !next.fill.complete) this.unplace(next)
      this.startFill(item, positionMs, 'play')
      this.place()
      this.kick()
    }
    if (this.audio.readyState < HAVE_METADATA) {
      this.targetPending = true
      return
    }
    this.targetPending = false
    const at = Math.max(time, this.fillStart(item))
    if (restart) {
      pipeline.seekTo = at
      return this.kick()
    }
    this.audio.currentTime = at
  }

  /** Whether the loaded entry's current stream covers `time`, or will within a few seconds. */
  private reaches(item: Item, time: number): boolean {
    const fill = item.fill
    const pipeline = this.pipeline
    if (!fill || fill.error || fill.controller.signal.aborted || !pipeline) return false
    const from = this.fillStart(item)
    const ahead = Math.min(INSIDE_AHEAD_SECONDS, this.options.leadSeconds ?? LEAD_SECONDS)
    if (!fill.taken) return time >= from - EPSILON && time <= from + ahead
    const first = Math.max(this.rangeStart(pipeline, fill.frontier), item.start!)
    const last = fill.complete ? item.end ?? fill.frontier : fill.frontier + ahead
    return time >= first - EPSILON && time <= last
  }

  /** Where the loaded entry's current stream starts on the timeline. */
  private fillStart(item: Item): number {
    const fill = item.fill
    if (!fill || item.start === null) return item.start ?? 0
    if (this.pipeline?.parsing === fill) return Math.min(fill.frontier, this.windowOf(item, fill).from)
    if (fill.fromMs === 0) return item.start
    if (fill.startFrame !== null && fill.startFrame > 0 && item.media?.profile !== 'copy_mp4') return this.windowOf(item, fill).from
    return item.start + Math.max(0, fill.fromMs / 1000 - SEEK_MARGIN_SECONDS)
  }

  private positionOf(item: Item): number {
    if (item.start === null) return 0
    return Math.min(item.durationMs, Math.max(0, Math.round((this.audio.currentTime - item.start) * 1000)))
  }

  /** Seconds appended ahead of the playhead, through every entry after it. */
  private ahead(): number {
    const pipeline = this.pipeline
    if (!pipeline?.buffer) return 0
    const now = this.audio.currentTime
    return Math.max(0, this.rangeEnd(pipeline, now) - now)
  }

  /**
   * The end of the buffered range around `time`, or `time` when nothing is buffered there.
   * `slack` also takes a range that starts that much later.
   */
  private rangeEnd(pipeline: Pipeline, time: number, slack = EPSILON): number {
    const ranges = pipeline.buffer?.buffered
    for (let index = 0; ranges && index < ranges.length; index += 1) {
      if (ranges.start(index) - slack <= time && time <= ranges.end(index) + EPSILON) return Math.max(time, ranges.end(index))
    }
    return time
  }

  private rangeStart(pipeline: Pipeline, time: number): number {
    const ranges = pipeline.buffer?.buffered
    for (let index = 0; ranges && index < ranges.length; index += 1) {
      if (ranges.start(index) - EPSILON <= time && time <= ranges.end(index) + EPSILON) return Math.min(time, ranges.start(index))
    }
    return time
  }

  private bufferedEnd(pipeline: Pipeline): number {
    const ranges = pipeline.buffer?.buffered
    return ranges?.length ? ranges.end(ranges.length - 1) : 0
  }

  /** Where a preloaded entry that could not be placed after the loaded one goes: after everything appended. */
  private frontier(): number {
    const pipeline = this.pipeline
    return pipeline ? Math.max(this.bufferedEnd(pipeline), this.audio.currentTime) : 0
  }

  /** Moves a `loading` entry along: position first, then playing or paused. */
  private continueLoading(): void {
    const audio = this.audio
    if (this.state !== 'loading' || audio.readyState < HAVE_METADATA) return
    if (this.targetPending) {
      this.targetPending = false
      this.moveTo(this.target ?? 0)
      return
    }
    if (audio.seeking) return
    if (this.wantPlay) {
      if (audio.paused) return this.startAudio()
      // Already playing the entry before it (a preloaded entry loaded early): ready is playing.
      if (this.started === this.generation || audio.readyState < HAVE_FUTURE_DATA) return
      this.target = null
      return this.setState('playing')
    }
    this.target = null
    this.setState('paused')
  }

  private onSeeked(): void {
    if (this.state === 'loading') return this.continueLoading()
    this.target = null
    this.resetProgress()
    this.emitStatus()
    this.kick()
  }

  private onPlaying(): void {
    if (this.state === 'loading') this.target = null
    if (this.state === 'loading' || this.state === 'buffering') this.setState('playing')
    this.applyGain()
  }

  private onWaiting(): void {
    // The end of the last entry looks like a stall from the element's side.
    this.check()
    if (this.state === 'playing' && !this.audio.seeking) this.setState('buffering')
  }

  /** The element paused without being asked (the system took the output, say); report it. */
  private onPaused(): void {
    if (this.state !== 'playing' && this.state !== 'buffering') return
    this.setState('paused')
  }

  private onError(): void {
    const pipeline = this.pipeline
    if (!pipeline || pipeline.closed || !this.current) return
    const message = mediaErrorMessage(this.audio.error?.code)
    if (message === null) return
    pipeline.closed = true
    if (pipeline.failed && pipeline.failed === this.next && this.current.fill) {
      this.cancelFill(this.next)
      this.next = null
      return this.recover()
    }
    this.fail(message)
  }

  /** Reports a boundary the playhead has crossed, or the end of the last entry, and times the next one. */
  private check(): void {
    const item = this.current
    const audio = this.audio
    const running = this.state === 'playing' || this.state === 'buffering'
    if (!item || item.start === null || audio.seeking || (!running && this.state !== 'paused')) return
    if (this.crossed()) return this.advance()
    if (!running) return
    if (!this.next && this.atEnd(audio.currentTime)) return this.finish()
    this.scheduleBoundary()
  }

  private crossed(): boolean {
    const start = this.next?.start
    return start !== null && start !== undefined && this.current?.start !== null && this.audio.currentTime >= start - EPSILON / 2
  }

  private atEnd(time: number): boolean {
    const item = this.current!
    if (!item.fill?.complete || item.end === null) return false
    if (time >= item.end - EPSILON) return true
    // Browsers can stall a few milliseconds short of the last buffered sample.
    return this.audio.readyState < HAVE_FUTURE_DATA && time >= item.end - 0.3
  }

  private advance(): void {
    const finished = this.current!
    const next = this.next!
    this.clearBoundaryTimer()
    this.current = next
    this.next = null
    this.generation += 1
    this.target = null
    this.applyGain()
    this.emit({ type: 'ended', entryId: finished.entryId })
    this.emitStatus()
    this.scheduleBoundary()
  }

  /** The last entry played to its end with nothing after it. */
  private finish(): void {
    const finished = this.current!
    this.clearBoundaryTimer()
    this.state = 'ended'
    this.target = null
    this.boundaryTimer = setTimeout(() => {
      this.boundaryTimer = null
      if (this.state === 'ended') this.audio.pause()
    }, END_PAUSE_MS)
    this.syncWatchdog()
    this.emit({ type: 'ended', entryId: finished.entryId })
    this.emitStatus()
  }

  /** Within a second of the next boundary, a timer reports it on time and the gain change is put on the audio clock. */
  private scheduleBoundary(): void {
    const item = this.current
    if (!item || this.boundaryTimer || this.state !== 'playing') return
    const boundary = this.next?.start ?? (item.fill?.complete ? item.end : null)
    if (boundary === null || boundary === undefined) return
    const remaining = (boundary - this.audio.currentTime) / (this.audio.playbackRate || 1)
    if (remaining > BOUNDARY_WINDOW_SECONDS || remaining < 0) return
    const generation = this.generation
    this.applyGain()
    this.boundaryTimer = setTimeout(() => {
      this.boundaryTimer = null
      if (generation === this.generation) this.check()
    }, remaining * 1000 + 1)
  }

  private clearBoundaryTimer(): void {
    if (this.boundaryTimer) clearTimeout(this.boundaryTimer)
    this.boundaryTimer = null
  }

  /** Asks the element to play and the output to run, and watches for the browser refusing either. */
  private startAudio(): void {
    const generation = this.generation
    this.started = generation
    const context = this.ensureContext()
    const stale = () => generation !== this.generation || !this.wantsSound()
    if (context.state !== 'running') void context.resume().catch(() => {})
    this.audio.play().then(
      () => {
        if (stale() || context.state === 'running') return
        // The element runs but a suspended context outputs silence. Give it a moment.
        setTimeout(() => {
          if (!stale() && context.state !== 'running') this.block()
        }, this.options.resumeTimeoutMs ?? 500)
      },
      (error: unknown) => {
        if (stale()) return
        const failure = playFailure(error)
        if (failure === 'blocked') this.block()
        else if (failure === 'failed') this.fail(mediaErrorMessage(this.audio.error?.code) ?? 'The audio could not be played')
      },
    )
  }

  private wantsSound(): boolean {
    return this.state === 'playing' || this.state === 'buffering' || (this.state === 'loading' && this.wantPlay)
  }

  private block(): void {
    this.audio.pause()
    this.blocked = true
    this.wantPlay = false
    this.target = null
    this.fail(AUDIO_BLOCKED_MESSAGE)
  }

  private fail(message: string): void {
    if (this.state === 'error' || !this.current) return
    this.clearBoundaryTimer()
    // A blocked entry plays once unlocked; a failed one fetches nothing more.
    if (message !== AUDIO_BLOCKED_MESSAGE) this.cancelFill(this.current)
    const entryId = this.current.entryId
    this.state = 'error'
    this.syncWatchdog()
    this.emit({ type: 'error', entryId, message })
    this.emitStatus()
  }

  private ensureContext(): AudioContext {
    if (this.context) return this.context
    const context = this.options.createContext?.() ?? new AudioContext()
    const output = this.options.output?.(context) ?? context.destination
    this.context = context
    this.gainNode = context.createGain()
    context.createMediaElementSource(this.audio).connect(this.gainNode).connect(output)
    this.applyGain()
    return context
  }

  /**
   * The loaded entry's gain, ramped while playing. With the preloaded entry's boundary close,
   * its gain is scheduled there on the audio clock, so the change lands on the boundary.
   */
  private applyGain(): void {
    const node = this.gainNode
    const context = this.context
    const item = this.current
    if (!node || !context || !item) return
    const { gain } = node
    const now = context.currentTime
    const next = this.next
    const crossed = this.crossed()
    const value = crossed ? next!.gain : item.gain
    gain.cancelScheduledValues(now)
    // A jump in gain on a sounding signal clicks; an element that is not playing takes the value at once.
    if (this.audio.paused) {
      gain.setValueAtTime(value, now)
      return
    }
    gain.setTargetAtTime(value, now, GAIN_RAMP_SECONDS / 3)
    if (crossed || !next || next.start === null || next.gain === value) return
    const until = (next.start - this.audio.currentTime) / (this.audio.playbackRate || 1)
    if (until >= 0 && until <= BOUNDARY_WINDOW_SECONDS) gain.setTargetAtTime(next.gain, now + until, BOUNDARY_RAMP_SECONDS / 3)
  }

  /** While playing, a position that stops moving means a stall the element did not announce. */
  private syncWatchdog(): void {
    const watching = this.state === 'playing' || this.state === 'buffering'
    if (!watching) {
      if (this.watchdog) clearInterval(this.watchdog)
      this.watchdog = null
      return
    }
    if (this.watchdog) return
    this.resetProgress()
    this.watchdog = setInterval(() => {
      const position = this.audio.currentTime
      const now = performance.now()
      if (position !== this.lastProgress.position) {
        this.lastProgress = { position, at: now }
        if (this.state === 'buffering' && !this.audio.seeking) this.setState('playing')
      } else if (this.state === 'playing' && now - this.lastProgress.at > (this.options.stallMs ?? 1500)) {
        this.setState('buffering')
      }
      this.check()
      this.kick()
    }, WATCHDOG_MS)
  }

  private resetProgress(): void {
    this.lastProgress = { position: this.audio.currentTime, at: performance.now() }
  }

  private setState(state: EngineState): void {
    if (state === this.state) return
    this.state = state
    this.syncWatchdog()
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

class StreamError extends Error {}

/** The stream URL with the engine's scheduling hint and, for a stream that starts later, `start`. */
function streamUrl(url: string, intent: StreamIntent, startMs: number | null): string {
  const parsed = new URL(url, globalThis.location?.href ?? 'http://localhost/')
  parsed.searchParams.set('intent', intent)
  if (startMs !== null) parsed.searchParams.set('start', String(Math.round(startMs)))
  return parsed.origin === globalThis.location?.origin ? `${parsed.pathname}${parsed.search}` : parsed.href
}

/**
 * Whether the first bytes of a stream are what its type says. Bytes that are not would fail
 * the whole `MediaSource`, the entry already playing with it, so they never reach it.
 */
function looksLike(type: string, bytes: Uint8Array): boolean {
  if (type === 'audio/mpeg') {
    const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33
    return id3 || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
  }
  return bytes.byteLength >= 8 && String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!) === 'ftyp'
}
