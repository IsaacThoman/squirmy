import type { EngineEvent, EngineLoad, EnginePreload, EngineStatus } from '@squirmy/client-core'
import type { PlaybackQuery } from '@squirmy/contracts'
import type { EqGains } from './equalizer'
import { EngineOutput, supportsLimiter, type AttachOutput, type OutputOptions } from './output'
import type { BrowserEngine } from './types'

/** What `CrossfadeEngine` needs of the two engines it plays on. */
export type InnerEngine = BrowserEngine & {
  /** The loaded entry's length, when known. */
  entryDurationMs(): number | null
}

/** What `CrossfadeEngine` gives each inner engine: its shared context, and a stage of its graph to play into. */
export type InnerOptions = { createContext: () => AudioContext; attachOutput: AttachOutput }

export type CrossfadeEngineOptions = {
  /** Makes one of the two engines, with `options` added to its own. */
  createEngine: (options: InnerOptions) => InnerEngine
  createContext?: () => AudioContext
  /** The node the output chain plays into. Defaults to the context's destination; the dev page inserts its instruments. */
  output?: (context: AudioContext) => AudioNode
  /** Whether the limiter can run here. Defaults to whether AudioWorklet exists. */
  limiter?: boolean
  createLimiter?: OutputOptions['createLimiter']
  /** How often the end of a playing entry is looked for. */
  watchMs?: number
}

/** Crossfade lengths offered: off, or 2 to 12 seconds. */
export const CROSSFADE_SECONDS = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const

const WATCH_MS = 100
/** The incoming entry is asked to play this long before its fade is due: an element takes tens of milliseconds to start. */
const START_LEAD_MS = 150
/** A fade cut short (a pause, seek or load mid-fade) settles over this long instead of clicking. */
const SETTLE_SECONDS = 0.01
/** Points on each fade curve, between which the audio clock interpolates linearly. */
const CURVE_POINTS = 256

type Slot = { engine: InnerEngine; fade: GainNode | null; limiterChanged: (() => void) | null }

/** The preloaded entry, loaded paused on the other engine, ready to fade in. */
type Standby = { request: EnginePreload; ready: boolean; starting: boolean }

/** A fade under way: the outgoing slot, and the timer that stops it once it is silent. */
type Fade = { outgoing: Slot; timer: ReturnType<typeof setTimeout> }

/**
 * `PlayerEngine` that crossfades between songs, on two of the page's engines (`MseEngine` or
 * `WebPlayerEngine`) sharing one `AudioContext` and one `OutputChain`. Each engine plays into
 * a fade gain of its own in front of the chain, so the fade is mixed before the equalizer and
 * limited after it.
 *
 * With crossfade off, or when the next entry `continuesAlbum`, everything goes to the active
 * engine, which plays the preload gaplessly as it would on its own. Otherwise the preload is
 * loaded, paused at its start, on the other engine. When the active entry is the fade's length
 * from its end the other engine plays, and from its first `playing` both fade gains follow
 * equal-power curves (cosine out, sine in) on the audio clock, each entry at its own gain. At
 * that moment `ended` goes out for the outgoing entry and the incoming one becomes active, as
 * the client-core contract says of an engine that crossfades. A pause, seek, load or stop in
 * the middle of a fade ends it at once (10 ms), as a user's skip does.
 */
export class CrossfadeEngine implements BrowserEngine {
  readonly limiter: boolean
  readonly canBoost: boolean
  private readonly options: CrossfadeEngineOptions
  private readonly slots: [Slot, Slot]
  private active: Slot
  private readonly output = new EngineOutput()
  private context: AudioContext | null = null
  private seconds = 0
  private preloaded: EnginePreload | null = null
  private standby: Standby | null = null
  private fade: Fade | null = null
  private watcher: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private readonly detach: (() => void)[] = []

  constructor(options: CrossfadeEngineOptions) {
    this.options = options
    this.limiter = options.limiter ?? supportsLimiter()
    this.canBoost = this.limiter
    const make = (): Slot => {
      const slot: Slot = { engine: null as unknown as InnerEngine, fade: null, limiterChanged: null }
      slot.engine = options.createEngine({
        createContext: () => this.ensureContext(),
        attachOutput: (context, onLimiterChange) => this.attach(slot, context, onLimiterChange),
      })
      this.detach.push(slot.engine.subscribe(event => this.onEvent(slot, event)))
      return slot
    }
    this.slots = [make(), make()]
    this.active = this.slots[0]
  }

  /** The engine playing the loaded entry (the dev page inspects it). */
  activeEngine(): InnerEngine {
    return this.active.engine
  }

  playbackQuery(): Pick<PlaybackQuery, 'codecs' | 'containers' | 'engine'> {
    return this.active.engine.playbackQuery()
  }

  /** Crossfades over `seconds` from the next song on; 0 turns it off. */
  setCrossfade(seconds: number): void {
    if (seconds === this.seconds) return
    this.seconds = Math.max(0, seconds)
    this.route()
  }

  load(request: EngineLoad): void {
    this.settle()
    const standby = this.standby
    if (standby?.request.entryId === request.entryId && standby.request.url === request.url) {
      // The preloaded entry, already loaded paused on the other engine: it takes over there.
      const previous = this.active
      this.active = this.other(previous)
      this.standby = null
      this.preloaded = null
      previous.engine.stop()
      const { engine } = this.active
      engine.setGain(request.gain)
      this.emit({ type: 'status', status: { entryId: request.entryId, state: 'loading', positionMs: request.startMs } })
      if (request.startMs > 0) engine.seek(request.startMs)
      if (request.autoplay) engine.play()
      else this.emit({ type: 'status', status: engine.getStatus() })
      return this.sync()
    }
    this.active.engine.load(request)
    this.sync()
  }

  preload(request: EnginePreload | null): void {
    this.preloaded = request
    this.route()
  }

  play(): void {
    this.settle()
    this.active.engine.play()
    this.sync()
  }

  pause(): void {
    this.settle()
    this.active.engine.pause()
    this.sync()
  }

  seek(positionMs: number): void {
    this.settle()
    this.active.engine.seek(positionMs)
    this.sync()
  }

  setGain(gain: number): void {
    this.active.engine.setGain(gain)
  }

  stop(): void {
    this.settle()
    this.dropStandby()
    this.preloaded = null
    this.other(this.active).engine.stop()
    this.active.engine.stop()
    this.sync()
  }

  getStatus(): EngineStatus {
    return this.active.engine.getStatus()
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  isBlocked(): boolean {
    return this.active.engine.isBlocked()
  }

  unlock(): void {
    this.active.engine.unlock()
  }

  warm(): void {
    this.active.engine.warm()
  }

  setEqualizer(gains: EqGains | null): void {
    this.output.setEqualizer(gains)
  }

  setOutputDevice(sinkId: string): Promise<void> {
    return this.output.setSink(sinkId)
  }

  dispose(): void {
    if (this.fade) clearTimeout(this.fade.timer)
    this.fade = null
    this.stopWatching()
    for (const detach of this.detach.splice(0)) detach()
    for (const slot of this.slots) slot.engine.dispose()
    this.output.dispose()
    void this.context?.close().catch(() => {})
    this.context = null
  }

  private ensureContext(): AudioContext {
    this.context ??= this.options.createContext?.() ?? new AudioContext()
    return this.context
  }

  /** One engine's stage: its fade gain, into the chain both share (made with the first). */
  private attach(slot: Slot, context: AudioContext, onLimiterChange: () => void) {
    const chain = this.output.chain ?? this.output.attach(context, this.options.output?.(context) ?? context.destination, {
      createLimiter: this.limiter ? this.options.createLimiter : null,
      onLimiterChange: () => { for (const each of this.slots) each.limiterChanged?.() },
    })
    slot.fade = context.createGain()
    slot.fade.connect(chain.input)
    slot.limiterChanged = onLimiterChange
    return { input: slot.fade, headroom: (gain: number) => chain.headroom(gain) }
  }

  private other(slot: Slot): Slot {
    return slot === this.slots[0] ? this.slots[1] : this.slots[0]
  }

  /** Where the preload goes: the active engine (gapless), or the other one, to fade in. */
  private route(): void {
    const request = this.preloaded
    if (!request || this.seconds === 0 || request.continuesAlbum) {
      this.dropStandby()
      this.active.engine.preload(request)
      return this.sync()
    }
    this.active.engine.preload(null)
    const standby = this.standby
    if (standby?.request.entryId === request.entryId && standby.request.url === request.url) {
      standby.request = request
      this.other(this.active).engine.setGain(request.gain)
      return this.sync()
    }
    this.dropStandby()
    // The other engine is still fading out: the preload waits for it.
    if (this.fade) return
    this.standby = { request, ready: false, starting: false }
    const { engine } = this.other(this.active)
    // Its fade gain must exist before it plays (an element engine joins the graph on its first play).
    engine.warm()
    engine.load({ ...request, startMs: 0, autoplay: false })
    this.sync()
  }

  private dropStandby(): void {
    if (!this.standby) return
    this.standby = null
    if (!this.fade) this.other(this.active).engine.stop()
  }

  private onEvent(slot: Slot, event: EngineEvent): void {
    if (slot === this.active) {
      this.emit(event)
      return this.sync()
    }
    if (this.fade?.outgoing === slot) return
    const standby = this.standby
    if (!standby) return
    if (event.type === 'error') return this.standbyFailed()
    if (event.type !== 'status' || event.status.entryId !== standby.request.entryId) return
    if (event.status.state === 'paused' && !standby.starting) standby.ready = true
    if (event.status.state === 'playing' && standby.starting) this.begin()
    this.sync()
  }

  /** The preload could not be loaded, or would not start: the active engine plays it after its end, as it would without a fade. */
  private standbyFailed(): void {
    const request = this.standby!.request
    this.standby = null
    this.other(this.active).engine.stop()
    this.active.engine.preload(request)
    this.sync()
  }

  /** Plays the incoming entry once the active one is the fade's length (and a little) from its end. */
  private watch(): void {
    const standby = this.standby
    if (!standby?.ready || standby.starting) return
    const { engine } = this.active
    const status = engine.getStatus()
    const duration = engine.entryDurationMs()
    if (status.state !== 'playing' || duration === null) return
    if (duration - status.positionMs > this.fadeMs(duration) + START_LEAD_MS) return
    standby.starting = true
    this.other(this.active).engine.play()
  }

  /** The fade's length for an outgoing entry `duration` long: the setting, but no more than half of either song. */
  private fadeMs(duration: number): number {
    const incoming = this.standby?.request.media?.durationMs
    return Math.min(this.seconds * 1000, duration / 2, incoming ? incoming / 2 : Infinity)
  }

  /** The incoming entry plays: both fades start now, and the outgoing entry has ended as far as the session is concerned. */
  private begin(): void {
    const outgoing = this.active
    const incoming = this.other(outgoing)
    const status = outgoing.engine.getStatus()
    const duration = outgoing.engine.entryDurationMs() ?? status.positionMs
    const seconds = Math.max(0.05, Math.min(this.fadeMs(duration), duration - status.positionMs) / 1000)
    const context = this.ensureContext()
    const now = context.currentTime
    curve(outgoing.fade, now, seconds, angle => Math.cos(angle))
    curve(incoming.fade, now, seconds, angle => Math.sin(angle))
    this.standby = null
    this.preloaded = null
    this.active = incoming
    const timer = setTimeout(() => this.finishFade(), seconds * 1000 + 100)
    this.fade = { outgoing, timer }
    this.emit({ type: 'ended', entryId: status.entryId! })
    this.emit({ type: 'status', status: incoming.engine.getStatus() })
    this.sync()
  }

  /** The outgoing entry has faded out: its engine stops, ready for the next preload. */
  private finishFade(): void {
    const fade = this.fade
    if (!fade) return
    clearTimeout(fade.timer)
    this.fade = null
    fade.outgoing.engine.stop()
    const gain = fade.outgoing.fade?.gain
    if (gain && this.context) {
      gain.cancelScheduledValues(this.context.currentTime)
      gain.setValueAtTime(1, this.context.currentTime)
    }
    // A preload that came during the fade waited for this engine.
    if (this.preloaded && !this.standby) this.route()
  }

  /** Ends a fade at once (a user's pause, seek, load or stop), without a click. */
  private settle(): void {
    const fade = this.fade
    if (!fade || !this.context) return
    const now = this.context.currentTime
    for (const [slot, value] of [[fade.outgoing, 0], [this.active, 1]] as const) {
      const gain = slot.fade?.gain
      if (!gain) continue
      // Held where the curve is now; Firefox has no `cancelAndHoldAtTime`, so there the value is read.
      if (typeof gain.cancelAndHoldAtTime === 'function') {
        gain.cancelAndHoldAtTime(now)
      } else {
        const held = gain.value
        gain.cancelScheduledValues(now)
        gain.setValueAtTime(held, now)
      }
      gain.linearRampToValueAtTime(value, now + SETTLE_SECONDS)
    }
    clearTimeout(fade.timer)
    fade.timer = setTimeout(() => this.finishFade(), SETTLE_SECONDS * 1000 + 20)
  }

  /** Looks for the fade's start while there is one to make. */
  private sync(): void {
    const wanted = this.standby !== null && this.active.engine.getStatus().state === 'playing'
    if (wanted && !this.watcher) {
      this.watcher = setInterval(() => this.watch(), this.options.watchMs ?? WATCH_MS)
      this.watch()
    } else if (!wanted) {
      this.stopWatching()
    }
  }

  private stopWatching(): void {
    if (this.watcher) clearInterval(this.watcher)
    this.watcher = null
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

/** Sets `node`'s gain along `shape` of a quarter turn (0 to π/2) over `seconds` from `at`, on the audio clock. */
function curve(node: GainNode | null, at: number, seconds: number, shape: (angle: number) => number): void {
  if (!node) return
  const values = new Float32Array(CURVE_POINTS)
  for (let index = 0; index < CURVE_POINTS; index += 1) values[index] = shape((index / (CURVE_POINTS - 1)) * Math.PI / 2)
  // The ends exactly: silent, and untouched.
  values[0] = shape(0) > 0.5 ? 1 : 0
  values[CURVE_POINTS - 1] = shape(Math.PI / 2) > 0.5 ? 1 : 0
  node.gain.cancelScheduledValues(at)
  node.gain.setValueCurveAtTime(values, at, seconds)
}
