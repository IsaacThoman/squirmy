import { EQ_BANDS, EQ_Q, isFlat, preampDb, type EqGains } from './equalizer'
import { LIMITER_PROCESSOR } from './limiter-worklet.js'

/** An equalizer change, or one between the filters and none, settles over this long instead of clicking. */
const EQ_RAMP_SECONDS = 0.01

/** `AudioContext.setSinkId`, in Chromium 110 and later; not in TypeScript's DOM types yet. */
type SinkContext = BaseAudioContext & { setSinkId?: (sinkId: string) => Promise<void> }

export type OutputOptions = {
  /**
   * Makes the limiter node once its module has loaded. Defaults to the AudioWorklet in
   * limiter-worklet.js; null leaves the limiter out (no AudioWorklet: an insecure context).
   */
  createLimiter?: ((context: BaseAudioContext) => Promise<AudioNode>) | null
  /** The limiter came into the chain, or could not: gains above 1 are allowed only with it. */
  onLimiterChange?: () => void
}

/** Whether this page can run the limiter: AudioWorklet exists only in secure contexts (HTTPS, localhost). */
export function supportsLimiter(): boolean {
  return typeof AudioWorkletNode === 'function'
}

/** Whether this browser can send Web Audio to an output device of the page's choosing. */
export function supportsOutputDevice(): boolean {
  return typeof AudioContext === 'function' && 'setSinkId' in AudioContext.prototype
}

/** The default limiter: limiter-worklet.js, served from the app's own assets as the CSP's `script-src 'self'` requires. */
async function workletLimiter(context: BaseAudioContext): Promise<AudioNode> {
  await context.audioWorklet.addModule(new URL('./limiter-worklet.js', import.meta.url))
  return new AudioWorkletNode(context, LIMITER_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' })
}

/**
 * The end of the browser engines' audio graph, after each entry's own gain:
 *
 *     input ─┬──────────── dry ─┬─ limiter ─ destination
 *            └ preamp ─ 10 peaking filters ─ wet ┘
 *
 * With the equalizer flat the filters are faded out (`wet` 0, `dry` 1), so what plays is the
 * entry's samples as they are. The true-peak limiter is an AudioWorklet that loads after the
 * context starts; until it is in the chain, and if it never is, `headroom` holds gains to 1,
 * so nothing is turned up without it. The output device is the context's (`setSinkId`).
 */
export class OutputChain {
  /** Where each entry's gain node connects. */
  readonly input: GainNode
  private readonly context: SinkContext
  private readonly bus: GainNode
  private readonly dry: GainNode
  private readonly wet: GainNode
  private readonly preamp: GainNode | null
  private readonly filters: BiquadFilterNode[]
  private limiter: AudioNode | null = null
  private limiterState: 'loading' | 'ready' | 'none' = 'none'
  private equalized = false
  private disposed = false

  constructor(context: BaseAudioContext, destination: AudioNode, options: OutputOptions = {}) {
    this.context = context
    this.input = context.createGain()
    this.bus = context.createGain()
    this.dry = context.createGain()
    this.wet = context.createGain()
    this.wet.gain.value = 0
    this.input.connect(this.dry).connect(this.bus)
    // A context without filters (a test's) plays without the equalizer.
    const filters = typeof context.createBiquadFilter === 'function'
    this.preamp = filters ? context.createGain() : null
    this.filters = filters ? EQ_BANDS.map(frequency => {
      const filter = context.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = frequency
      filter.Q.value = EQ_Q
      filter.gain.value = 0
      return filter
    }) : []
    if (this.preamp) {
      let previous: AudioNode = this.input.connect(this.preamp)
      for (const filter of this.filters) previous = previous.connect(filter)
      previous.connect(this.wet).connect(this.bus)
    }
    // Until the limiter loads the output plays without it, held to unity gain.
    this.bus.connect(destination)
    const createLimiter = options.createLimiter === undefined ? (supportsLimiter() ? workletLimiter : null) : options.createLimiter
    if (!createLimiter) return
    this.limiterState = 'loading'
    createLimiter(context).then(
      node => {
        if (this.disposed) return
        this.limiter = node
        this.bus.disconnect()
        this.bus.connect(node).connect(destination)
        this.limiterState = 'ready'
        options.onLimiterChange?.()
      },
      () => {
        if (this.disposed) return
        this.limiterState = 'none'
        options.onLimiterChange?.()
      },
    )
  }

  /** The limiter is in the chain, so a gain above 1 cannot clip. */
  get limiting(): boolean {
    return this.limiterState === 'ready'
  }

  /** `gain`, or 1 if it is more than that and the limiter is not in the chain. */
  headroom(gain: number): number {
    return this.limiting ? gain : Math.min(gain, 1)
  }

  /** Sets the bands, in dB; flat (or null) takes the filters out of what plays. Ramped, so a change mid-song does not click. */
  setEqualizer(gains: EqGains | null): void {
    if (!this.preamp) return
    const now = this.context.currentTime
    const on = gains !== null && !isFlat(gains)
    if (on) {
      // Out of the chain, the filters take their values at once; in it, they glide to them.
      const glide = this.equalized
      this.filters.forEach((filter, index) => setParam(filter.gain, gains[index] ?? 0, now, glide))
      setParam(this.preamp.gain, 10 ** (preampDb(gains) / 20), now, glide)
    }
    if (on === this.equalized) return
    this.equalized = on
    // A linear ramp ends on its value exactly: dry at 1 and wet at 0 are the entry's samples untouched.
    fade(this.wet.gain, on ? 1 : 0, now)
    fade(this.dry.gain, on ? 0 : 1, now)
  }

  /** Plays through the output device `sinkId` ('' is the system's default). Rejects when it is gone or not allowed. */
  async setSink(sinkId: string): Promise<void> {
    if (!this.context.setSinkId) throw new Error('This browser cannot choose an output device')
    await this.context.setSinkId(sinkId)
  }

  dispose(): void {
    this.disposed = true
    for (const node of [this.input, this.bus, this.dry, this.wet, this.preamp, ...this.filters, this.limiter]) node?.disconnect()
  }
}

function setParam(param: AudioParam, value: number, now: number, glide: boolean): void {
  param.cancelScheduledValues(now)
  if (glide) param.setTargetAtTime(value, now, EQ_RAMP_SECONDS / 3)
  else param.setValueAtTime(value, now)
}

function fade(param: AudioParam, value: number, now: number): void {
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(value, now + EQ_RAMP_SECONDS)
}

/** Where an engine's gain connects, and what it may turn up: an `OutputChain`, or a stage in front of one. */
export type OutputStage = {
  readonly input: AudioNode
  headroom(gain: number): number
}

/**
 * Hands an engine a stage of a graph another owns (`CrossfadeEngine`'s), instead of its own
 * chain; `onLimiterChange` is called when that graph's limiter comes in or fails.
 */
export type AttachOutput = (context: AudioContext, onLimiterChange: () => void) => OutputStage

/**
 * An engine's output settings, kept from before its audio context exists (it is made on the
 * first play) and applied to the chain once it does.
 */
export class EngineOutput {
  chain: OutputChain | null = null
  /** The chain, or a stage of another engine's graph it was given. */
  private stage: OutputStage | null = null
  private equalizer: EqGains | null = null
  private sinkId = ''

  /** Builds the chain into `destination` with the settings so far. */
  attach(context: BaseAudioContext, destination: AudioNode, options: OutputOptions): OutputChain {
    const chain = new OutputChain(context, destination, options)
    this.chain = chain
    this.stage = chain
    chain.setEqualizer(this.equalizer)
    // A device that is gone leaves the default playing; the setting stays for when it is back.
    if (this.sinkId) chain.setSink(this.sinkId).catch(() => {})
    return chain
  }

  /** Plays into `stage`, another graph's, whose owner applies the equalizer and the output device. */
  adopt(stage: OutputStage): void {
    this.stage = stage
  }

  /** `gain` as the chain allows it now: at most 1 until the limiter is in. */
  headroom(gain: number): number {
    return this.stage ? this.stage.headroom(gain) : Math.min(gain, 1)
  }

  setEqualizer(gains: EqGains | null): void {
    this.equalizer = gains
    this.chain?.setEqualizer(gains)
  }

  async setSink(sinkId: string): Promise<void> {
    this.sinkId = sinkId
    await this.chain?.setSink(sinkId)
  }

  dispose(): void {
    this.chain?.dispose()
    this.chain = null
    this.stage = null
  }
}
