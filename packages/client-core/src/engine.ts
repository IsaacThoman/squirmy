import type { PlaybackDescriptor } from '@squirmy/contracts'

/**
 * The audio output each platform implements: `HTMLAudioElement` plus Web Audio on the
 * web, `expo-audio` on mobile. `SessionClient` is its only caller and drives it only
 * while this device is the active one.
 *
 * The engine knows nothing about sessions or queues. It holds at most two entries: the
 * loaded one, which it plays, and the preloaded one, which follows it. Entries are
 * identified by the session's queue entry id, never by track id: the same track can
 * appear twice in a row (repeat one) under different entry ids.
 *
 * The engine never plays, pauses or seeks on its own, apart from moving to the preloaded
 * entry at a natural end. Platform code that reacts to lock-screen controls or audio
 * interruptions dispatches session commands instead of calling the engine, and the
 * client brings the engine along.
 *
 * Events may be emitted synchronously from inside a method call. All times are
 * milliseconds; gains are linear multipliers (1 = unchanged).
 */
export interface PlayerEngine {
  /**
   * Replaces the loaded entry and starts buffering `url` at `startMs`. Plays as soon as
   * it can when `autoplay`, otherwise ends `paused` at `startMs`. Emits `status` with
   * state `loading`, then `playing` or `paused`. Never emits `ended` for the entry it
   * replaces. When `entryId` is the preloaded entry, the engine may reuse its buffer;
   * otherwise the preload is kept.
   */
  load(request: EngineLoad): void
  /**
   * Names the entry that follows the loaded one, or clears it with `null`. The engine
   * should start fetching and decoding it so that it can start without a gap. Replaces
   * any earlier preload. A preload that fails to fetch is dropped silently.
   *
   * When the loaded entry plays to its natural end and a preload is set, the engine
   * starts the preloaded entry at 0 with the preload's gain, playing, and only then
   * emits `ended` for the finished entry (so `getStatus()` already reports the new
   * entry), followed by `status` for the new one. The preload slot is then empty.
   * Without a preload, it emits `ended` and stays on the finished entry in state
   * `ended` at its end position.
   */
  preload(request: EnginePreload | null): void
  /** Starts or resumes the loaded entry. No-op without one or while `loading`/`playing`. */
  play(): void
  /** Pauses the loaded entry. No-op without one. */
  pause(): void
  /**
   * Moves the loaded entry to `positionMs`, clamped to [0, duration]. Keeps playing or
   * paused; from `ended` it becomes `paused`. Emits `status` once the seek has landed.
   */
  seek(positionMs: number): void
  /** Sets the gain of the loaded entry, immediately. Values above 1 boost when the output can. */
  setGain(gain: number): void
  /** Unloads both entries and goes `idle` with `entryId: null`. Emits `status`. */
  stop(): void
  /** The current status, with `positionMs` read now. */
  getStatus(): EngineStatus
  /** Adds an event listener; returns a function that removes it. */
  subscribe(listener: (event: EngineEvent) => void): () => void
}

export type EngineLoad = {
  entryId: string
  /** Absolute, or relative to the page for same-origin web. Needs no headers. */
  url: string
  startMs: number
  autoplay: boolean
  gain: number
  media?: EngineMedia
}

export type EnginePreload = {
  entryId: string
  url: string
  /** Applied when the preloaded entry starts. */
  gain: number
  media?: EngineMedia
}

/**
 * What the playback descriptor says about the stream, for engines that decode it themselves
 * (the iOS native engine) or demux and trim it (Media Source Extensions on the web). Engines
 * that hand the URL to a player ignore it.
 */
export type EngineMedia = {
  /** A server transcode rather than the original file. */
  transcoded: boolean
  /** The stream's exact length and priming, when the server knows them. */
  gapless?: PlaybackDescriptor['gapless']
  /**
   * Names the stream in the app's streaming cache, for an engine that keeps what it streams
   * (see `ResolvedPlayback`). Engines that do not ignore it.
   */
  cacheKey?: string | null
} & Partial<Pick<PlaybackDescriptor, 'profile' | 'mime' | 'codec' | 'sampleRate' | 'durationMs'>>

/**
 * What `SessionPlayer.resolvePlayback` gives: the descriptor, and the key under which the
 * app's streaming cache keeps the stream when the engine fills a file as it plays.
 */
export type ResolvedPlayback = PlaybackDescriptor & { cacheKey?: string | null }

/**
 * - `idle`: nothing loaded.
 * - `loading`: fetching or decoding before the first sample plays.
 * - `buffering`: was playing, waiting for data.
 * - `ended`: the entry played to its end and nothing followed.
 * - `error`: the loaded entry failed; an `error` event was emitted.
 */
export type EngineState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'

export type EngineStatus = {
  entryId: string | null
  state: EngineState
  positionMs: number
}

/**
 * - `status`: emitted on every change of `state` or `entryId`, and after a seek lands.
 *   Not emitted periodically; call `getStatus()` for a fresh position.
 * - `ended`: the entry played to its natural end (never for `stop`, `load` or errors).
 * - `error`: the loaded entry could not be fetched or decoded. State becomes `error`.
 */
export type EngineEvent =
  | { type: 'status'; status: EngineStatus }
  | { type: 'ended'; entryId: string }
  | { type: 'error'; entryId: string; message: string }

type FakeEntry = { entryId: string; url: string; gain: number }

/**
 * In-memory `PlayerEngine` for tests. Position follows the injected clock (default
 * `Date.now`, so fake timers move it) while `playing`. Every method call is recorded in
 * `calls`; `finish`, `buffer`, `resume` and `fail` simulate what real audio does.
 */
export class FakeEngine implements PlayerEngine {
  /** Every method call, in order, e.g. `['load', { … }]`, `['play']`. */
  readonly calls: [method: string, ...args: unknown[]][] = []
  loaded: FakeEntry | null = null
  preloaded: FakeEntry | null = null
  /** Duration used by `seek` clamping and by `finish`. */
  durationMs = 180_000
  /** Leaves each load `loading` until `ready()`, as a stream that takes a while to start. */
  holdLoads = false
  private held: boolean | null = null
  private state: EngineState = 'idle'
  private basePosition = 0
  private baseTime = 0
  private readonly listeners = new Set<(event: EngineEvent) => void>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  load(request: EngineLoad): void {
    this.calls.push(['load', request])
    this.loaded = { entryId: request.entryId, url: request.url, gain: request.gain }
    if (this.preloaded?.entryId === request.entryId) this.preloaded = null
    this.setPosition(request.startMs)
    this.setState('loading')
    if (this.holdLoads) {
      this.held = request.autoplay
      return
    }
    this.setState(request.autoplay ? 'playing' : 'paused')
  }

  /** Finishes a load `holdLoads` kept waiting. */
  ready(): void {
    if (this.held === null || this.state !== 'loading') return
    const autoplay = this.held
    this.held = null
    this.setPosition(this.position())
    this.setState(autoplay ? 'playing' : 'paused')
  }

  preload(request: EnginePreload | null): void {
    this.calls.push(['preload', request])
    this.preloaded = request && { ...request }
  }

  play(): void {
    this.calls.push(['play'])
    if (!this.loaded || this.state === 'playing' || this.state === 'loading') return
    this.setPosition(this.position())
    this.setState('playing')
  }

  pause(): void {
    this.calls.push(['pause'])
    if (!this.loaded) return
    this.setPosition(this.position())
    this.setState('paused')
  }

  seek(positionMs: number): void {
    this.calls.push(['seek', positionMs])
    if (!this.loaded) return
    this.setPosition(Math.min(this.durationMs, Math.max(0, positionMs)))
    if (this.state === 'ended') this.state = 'paused'
    this.emit({ type: 'status', status: this.getStatus() })
  }

  setGain(gain: number): void {
    this.calls.push(['setGain', gain])
    if (this.loaded) this.loaded.gain = gain
  }

  stop(): void {
    this.calls.push(['stop'])
    this.loaded = null
    this.preloaded = null
    this.setPosition(0)
    this.setState('idle')
  }

  getStatus(): EngineStatus {
    return { entryId: this.loaded?.entryId ?? null, state: this.state, positionMs: this.position() }
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Simulates the loaded entry reaching its natural end, following the preload contract. */
  finish(): void {
    const finished = this.loaded
    if (!finished) return
    if (this.preloaded) {
      this.loaded = this.preloaded
      this.preloaded = null
      this.setPosition(0)
      this.state = 'playing'
      this.emit({ type: 'ended', entryId: finished.entryId })
      this.emit({ type: 'status', status: this.getStatus() })
    } else {
      this.setPosition(this.durationMs)
      this.state = 'ended'
      this.emit({ type: 'ended', entryId: finished.entryId })
      this.emit({ type: 'status', status: this.getStatus() })
    }
  }

  /** Simulates a buffer underrun while playing. */
  buffer(): void {
    this.setPosition(this.position())
    this.setState('buffering')
  }

  /** Simulates recovering from `buffer()`. */
  resume(): void {
    this.setPosition(this.position())
    this.setState('playing')
  }

  /** Simulates a fetch or decode failure of the loaded entry. */
  fail(message = 'failed'): void {
    if (!this.loaded) return
    this.setPosition(this.position())
    this.state = 'error'
    this.emit({ type: 'error', entryId: this.loaded.entryId, message })
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private position(): number {
    const elapsed = this.state === 'playing' ? this.now() - this.baseTime : 0
    return Math.min(this.durationMs, this.basePosition + elapsed)
  }

  private setPosition(positionMs: number): void {
    this.basePosition = positionMs
    this.baseTime = this.now()
  }

  private setState(state: EngineState): void {
    if (state === this.state && state !== 'idle') return
    this.state = state
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}
