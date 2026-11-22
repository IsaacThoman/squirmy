import type { EngineEvent, EngineLoad, EnginePreload, EngineState, EngineStatus, PlayerEngine } from '@squirmy/client-core'
import { AUDIO_BLOCKED_MESSAGE, clampPosition, mediaErrorMessage, playFailure } from './errors'

type Entry = { entryId: string; url: string; gain: number }

/** An audio element with its own gain stage, so the loaded and preloaded entries keep separate gains. */
type Voice = { audio: HTMLAudioElement; gain: GainNode | null; entry: Entry | null }

export type WebEngineOptions = {
  createAudio?: () => HTMLAudioElement
  createContext?: () => AudioContext
  /** The node voices play into. Defaults to the context's destination; the dev page inserts an analyser. */
  output?: (context: AudioContext) => AudioNode
  /** How long a suspended `AudioContext` gets to resume before audio counts as blocked. */
  resumeTimeoutMs?: number
  /** Playing without the position moving for this long counts as buffering. */
  stallMs?: number
  /** How long before the current entry's end the preloaded one starts playing. */
  handoffLeadMs?: number
}

const HAVE_METADATA = 1
const HAVE_FUTURE_DATA = 3
const WATCHDOG_MS = 250
/**
 * Starting the next entry only on `ended` leaves a gap of that event's delay plus the time the
 * element takes to produce sound, and the first grows with whatever else the page is doing. So
 * the next entry starts on a timer just before the end instead, and `ended` swaps the voices.
 */
const HANDOFF_LEAD_MS = 4
/** `timeupdate` comes at least every 250 ms; within this much of the end it schedules the start. */
const HANDOFF_WINDOW_MS = 1000
/** Still not ended this long after the next entry started: the length was wrong, so undo the start. */
const HANDOFF_GRACE_MS = 250

/**
 * `PlayerEngine` on `HTMLAudioElement`s routed through Web Audio.
 *
 * Two voices alternate: the loaded entry plays on one while the preloaded entry buffers on
 * the other, and at a natural end the voices swap. Each voice runs through its own
 * `GainNode`, so normalization can boost above unity (`canBoost`). The `AudioContext` is
 * created on the first play and resumed whenever play is requested.
 *
 * When the browser's autoplay policy refuses to start audio, the entry goes to `error`
 * with `AUDIO_BLOCKED_MESSAGE` and `isBlocked()` turns true until `unlock()` is called
 * from a user gesture, which starts the blocked playback.
 */
export class WebPlayerEngine implements PlayerEngine {
  readonly canBoost = true
  private readonly options: WebEngineOptions
  private context: AudioContext | null = null
  private current: Voice
  private spare: Voice
  private state: EngineState = 'idle'
  /** Where a load or seek is heading; reported until the element gets there. */
  private target: number | null = null
  /** The target still has to be applied to the element once its metadata is known. */
  private targetPending = false
  private wantPlay = false
  private blocked = false
  /** Bumped by every load and stop, so late callbacks of an earlier entry do nothing. */
  private generation = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  /** Starts the preloaded entry just before the current one ends, then gives up if it does not end. */
  private handoffTimer: ReturnType<typeof setTimeout> | null = null
  /** The preloaded entry is already playing, ahead of the current one's end. */
  private handedOff = false
  /** The generation whose end came later than its length said; it waits for `ended` instead. */
  private handoffMissed = -1
  private lastProgress = { position: 0, at: 0 }
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private readonly detach: (() => void)[] = []

  constructor(options: WebEngineOptions = {}) {
    this.options = options
    this.current = this.createVoice()
    this.spare = this.createVoice()
  }

  load(request: EngineLoad): void {
    this.generation += 1
    this.cancelHandoff()
    const reuse = this.spare.entry?.entryId === request.entryId
    if (reuse) {
      [this.current, this.spare] = [this.spare, this.current]
      this.clear(this.spare)
    } else {
      this.current.audio.pause()
    }
    const voice = this.current
    voice.entry = { entryId: request.entryId, url: request.url, gain: request.gain }
    this.applyGain(voice)
    this.target = Math.max(0, request.startMs)
    this.targetPending = true
    this.wantPlay = request.autoplay
    this.blocked = false
    // A new entry always announces itself, even when the previous one was loading too.
    this.state = 'loading'
    this.syncWatchdog()
    this.emitStatus()
    if (!reuse) {
      voice.audio.src = request.url
      voice.audio.load()
    }
    this.continueLoading()
  }

  preload(request: EnginePreload | null): void {
    const spare = this.spare
    if (request && spare.entry?.entryId === request.entryId && spare.entry.url === request.url) {
      spare.entry.gain = request.gain
      return this.applyGain(spare)
    }
    this.cancelHandoff()
    if (!request) return this.clear(spare)
    spare.entry = { ...request }
    this.applyGain(spare)
    spare.audio.src = request.url
    spare.audio.load()
  }

  play(): void {
    if (!this.current.entry || this.state === 'loading' || this.state === 'playing' || this.state === 'buffering') return
    if (this.state === 'error' && !this.blocked) return
    this.blocked = false
    this.setState('playing')
    this.startAudio()
  }

  pause(): void {
    if (!this.current.entry) return
    this.wantPlay = false
    this.cancelHandoff()
    this.current.audio.pause()
    if (this.state === 'loading') return this.continueLoading()
    if (this.state === 'error' && !this.blocked) return
    this.blocked = false
    this.setState('paused')
  }

  seek(positionMs: number): void {
    const { audio, entry } = this.current
    if (!entry || (this.state === 'error' && !this.blocked)) return
    this.cancelHandoff()
    this.target = clampPosition(positionMs, audio.duration)
    if (this.state === 'loading') {
      this.targetPending = true
      return this.continueLoading()
    }
    if (this.state === 'ended') this.state = 'paused'
    audio.currentTime = this.target / 1000
  }

  setGain(gain: number): void {
    if (!this.current.entry) return
    this.current.entry.gain = gain
    this.applyGain(this.current)
  }

  stop(): void {
    this.generation += 1
    this.cancelHandoff()
    this.clear(this.current)
    this.clear(this.spare)
    this.target = null
    this.wantPlay = false
    this.blocked = false
    this.state = 'idle'
    this.syncWatchdog()
    this.emitStatus()
  }

  getStatus(): EngineStatus {
    const { entry, audio } = this.current
    if (!entry) return { entryId: null, state: this.state, positionMs: 0 }
    return { entryId: entry.entryId, state: this.state, positionMs: this.target ?? Math.round(audio.currentTime * 1000) }
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The browser refused to start audio; `unlock()` from a click or key press fixes it. */
  isBlocked(): boolean {
    return this.blocked
  }

  /**
   * Call from a user gesture. Resumes the audio output and, when playback was blocked,
   * starts it: the play that was asked for, not one the engine decided on.
   */
  unlock(): void {
    this.warm()
    if (!this.blocked) return
    this.blocked = false
    this.state = 'paused'
    this.play()
  }

  /**
   * Call from a user gesture. Starts the audio output ahead of the first play: opening the
   * output device takes a moment, which would otherwise come after the stream has loaded,
   * as silence. Starts nothing the browser held back; that is `unlock`.
   */
  warm(): void {
    void this.ensureContext().resume().catch(() => {})
  }

  /** Stops playback and releases the elements and the audio context. */
  dispose(): void {
    this.stop()
    for (const detach of this.detach.splice(0)) detach()
    void this.context?.close().catch(() => {})
    this.context = null
  }

  private createVoice(): Voice {
    const audio = this.options.createAudio?.() ?? new Audio()
    audio.preload = 'auto'
    // A cross-origin stream must pass CORS to be heard through Web Audio; failing loudly beats silence.
    audio.crossOrigin = 'anonymous'
    const voice: Voice = { audio, gain: null, entry: null }
    const on = (type: string, handler: () => void) => {
      audio.addEventListener(type, handler)
      this.detach.push(() => audio.removeEventListener(type, handler))
    }
    const whenCurrent = (handler: () => void) => () => { if (voice === this.current && voice.entry) handler() }
    on('loadedmetadata', whenCurrent(() => this.continueLoading()))
    on('canplay', whenCurrent(() => this.continueLoading()))
    on('seeked', whenCurrent(() => this.onSeeked()))
    on('playing', whenCurrent(() => this.onPlaying()))
    // Waiting during a seek is the seek itself; `seeked` reports where it landed.
    on('waiting', whenCurrent(() => { if (this.state === 'playing' && !audio.seeking) this.setState('buffering') }))
    on('pause', whenCurrent(() => this.onPaused()))
    on('ended', whenCurrent(() => this.onEnded()))
    on('timeupdate', whenCurrent(() => this.scheduleHandoff()))
    // A length that changes while playing (an estimate corrected) moves the end.
    on('durationchange', whenCurrent(() => this.cancelHandoff()))
    on('error', () => this.onError(voice))
    return voice
  }

  /** Moves a `loading` entry along: position first, then playing or paused. */
  private continueLoading(): void {
    const { audio } = this.current
    if (this.state !== 'loading' || audio.readyState < HAVE_METADATA) return
    if (this.targetPending) {
      this.targetPending = false
      const target = clampPosition(this.target ?? 0, audio.duration)
      this.target = target
      if (Math.abs(audio.currentTime * 1000 - target) > 1) {
        audio.currentTime = target / 1000
        return
      }
    }
    if (audio.seeking) return
    // `paused` turns false as soon as play() is called, so this asks only once.
    if (this.wantPlay) {
      if (audio.paused) this.startAudio()
      return
    }
    this.target = null
    this.setState('paused')
  }

  private onSeeked(): void {
    if (this.state === 'loading') return this.continueLoading()
    this.target = null
    this.resetProgress()
    this.emitStatus()
  }

  private onPlaying(): void {
    if (this.state === 'loading') this.target = null
    if (this.state === 'loading' || this.state === 'buffering') this.setState('playing')
  }

  /** The element paused without being asked (the system took the output, say); report it. */
  private onPaused(): void {
    const { audio } = this.current
    if (audio.ended || (this.state !== 'playing' && this.state !== 'buffering')) return
    this.setState('paused')
  }

  private onEnded(): void {
    const finished = this.current.entry!.entryId
    const next = this.spare
    if (this.handoffTimer) clearTimeout(this.handoffTimer)
    this.handoffTimer = null
    this.handedOff = false
    if (next.entry) {
      [this.current, this.spare] = [next, this.current]
      this.clear(this.spare)
      this.generation += 1
      this.target = null
      this.wantPlay = true
      this.state = 'playing'
      // Usually already playing since the hand-off; this still watches for the browser refusing it.
      this.startAudio()
      this.emit({ type: 'ended', entryId: finished })
      this.syncWatchdog()
      this.emitStatus()
      return
    }
    this.state = 'ended'
    this.syncWatchdog()
    this.emit({ type: 'ended', entryId: finished })
    this.emitStatus()
  }

  private onError(voice: Voice): void {
    if (!voice.entry) return
    const message = mediaErrorMessage(voice.audio.error?.code)
    if (message === null) return
    // A preload that fails is dropped silently; the entry loads afresh when its turn comes.
    if (voice === this.spare) return this.clear(voice)
    this.fail(message)
  }

  /** Asks the element to play and the output to run, and watches for the browser refusing either. */
  private startAudio(): void {
    const voice = this.current
    const generation = this.generation
    const context = this.ensureContext()
    const stale = () => generation !== this.generation || voice !== this.current || !this.wantsSound()
    if (context.state !== 'running') void context.resume().catch(() => {})
    voice.audio.play().then(
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
        else if (failure === 'failed') this.fail(mediaErrorMessage(voice.audio.error?.code) ?? 'The audio could not be played')
      },
    )
  }

  private wantsSound(): boolean {
    return this.state === 'playing' || this.state === 'buffering' || (this.state === 'loading' && this.wantPlay)
  }

  private block(): void {
    this.current.audio.pause()
    this.blocked = true
    this.wantPlay = false
    this.target = null
    this.fail(AUDIO_BLOCKED_MESSAGE)
  }

  private fail(message: string): void {
    if (this.state === 'error') return
    this.cancelHandoff()
    const entryId = this.current.entry!.entryId
    this.state = 'error'
    this.syncWatchdog()
    this.emit({ type: 'error', entryId, message })
    this.emitStatus()
  }

  private ensureContext(): AudioContext {
    if (this.context) return this.context
    const context = this.options.createContext?.() ?? new AudioContext()
    const output = this.options.output?.(context) ?? context.destination
    for (const voice of [this.current, this.spare]) {
      voice.gain = context.createGain()
      context.createMediaElementSource(voice.audio).connect(voice.gain).connect(output)
      this.applyGain(voice)
    }
    this.context = context
    return context
  }

  private applyGain(voice: Voice): void {
    if (!voice.gain || !voice.entry || !this.context) return
    voice.gain.gain.setValueAtTime(voice.entry.gain, this.context.currentTime)
  }

  private clear(voice: Voice): void {
    voice.entry = null
    voice.audio.pause()
    if (voice.audio.hasAttribute('src')) {
      voice.audio.removeAttribute('src')
      voice.audio.load()
    }
  }

  /** Near the end of a playing entry, times the start of the preloaded one; each `timeupdate` refines it. */
  private scheduleHandoff(): void {
    const { audio } = this.current
    const spare = this.spare
    const entry = spare.entry
    if (this.handedOff || this.handoffMissed === this.generation || this.state !== 'playing' || audio.seeking || this.context?.state !== 'running') return
    if (!entry || spare.audio.readyState < HAVE_FUTURE_DATA || spare.audio.seeking) return
    const remainingMs = ((audio.duration - audio.currentTime) * 1000) / (audio.playbackRate || 1)
    if (!Number.isFinite(remainingMs) || remainingMs > HANDOFF_WINDOW_MS) return
    const lead = this.options.handoffLeadMs ?? HANDOFF_LEAD_MS
    const generation = this.generation
    if (this.handoffTimer) clearTimeout(this.handoffTimer)
    this.handoffTimer = setTimeout(() => {
      this.handoffTimer = null
      if (generation !== this.generation || this.state !== 'playing' || this.spare.entry !== entry || this.current.audio.paused) return
      this.handedOff = true
      // A refusal shows again when `ended` starts it the usual way.
      spare.audio.play().catch(() => {})
      this.handoffTimer = setTimeout(() => {
        this.handoffTimer = null
        this.handoffMissed = generation
        this.cancelHandoff()
      }, lead + HANDOFF_GRACE_MS)
    }, Math.max(0, remainingMs - lead))
  }

  /** Undoes an early start: the preloaded entry waits at its beginning again. */
  private cancelHandoff(): void {
    if (this.handoffTimer) clearTimeout(this.handoffTimer)
    this.handoffTimer = null
    if (!this.handedOff) return
    this.handedOff = false
    const { audio, entry } = this.spare
    audio.pause()
    if (entry) audio.currentTime = 0
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
      const position = this.current.audio.currentTime
      const now = performance.now()
      if (position !== this.lastProgress.position) {
        this.lastProgress = { position, at: now }
        if (this.state === 'buffering' && !this.current.audio.seeking) this.setState('playing')
      } else if (this.state === 'playing' && now - this.lastProgress.at > (this.options.stallMs ?? 1500)) {
        this.setState('buffering')
      }
    }, WATCHDOG_MS)
  }

  private resetProgress(): void {
    this.lastProgress = { position: this.current.audio.currentTime, at: performance.now() }
  }

  private setState(state: EngineState): void {
    if (state === this.state) return
    if (state !== 'playing') this.cancelHandoff()
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
