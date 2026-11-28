import { FakeEngine, type EngineEvent } from '@squirmy/client-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CrossfadeEngine, type InnerEngine, type InnerOptions } from './crossfade-engine'

/** client-core's fake engine, with what the crossfade engine reads of the page's. */
class Inner extends FakeEngine implements InnerEngine {
  readonly limiter = true
  readonly canBoost = true
  stage: { input: unknown } | null = null
  readonly shared: InnerOptions
  constructor(shared: InnerOptions) {
    super()
    this.shared = shared
  }
  entryDurationMs() { return this.loaded ? this.durationMs : null }
  playbackQuery() { return { codecs: 'flac' } }
  isBlocked() { return false }
  unlock() {}
  warm() {
    this.calls.push(['warm'])
    const context = this.shared.createContext()
    this.stage ??= this.shared.attachOutput(context, () => {})
  }
  setEqualizer() {}
  async setOutputDevice() {}
  dispose() {}
}

type Automation = [kind: string, ...args: unknown[]]

class FakeContext {
  currentTime = 100
  close = async () => {}
  destination = { connect: () => {} }
  readonly fades: { gain: { value: number; events: Automation[] } & Record<string, (...args: unknown[]) => void> }[] = []
  createGain() {
    const events: Automation[] = []
    const gain = {
      value: 1,
      events,
      setValueAtTime: (value: number, at: number) => { events.push(['set', value, at]); gain.value = value },
      setTargetAtTime: (...args: unknown[]) => events.push(['target', ...args]),
      linearRampToValueAtTime: (value: number, at: number) => { events.push(['ramp', value, at]); gain.value = value },
      setValueCurveAtTime: (values: Float32Array, at: number, seconds: number) => events.push(['curve', [...values], at, seconds]),
      cancelScheduledValues: () => {},
      cancelAndHoldAtTime: (at: number) => events.push(['hold', at]),
    }
    const node = { gain, connect: (next: unknown) => next, disconnect: () => {} }
    return node
  }
}

let context: FakeContext
let inners: Inner[]
let engine: CrossfadeEngine
let events: EngineEvent[]

const DURATION = 180_000
const request = (entryId: string, extra: object = {}) => ({ entryId, url: `/${entryId}`, gain: 0.5, media: { transcoded: false, durationMs: DURATION }, ...extra })

beforeEach(() => {
  vi.useFakeTimers()
  context = new FakeContext()
  inners = []
  events = []
  engine = new CrossfadeEngine({
    createEngine: shared => {
      const inner = new Inner(shared)
      inners.push(inner)
      return inner
    },
    createContext: () => context as unknown as AudioContext,
    limiter: true,
    createLimiter: async () => ({ connect: (next: unknown) => next, disconnect: () => {} }) as unknown as AudioNode,
  })
  engine.subscribe(event => events.push(event))
  for (const inner of inners) inner.warm()
})

afterEach(() => {
  engine.dispose()
  vi.useRealTimers()
})

/** Plays `a` from `startMs` with `b` preloaded. */
function playing(startMs: number, preload: object = {}) {
  engine.load({ ...request('a'), startMs, autoplay: true })
  engine.preload(request('b', preload))
}

const [first, second] = [() => inners[0]!, () => inners[1]!]
const fadeOf = (index: number) => {
  const stage = inners[index]!.stage!.input as ReturnType<FakeContext['createGain']>
  return stage.gain.events
}

describe('CrossfadeEngine', () => {
  it('plays the preload gaplessly on the same engine with crossfade off', () => {
    playing(0)
    expect(first().preloaded?.entryId).toBe('b')
    expect(second().loaded).toBeNull()
  })

  it('never crossfades into the next song of the album playing', () => {
    engine.setCrossfade(4)
    playing(0, { continuesAlbum: true })
    expect(first().preloaded?.entryId).toBe('b')
    expect(second().loaded).toBeNull()
  })

  it('loads the next song paused on the other engine, fades it in over the setting with equal power, and ends the first as it starts', () => {
    engine.setCrossfade(4)
    playing(DURATION - 10_000)
    expect(first().preloaded).toBeNull()
    expect(second().loaded).toMatchObject({ entryId: 'b', gain: 0.5 })
    expect(second().getStatus().state).toBe('paused')
    // Its output opened first, so its fade gain is there to start from silence.
    expect(second().calls.findIndex(([method]) => method === 'warm')).toBeLessThan(second().calls.findIndex(([method]) => method === 'load'))
    vi.advanceTimersByTime(5_000)
    expect(second().getStatus().state).toBe('paused')
    // The fade's length and the start's lead before the end: the other engine plays.
    vi.advanceTimersByTime(900)
    expect(second().getStatus().state).toBe('playing')
    const [ended, status] = events.slice(-2)
    expect(ended).toEqual({ type: 'ended', entryId: 'a' })
    expect(status).toMatchObject({ type: 'status', status: { entryId: 'b', state: 'playing' } })
    expect(engine.getStatus().entryId).toBe('b')
    const [out] = fadeOf(0).filter(([kind]) => kind === 'curve')
    const [into] = fadeOf(1).filter(([kind]) => kind === 'curve')
    expect(out![2]).toBe(100)
    expect(out![3]).toBeCloseTo(4, 1)
    const outCurve = out![1] as number[], inCurve = into![1] as number[]
    expect([outCurve[0], outCurve.at(-1), inCurve[0], inCurve.at(-1)]).toEqual([1, 0, 0, 1])
    // Equal power all the way through.
    for (let index = 0; index < outCurve.length; index += 1) expect(outCurve[index]! ** 2 + inCurve[index]! ** 2).toBeCloseTo(1, 5)
    // The first engine still plays until its fade has run out, then stops.
    expect(first().getStatus().state).toBe('playing')
    vi.advanceTimersByTime(4_200)
    expect(first().getStatus().state).toBe('idle')
    expect(events.filter(event => event.type === 'ended')).toHaveLength(1)
  })

  it('preloads what follows once the faded-out engine is free', () => {
    engine.setCrossfade(4)
    playing(DURATION - 5_000)
    vi.advanceTimersByTime(1_000)
    expect(engine.getStatus().entryId).toBe('b')
    engine.preload(request('c'))
    expect(first().loaded?.entryId).toBe('a')
    vi.advanceTimersByTime(4_200)
    expect(first().loaded).toMatchObject({ entryId: 'c' })
    expect(first().getStatus().state).toBe('paused')
  })

  it('ends a fade at once when the listener pauses', () => {
    engine.setCrossfade(4)
    playing(DURATION - 5_000)
    vi.advanceTimersByTime(1_000)
    engine.pause()
    expect(fadeOf(0).slice(-2)).toEqual([['hold', 100], ['ramp', 0, 100.01]])
    expect(fadeOf(1).slice(-2)).toEqual([['hold', 100], ['ramp', 1, 100.01]])
    expect(second().getStatus().state).toBe('paused')
    vi.advanceTimersByTime(50)
    expect(first().getStatus().state).toBe('idle')
  })

  it('starts the preloaded song where it is loaded on a skip, without fetching it again', () => {
    engine.setCrossfade(4)
    playing(0)
    const loads = second().calls.filter(([method]) => method === 'load').length
    engine.load({ ...request('b'), startMs: 0, autoplay: true })
    expect(second().calls.filter(([method]) => method === 'load')).toHaveLength(loads)
    expect(engine.getStatus()).toMatchObject({ entryId: 'b', state: 'playing' })
    expect(first().getStatus().state).toBe('idle')
    expect(events.some(event => event.type === 'ended')).toBe(false)
  })

  it('falls back to a gapless change when the next song fails on the other engine', () => {
    engine.setCrossfade(4)
    playing(0)
    second().fail('gone')
    expect(events.some(event => event.type === 'error')).toBe(false)
    expect(first().preloaded?.entryId).toBe('b')
    expect(second().loaded).toBeNull()
  })

  describe('with the songs\' timing', () => {
    const timing = (overrides: object) => ({ bpm: null, beatOffsetMs: null, audibleStartMs: null, audibleEndMs: null, introEndMs: null, outroStartMs: null, ...overrides })
    /** Plays `a` (falling silent 3 s before its end, with a 5 s outro) from `startMs`, and preloads `b` (silent for 1.2 s, then a 2 s intro). */
    function playingTimed(startMs: number, preload: object = {}) {
      engine.load({ ...request('a', { media: { transcoded: false, durationMs: DURATION, timing: timing({ audibleEndMs: DURATION - 3000, outroStartMs: DURATION - 8000 }) } }), startMs, autoplay: true })
      engine.preload(request('b', { media: { transcoded: false, durationMs: DURATION, timing: timing({ audibleStartMs: 1200, introEndMs: 3200 }) } , ...preload }))
    }

    it('skips the silence: the fade ends where the first song falls silent, and the next starts where its sound does', () => {
      engine.setCrossfade(4)
      playingTimed(DURATION - 10_000)
      expect(second().getStatus()).toMatchObject({ entryId: 'b', state: 'paused', positionMs: 1200 })
      // Its sound ends 7 s from here: the fade starts 4 s and the start's lead before that, 2.85 s in.
      vi.advanceTimersByTime(2_700)
      expect(second().getStatus().state).toBe('paused')
      vi.advanceTimersByTime(200)
      expect(second().getStatus()).toMatchObject({ state: 'playing', positionMs: 1200 })
      expect(events.at(-2)).toEqual({ type: 'ended', entryId: 'a' })
      const [out] = fadeOf(0).filter(([kind]) => kind === 'curve')
      expect(out![3]).toBeCloseTo(4, 1)
      // The first song stops once it is silent, 3 s before its file ends.
      vi.advanceTimersByTime(4_200)
      expect(first().getStatus().state).toBe('idle')
    })

    it('with Smart transitions, mixes over the outro rather than the setting', () => {
      engine.setCrossfade(12)
      engine.setSmartTransitions(true)
      playingTimed(DURATION - 20_000)
      // The 5 s outro (longer than the 2 s intro) ends 17 s from here: the fade starts 11.85 s in.
      vi.advanceTimersByTime(11_700)
      expect(second().getStatus().state).toBe('paused')
      vi.advanceTimersByTime(200)
      expect(second().getStatus().state).toBe('playing')
      const [out] = fadeOf(0).filter(([kind]) => kind === 'curve')
      expect(out![3]).toBeCloseTo(5, 1)
    })

    it('plays gaplessly into the next song of the album, silence and all', () => {
      engine.setCrossfade(4)
      engine.setSmartTransitions(true)
      playingTimed(0, { continuesAlbum: true })
      expect(first().preloaded?.entryId).toBe('b')
      expect(second().loaded).toBeNull()
    })

    it('starts a skipped-to song from its start, not past its silence', () => {
      engine.setCrossfade(4)
      playingTimed(0)
      engine.load({ ...request('b'), startMs: 0, autoplay: true })
      expect(engine.getStatus()).toMatchObject({ entryId: 'b', state: 'playing', positionMs: 0 })
    })
  })

  it('moves a waiting preload back to the playing engine when crossfade is turned off', () => {
    engine.setCrossfade(4)
    playing(0)
    engine.setCrossfade(0)
    expect(first().preloaded?.entryId).toBe('b')
    expect(second().getStatus().state).toBe('idle')
  })
})
