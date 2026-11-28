import type { EngineEvent, EngineMedia } from '@squirmy/client-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PcmEngine } from './engine.js'
import type { PcmFormat } from './pcm.js'
import { FakeDecoders, FakeSink, framesOf } from './testing.js'

const cd: PcmFormat = { sampleRate: 44_100, channels: 2, encoding: 's32le' }

/** Checks `heard` is exactly `runs` back to back, without building millions of pairs to compare. */
function expectHeard(heard: [number, number][], runs: [id: number, from: number, to: number][]) {
  let offset = 0
  for (const [id, from, to] of runs) {
    const part = heard.slice(offset, offset + (to - from))
    expect(part.length, `frames of track ${id}`).toBe(to - from)
    const wrong = part.findIndex(([got, frame], index) => got !== id || frame !== from + index)
    expect(wrong, `track ${id} from frame ${from}: frame ${offset + wrong} is ${JSON.stringify(part[wrong])}`).toBe(-1)
    offset += to - from
  }
  expect(heard.length).toBe(offset)
}

describe('PcmEngine', () => {
  let decoders: FakeDecoders
  let sink: FakeSink
  let engine: PcmEngine
  let events: EngineEvent[]
  const tracks = { a: { id: 1, frames: 133_077 }, b: { id: 2, frames: 88_533 }, c: { id: 3, frames: 50_000 } }
  const formatFor = vi.fn((media: EngineMedia | undefined): PcmFormat => ({ ...cd, sampleRate: media?.sampleRate ?? cd.sampleRate }))

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    decoders = new FakeDecoders(tracks)
    sink = new FakeSink(() => Date.now())
    engine = new PcmEngine({ decoder: decoders.factory, sink, formatFor, fadeInMs: 0 })
    events = []
    engine.subscribe(event => events.push(event))
  })
  afterEach(() => {
    engine.dispose()
    vi.useRealTimers()
  })

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
  const heard = () => framesOf(sink.heard())
  const states = () => events.flatMap(event => (event.type === 'status' ? [`${event.status.entryId}:${event.status.state}`] : event.type === 'ended' ? [`ended ${event.entryId}`] : []))
  const play = async (entryId = 'a', startMs = 0) => {
    engine.load({ entryId, url: entryId, startMs, autoplay: true, gain: 1 })
    await advance(0)
  }

  it('plays two songs back to back with not a sample between or lost', async () => {
    await play('a')
    engine.preload({ entryId: 'b', url: 'b', gain: 1 })
    expect(engine.getStatus()).toMatchObject({ entryId: 'a', state: 'playing' })
    // The boundary falls 3017.6 ms in.
    await advance(3000)
    expect(engine.getStatus().entryId).toBe('a')
    await advance(40)
    expect(engine.getStatus()).toMatchObject({ entryId: 'b', state: 'playing' })
    expect(engine.getStatus().positionMs).toBeLessThan(40)
    await advance(2100)
    expectHeard(heard(), [[1, 0, 133_077], [2, 0, 88_533]])
    expect(states()).toEqual(['a:loading', 'a:playing', 'ended a', 'b:playing', 'ended b', 'b:ended'])
    expect(engine.getStatus().positionMs).toBeCloseTo((88_533 / 44_100) * 1000, 0)
    // One continuous stream: the sink opened once, and the preloaded decoder was the one that played.
    expect(sink.opens).toHaveLength(1)
    expect(decoders.requests.map(request => request.url)).toEqual(['a', 'b'])
  })

  it('pauses on the frame it reached and goes on from it', async () => {
    await play('a')
    await advance(1000)
    engine.pause()
    expect(engine.getStatus()).toMatchObject({ state: 'paused', positionMs: 1000 })
    expect(sink.isOpen).toBe(false)
    await advance(5000)
    expect(engine.getStatus().positionMs).toBe(1000)
    engine.play()
    expect(engine.getStatus()).toMatchObject({ state: 'playing', positionMs: 1000 })
    await advance(1000)
    expect(engine.getStatus().positionMs).toBe(2000)
    expectHeard(heard(), [[1, 0, 88_200]])
    // A resume with its audio at hand never says it is buffering.
    expect(states()).toEqual(['a:loading', 'a:playing', 'a:paused', 'a:playing'])
  })

  it('seeks to the exact frame, playing or paused', async () => {
    await play('a')
    await advance(500)
    engine.seek(2000)
    expect(engine.getStatus()).toMatchObject({ state: 'buffering', positionMs: 2000 })
    await advance(0)
    expect(engine.getStatus()).toMatchObject({ state: 'playing', positionMs: 2000 })
    await advance(500)
    expect(engine.getStatus().positionMs).toBe(2500)
    engine.pause()
    engine.seek(100)
    expect(engine.getStatus()).toMatchObject({ state: 'paused', positionMs: 100 })
    engine.play()
    await advance(100)
    expectHeard(heard(), [[1, 0, 22_050], [1, 88_200, 110_250], [1, 4410, 8820]])
    expect(decoders.requests.map(request => request.startFrame)).toEqual([0, 88_200, 4410])
  })

  it('says it is buffering and stops its clock while the stream is slow', async () => {
    decoders.holds.set('a', 44_100)
    await play('a')
    await advance(900)
    expect(engine.getStatus().state).toBe('playing')
    await advance(600)
    expect(engine.getStatus()).toMatchObject({ state: 'buffering', positionMs: 1000 })
    await advance(3000)
    expect(engine.getStatus().positionMs).toBe(1000)
    decoders.release('a')
    await advance(0)
    expect(engine.getStatus()).toMatchObject({ state: 'playing', positionMs: 1000 })
    await advance(1000)
    expect(engine.getStatus().positionMs).toBe(2000)
    expectHeard(heard(), [[1, 0, 88_200]])
  })

  it('restarts a failed stream where it stopped', async () => {
    decoders.failures.set('a', 30_000)
    await play('a')
    await advance(900)
    // The stream broke 0.68 s in, and the retry waits a second.
    expect(engine.getStatus().state).toBe('buffering')
    expect(engine.getStatus().positionMs).toBeCloseTo((30_000 / 44_100) * 1000, 6)
    await advance(4000)
    expect(engine.getStatus().state).toBe('ended')
    expect(decoders.requests.map(request => request.startFrame)).toEqual([0, 30_000])
    expectHeard(heard(), [[1, 0, 133_077]])
  })

  it('fails the entry when its stream keeps failing', async () => {
    engine.dispose()
    // Every decoder of the song fails at once.
    engine = new PcmEngine({ decoder: request => { decoders.failures.set('a', 0); return decoders.factory(request) }, sink, formatFor, fadeInMs: 0 })
    events = []
    engine.subscribe(event => events.push(event))
    await play('a')
    await advance(10_000)
    expect(engine.getStatus().state).toBe('error')
    expect(events).toContainEqual({ type: 'error', entryId: 'a', message: 'connection reset' })
  })

  it('reopens the sink for a song at another rate, after the last one played out', async () => {
    engine.load({ entryId: 'b', url: 'b', startMs: 0, autoplay: true, gain: 1 })
    await advance(0)
    engine.preload({ entryId: 'c', url: 'c', gain: 1, media: { transcoded: false, sampleRate: 48_000 } })
    await advance(2100)
    expect(sink.opens.map(format => format.sampleRate)).toEqual([44_100, 48_000])
    expect(engine.getStatus().entryId).toBe('c')
    await advance(1100)
    const all = heard()
    expectHeard(all, [[2, 0, 88_533], [3, 0, 50_000]])
  })

  it('drops a preload already in the sink when another replaces it', async () => {
    await play('b')
    engine.preload({ entryId: 'a', url: 'a', gain: 1 })
    // 100 ms from the end: the next song's first 200 ms are already written.
    await advance(1907)
    engine.preload({ entryId: 'c', url: 'c', gain: 1 })
    await advance(1300)
    expectHeard(heard(), [[2, 0, 88_533], [3, 0, 50_000]])
  })

  it('loads the preloaded entry from what it already decoded', async () => {
    await play('a')
    engine.preload({ entryId: 'b', url: 'b', gain: 1 })
    await advance(100)
    engine.load({ entryId: 'b', url: 'b', startMs: 0, autoplay: true, gain: 1 })
    await advance(100)
    expect(decoders.requests.map(request => request.url)).toEqual(['a', 'b'])
    expectHeard(heard(), [[1, 0, 4410], [2, 0, 4410]])
  })

  it('applies the gain, and the preload’s own at its boundary', async () => {
    engine.load({ entryId: 'b', url: 'b', startMs: 0, autoplay: true, gain: 0.5 })
    await advance(0)
    engine.preload({ entryId: 'c', url: 'c', gain: 0.25 })
    await advance(2100)
    const frames = heard()
    expect(frames[1000]).toEqual([1, 500])
    expect(frames[88_533 + 1000]).toEqual([1, 250])
  })

  it('goes on after the sound card comes back', async () => {
    await play('a')
    await advance(1000)
    sink.fail()
    expect(engine.getStatus()).toMatchObject({ state: 'buffering', positionMs: 1000 })
    await advance(1900)
    expect(sink.isOpen).toBe(false)
    await advance(200)
    expect(engine.getStatus().state).toBe('playing')
    expect(sink.isOpen).toBe(true)
    await advance(1000)
    // Nothing the card dropped is lost: the music goes on from the frame it reached.
    const frames = heard()
    expect(frames.length).toBeGreaterThan(88_200)
    expectHeard(frames, [[1, 0, frames.length]])
  })

  it('ends without a preload and stays on the last frame', async () => {
    await play('c')
    await advance(1200)
    expect(engine.getStatus()).toMatchObject({ entryId: 'c', state: 'ended' })
    expect(engine.getStatus().positionMs).toBeCloseTo((50_000 / 44_100) * 1000, 0)
    expect(events.filter(event => event.type === 'ended')).toEqual([{ type: 'ended', entryId: 'c' }])
    engine.seek(0)
    expect(engine.getStatus()).toMatchObject({ state: 'paused', positionMs: 0 })
  })

  it('stops at once and forgets both entries', async () => {
    await play('a')
    engine.preload({ entryId: 'b', url: 'b', gain: 1 })
    await advance(500)
    engine.stop()
    expect(engine.getStatus()).toEqual({ entryId: null, state: 'idle', positionMs: 0 })
    expect(sink.isOpen).toBe(false)
    await advance(5000)
    expectHeard(heard(), [[1, 0, 22_050]])
  })
})
