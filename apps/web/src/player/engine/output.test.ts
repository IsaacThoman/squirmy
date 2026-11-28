import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_EQUALIZER, EQ_BANDS, EQ_PRESETS, eqGains, parseEqualizer, preampDb } from './equalizer'
import { EngineOutput, OutputChain } from './output'

type Event = [kind: string, value: number, at: number]

/** An `AudioParam` that records its automation and takes each value as soon as it is asked for. */
class FakeParam {
  value: number
  readonly events: Event[] = []
  constructor(value: number) { this.value = value }
  setValueAtTime(value: number, at: number) { this.events.push(['set', value, at]); this.value = value }
  setTargetAtTime(value: number, at: number) { this.events.push(['target', value, at]); this.value = value }
  linearRampToValueAtTime(value: number, at: number) { this.events.push(['ramp', value, at]); this.value = value }
  cancelScheduledValues() {}
}

class FakeNode {
  readonly outputs = new Set<FakeNode>()
  readonly name: string
  constructor(name: string) { this.name = name }
  connect(next: FakeNode) { this.outputs.add(next); return next }
  disconnect() { this.outputs.clear() }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1)
}

class FakeFilter extends FakeNode {
  type = 'lowpass'
  readonly frequency = new FakeParam(350)
  readonly Q = new FakeParam(1)
  readonly gain = new FakeParam(0)
}

class FakeContext {
  currentTime = 5
  readonly destination = new FakeNode('destination')
  readonly gains: FakeGain[] = []
  readonly filters: FakeFilter[] = []
  setSinkId = vi.fn(async (_id: string) => {})
  createGain() {
    const node = new FakeGain(`gain ${this.gains.length}`)
    this.gains.push(node)
    return node
  }
  createBiquadFilter() {
    const node = new FakeFilter(`filter ${this.filters.length}`)
    this.filters.push(node)
    return node
  }
}

const limiterNode = () => new FakeNode('limiter')

function chainOn(context: FakeContext, createLimiter: (() => Promise<FakeNode>) | null = async () => limiterNode(), onLimiterChange = () => {}) {
  return new OutputChain(context as unknown as BaseAudioContext, context.destination as unknown as AudioNode, {
    createLimiter: createLimiter as unknown as (context: BaseAudioContext) => Promise<AudioNode>,
    onLimiterChange,
  })
}

/** Every node `from` reaches. */
function reach(from: FakeNode, seen = new Set<FakeNode>()): Set<FakeNode> {
  for (const next of from.outputs) {
    if (seen.has(next)) continue
    seen.add(next)
    reach(next, seen)
  }
  return seen
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('OutputChain', () => {
  it('runs ten peaking filters an octave apart, out of what plays while the equalizer is flat', () => {
    const context = new FakeContext()
    const chain = chainOn(context)
    expect(context.filters.map(filter => [filter.type, filter.frequency.value])).toEqual(EQ_BANDS.map(frequency => ['peaking', frequency]))
    const [, , dry, wet] = context.gains
    expect([dry!.gain.value, wet!.gain.value]).toEqual([1, 0])
    chain.setEqualizer(null)
    expect([dry!.gain.value, wet!.gain.value]).toEqual([1, 0])
    expect(context.filters.every(filter => filter.gain.events.length === 0)).toBe(true)
  })

  it('fades the filters in with a preamp of minus the largest boost, and glides between settings', () => {
    const context = new FakeContext()
    const chain = chainOn(context)
    const [, , dry, wet, preamp] = context.gains
    const bass = eqGains({ preset: 'bass', custom: [] })
    chain.setEqualizer(bass)
    // Out of the chain until now, the filters take their gains at once; the paths cross over 10 ms.
    expect(context.filters.map(filter => filter.gain.events)).toEqual(bass.map(gain => [['set', gain, 5]]))
    expect(preamp!.gain.value).toBeCloseTo(10 ** (-6 / 20), 6)
    expect(wet!.gain.events).toEqual([['set', 0, 5], ['ramp', 1, 5.01]])
    expect(dry!.gain.events).toEqual([['set', 1, 5], ['ramp', 0, 5.01]])
    context.currentTime = 6
    chain.setEqualizer(eqGains({ preset: 'treble', custom: [] }))
    expect(context.filters.at(-1)!.gain.events.at(-1)).toEqual(['target', 6, 6])
    expect(wet!.gain.events).toHaveLength(2)
    // Flat again: the filters fade out, and the samples pass as they are.
    chain.setEqualizer(EQ_PRESETS[0]!.gains)
    expect(wet!.gain.events.at(-1)).toEqual(['ramp', 0, 6.01])
    expect(dry!.gain.events.at(-1)).toEqual(['ramp', 1, 6.01])
  })

  it('holds gains to 1 until the limiter is in the chain, then lets them through', async () => {
    const context = new FakeContext()
    const changed = vi.fn()
    const limiter = limiterNode()
    const chain = chainOn(context, async () => limiter, changed)
    const [input, bus] = context.gains
    expect(chain.limiting).toBe(false)
    expect(chain.headroom(2)).toBe(1)
    expect(chain.headroom(0.5)).toBe(0.5)
    // Meanwhile the output plays without it.
    expect([...bus!.outputs]).toEqual([context.destination])
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(chain.limiting).toBe(true)
    expect(chain.headroom(2)).toBe(2)
    expect([...bus!.outputs]).toEqual([limiter])
    expect([...limiter.outputs]).toEqual([context.destination])
    expect(reach(input!).has(context.destination as FakeNode)).toBe(true)
  })

  it('stays at unity gain when the limiter cannot load, or cannot run here', async () => {
    const context = new FakeContext()
    const changed = vi.fn()
    const failed = chainOn(context, () => Promise.reject(new Error('blocked')), changed)
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(failed.headroom(2)).toBe(1)
    const none = chainOn(new FakeContext(), null)
    expect(none.limiting).toBe(false)
    expect(none.headroom(3)).toBe(1)
  })

  it('plays through the output device asked for', async () => {
    const context = new FakeContext()
    const chain = chainOn(context)
    await chain.setSink('speakers')
    expect(context.setSinkId).toHaveBeenCalledWith('speakers')
    const without = new FakeContext() as Partial<FakeContext>
    delete without.setSinkId
    await expect(chainOn(without as FakeContext).setSink('speakers')).rejects.toThrow(/cannot choose/)
  })
})

describe('EngineOutput', () => {
  it('applies what was set before the audio context existed once it does', async () => {
    const output = new EngineOutput()
    output.setEqualizer(eqGains({ preset: 'vocal', custom: [] }))
    await output.setSink('headphones')
    expect(output.headroom(2)).toBe(1)
    const context = new FakeContext()
    context.setSinkId.mockRejectedValueOnce(new Error('gone'))
    output.attach(context as unknown as BaseAudioContext, context.destination as unknown as AudioNode, { createLimiter: async () => limiterNode() as unknown as AudioNode })
    expect(context.filters[6]!.gain.value).toBe(3.5)
    expect(context.setSinkId).toHaveBeenCalledWith('headphones')
    await flush()
    expect(output.headroom(2)).toBe(2)
  })
})

describe('equalizer', () => {
  it('has the iOS app\'s presets, and the user\'s own bands', () => {
    expect(EQ_PRESETS.map(preset => preset.label)).toEqual(['Flat', 'Bass boost', 'Treble boost', 'Vocal', 'Loudness'])
    expect(EQ_PRESETS.every(preset => preset.gains.length === EQ_BANDS.length)).toBe(true)
    const custom = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(eqGains({ preset: 'custom', custom })).toBe(custom)
    expect(eqGains({ preset: 'flat', custom })).toEqual(Array(10).fill(0))
    expect(preampDb([-3, 2, 5])).toBe(-5)
    expect(preampDb([-3, -2])).toBe(0)
  })

  it('reads a stored setting safely', () => {
    expect(parseEqualizer(null)).toBe(DEFAULT_EQUALIZER)
    expect(parseEqualizer({ preset: 'bass', custom: [1, 2] })).toEqual({ preset: 'bass', custom: Array(10).fill(0) })
    expect(parseEqualizer({ preset: 'loud', custom: [20, -20, 0, 0, 0, 0, 0, 0, 0, 1] })).toEqual({ preset: 'flat', custom: [12, -12, 0, 0, 0, 0, 0, 0, 0, 1] })
    expect(parseEqualizer({ preset: 'custom', custom: [0, 0, 0, 0, Number.NaN, 0, 0, 0, 0, 0] })).toEqual({ preset: 'custom', custom: Array(10).fill(0) })
  })
})
