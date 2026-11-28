import type { EngineEvent, EngineMedia } from '@squirmy/client-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mseTypesFor } from '@/lib/codecs'
import { playsGaplessThroughMse } from './choose'
import { MseEngine } from './mse-engine'

/**
 * The fake streams: 8 bytes of init segment (`....ftyp`), then one byte per frame at 1000
 * frames a second, so a byte is a millisecond on the timeline.
 */
const RATE = 1000
const INIT = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70])

function stream(frames: number): Uint8Array[] {
  return [INIT, new Uint8Array(frames).fill(1)]
}

class FakeRanges {
  readonly ranges: [number, number][]
  constructor(ranges: [number, number][]) { this.ranges = ranges }
  get length() { return this.ranges.length }
  start(index: number) { return this.ranges[index]![0] }
  end(index: number) { return this.ranges[index]![1] }
}

type Append = { bytes: number; offset: number; from: number; to: number; type: string }

class FakeSourceBuffer extends EventTarget {
  mode: AppendMode = 'segments'
  timestampOffset = 0
  appendWindowStart = 0
  appendWindowEnd = Infinity
  updating = false
  readonly appends: Append[] = []
  readonly removed: [number, number][] = []
  private ranges: [number, number][] = []
  /** Bytes of the current stream seen so far. */
  private cursor = 0
  private readonly source: FakeMediaSource
  type: string

  constructor(source: FakeMediaSource, type: string) {
    super()
    this.source = source
    this.type = type
  }

  get buffered() { return new FakeRanges(this.ranges.map(([from, to]) => [from, to])) }

  changeType(type: string) { this.type = type }

  abort() {
    this.cursor = 0
    this.appendWindowStart = 0
    this.appendWindowEnd = Infinity
  }

  appendBuffer(data: Uint8Array) {
    if (this.updating) throw new Error('InvalidStateError')
    this.appends.push({ bytes: data.byteLength, offset: this.timestampOffset, from: this.appendWindowStart, to: this.appendWindowEnd, type: this.type })
    if (data.byteLength >= 8 && String.fromCharCode(...data.subarray(4, 8)) === 'ftyp') this.cursor = 0
    const before = Math.max(0, this.cursor - 8)
    this.cursor += data.byteLength
    const after = Math.max(0, this.cursor - 8)
    if (this.cursor >= 8) this.source.initialized()
    this.add(this.timestampOffset + before / RATE, this.timestampOffset + after / RATE)
    this.finish()
  }

  remove(from: number, to: number) {
    this.removed.push([from, to])
    this.ranges = this.ranges.flatMap(([start, end]): [number, number][] => {
      if (end <= from || start >= to) return [[start, end]]
      return [...(start < from ? [[start, from] as [number, number]] : []), ...(end > to ? [[to, end] as [number, number]] : [])]
    })
    this.finish()
  }

  private add(start: number, end: number) {
    const from = Math.max(start, this.appendWindowStart)
    const to = Math.min(end, this.appendWindowEnd)
    if (to <= from) return
    const merged: [number, number][] = []
    for (const range of [...this.ranges, [from, to] as [number, number]].sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1)
      if (last && range[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], range[1])
      else merged.push([...range])
    }
    this.ranges = merged
  }

  private finish() {
    this.updating = true
    setTimeout(() => {
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
      this.source.audio?.update()
    }, 0)
  }
}

class FakeMediaSource extends EventTarget {
  readyState: ReadyState = 'closed'
  duration = Number.NaN
  readonly buffers: FakeSourceBuffer[] = []
  audio: FakeAudio | null = null

  addSourceBuffer(type: string) {
    const buffer = new FakeSourceBuffer(this, type)
    this.buffers.push(buffer)
    return buffer
  }

  attach(audio: FakeAudio) {
    this.audio = audio
    this.readyState = 'open'
    queueMicrotask(() => this.dispatchEvent(new Event('sourceopen')))
  }

  initialized() {
    if (this.audio && this.audio.readyState === 0) this.audio.metadata = true
  }
}

/** An `<audio>` element on a fake `MediaSource`: data arrives through the buffer, time moves by hand. */
class FakeAudio extends EventTarget {
  preload = ''
  readyState = 0
  paused = true
  seeking = false
  playbackRate = 1
  error: { code: number } | null = null
  metadata = false
  source: FakeMediaSource | null = null
  private time = 0
  private url: string | null = null
  private readonly sources: Map<string, FakeMediaSource>

  constructor(sources: Map<string, FakeMediaSource>) {
    super()
    this.sources = sources
  }

  get src() { return this.url ?? '' }
  set src(value: string) {
    this.url = value
    this.readyState = 0
    this.time = 0
    this.metadata = false
    this.source = this.sources.get(value) ?? null
    this.source?.attach(this)
  }

  get currentTime() { return this.time }
  set currentTime(value: number) {
    this.time = value
    this.seeking = true
    queueMicrotask(() => this.update())
  }

  /** Moves time along as playback would, without the events. */
  set position(value: number) { this.time = value }

  removeAttribute() {
    this.url = null
    this.source = null
  }

  load() {}

  play(): Promise<void> {
    this.paused = false
    queueMicrotask(() => this.fire('playing'))
    return Promise.resolve()
  }

  pause() {
    if (this.paused) return
    this.paused = true
    this.fire('pause')
  }

  /** What a browser does as data arrives: metadata, then a seek that lands once its position is buffered. */
  update() {
    if (this.metadata && this.readyState === 0) {
      this.readyState = 1
      this.fire('loadedmetadata')
    }
    if (this.readyState === 0) return
    const ranges = this.source?.buffers[0]?.buffered
    const buffered = ranges && Array.from({ length: ranges.length }, (_, index) => [ranges.start(index), ranges.end(index)])
      .some(([from, to]) => this.time >= from! - 1e-6 && this.time < to!)
    if (this.seeking && buffered) {
      this.seeking = false
      this.readyState = 4
      this.fire('seeked')
      this.fire('canplay')
    }
  }

  fire(type: string) { this.dispatchEvent(new Event(type)) }
}

class FakeContext {
  state: 'running' | 'suspended' = 'running'
  currentTime = 10
  destination = {}
  readonly ramps: { target: number; at: number }[] = []
  readonly gain = {
    value: 1,
    setValueAtTime: (value: number) => { this.gain.value = value },
    setTargetAtTime: (target: number, at: number) => {
      this.ramps.push({ target, at })
      this.gain.value = target
    },
    cancelScheduledValues: () => {},
  }
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createGain() { return { gain: this.gain, connect: (next: unknown) => next } }
  createMediaElementSource() { return { connect: (next: unknown) => next } }
}

type Served = { status?: number; frames?: number; chunks?: Uint8Array[]; startFrame?: number; hold?: boolean }

let sources: Map<string, FakeMediaSource>
let audio: FakeAudio
let context: FakeContext
let served: Map<string, Served>
let requests: string[]
let held: (() => void)[]
let events: EngineEvent[]
let engine: MseEngine

const flush = async (rounds = 20) => {
  for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setTimeout(resolve, 0))
}
const buffer = () => audio.source!.buffers[0]!
const media = (frames: number, priming = 0, profile: NonNullable<EngineMedia['profile']> = 'flac_mp4'): EngineMedia => ({
  transcoded: true, profile, mime: 'audio/mp4', codec: profile.startsWith('aac') ? 'aac' : 'flac', sampleRate: RATE, durationMs: frames,
  gapless: { sampleRate: RATE, primingFrames: priming, frames },
})

function response(path: string): Response {
  const entry = served.get(path)
  if (!entry || entry.status) return new Response('missing', { status: entry?.status ?? 404 })
  const chunks = entry.chunks ?? stream(entry.frames ?? 1000)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      }
      if (entry.hold) held.push(send)
      else send()
    },
  })
  const headers = entry.startFrame === undefined ? undefined : { 'x-squirmy-start-frame': String(entry.startFrame) }
  return new Response(body, { status: 200, headers })
}

let urls = 0

/** An engine on the fakes, with `options` on top. */
function createEngine(options: ConstructorParameters<typeof MseEngine>[0] = {}): MseEngine {
  const created = new MseEngine({
    createAudio: () => audio as unknown as HTMLAudioElement,
    createContext: () => context as unknown as AudioContext,
    createMediaSource: () => new FakeMediaSource() as unknown as MediaSource,
    createObjectUrl: source => {
      const url = `mse:${(urls += 1)}`
      sources.set(url, source as unknown as FakeMediaSource)
      return url
    },
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      return response(url.split('?')[0]!)
    }) as typeof fetch,
    types: new Map([['flac', 'audio/mp4; codecs="flac"'], ['aac', 'audio/mp4; codecs="mp4a.40.2"'], ['mp3', 'audio/mpeg']]),
    ...options,
  })
  created.subscribe(event => events.push(event))
  return created
}

beforeEach(() => {
  sources = new Map()
  audio = new FakeAudio(sources)
  context = new FakeContext()
  served = new Map()
  requests = []
  held = []
  events = []
  engine = createEngine()
})

afterEach(() => {
  engine.dispose()
  vi.useRealTimers()
})

describe('MseEngine', () => {
  it('asks the server for fragmented MP4 in the codecs Media Source Extensions takes', () => {
    expect(engine.playbackQuery()).toEqual({ codecs: 'flac,aac,mp3', containers: 'fmp4', engine: 'mse' })
    expect(engine.canBoost).toBe(true)
  })

  it('places each entry by its exact length and cuts the priming before it', async () => {
    served.set('/a', { frames: 1100 })
    served.set('/b', { frames: 2100 })
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 1, media: media(1000, 100, 'aac_mp4_256') })
    engine.preload({ entryId: 'e2', url: '/b', gain: 1, media: media(2000, 100, 'aac_mp4_256') })
    await flush()
    expect(engine.getStatus()).toEqual({ entryId: 'e1', state: 'paused', positionMs: 0 })
    const placed = buffer().appends.map(({ offset, from, to }) => ({ offset: Number(offset.toFixed(6)), from, to }))
    expect(placed[0]).toEqual({ offset: -0.1, from: 0, to: 1 })
    expect(placed.at(-1)).toEqual({ offset: 0.9, from: 1, to: 3 })
    expect(buffer().buffered.ranges).toEqual([[0, 3]])
    expect(requests).toEqual(['/a?intent=play', '/b?intent=next'])
  })

  it('moves to the preloaded entry at its boundary, then reports the end of the first', async () => {
    served.set('/a', { frames: 1000 })
    served.set('/b', { frames: 2000 })
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: true, gain: 1, media: media(1000) })
    engine.preload({ entryId: 'e2', url: '/b', gain: 1, media: media(2000) })
    await flush()
    expect(engine.getStatus().state).toBe('playing')
    events.length = 0
    audio.position = 0.6
    audio.fire('timeupdate')
    expect(events).toEqual([])
    expect(engine.getStatus().positionMs).toBe(600)
    audio.position = 1.25
    audio.fire('timeupdate')
    expect(events).toEqual([
      { type: 'ended', entryId: 'e1' },
      { type: 'status', status: { entryId: 'e2', state: 'playing', positionMs: 250 } },
    ])
  })

  it('ends the last entry where its data does, and lets the element run dry before pausing it', async () => {
    served.set('/a', { frames: 1000 })
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: true, gain: 1, media: media(1000) })
    await flush()
    audio.position = 1
    audio.fire('timeupdate')
    expect(events.slice(-2)).toEqual([
      { type: 'ended', entryId: 'e1' },
      { type: 'status', status: { entryId: 'e1', state: 'ended', positionMs: 1000 } },
    ])
    expect(audio.paused).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(audio.paused).toBe(true)
  })

  it('seeks inside what is appended by moving the playhead, and outside by starting the stream there', async () => {
    served.set('/long', { frames: 60_000 })
    engine.dispose()
    engine = createEngine({ leadSeconds: 1 })
    const long = engine
    long.load({ entryId: 'e1', url: '/long', startMs: 0, autoplay: false, gain: 1, media: media(60_000) })
    await flush()
    expect(long.getStatus().state).toBe('paused')
    long.seek(500)
    await flush()
    expect(requests).toEqual(['/long?intent=play'])
    expect(audio.currentTime).toBe(0.5)

    served.set('/long', { frames: 30_000, startFrame: 30_000 })
    long.seek(30_000)
    expect(long.getStatus().positionMs).toBe(30_000)
    await flush()
    expect(requests.at(-1)).toBe('/long?intent=play&start=30000')
    // The playhead moves once what the old stream had appended there is gone.
    const removal = buffer().removed.at(-1)!
    expect(removal[0]).toBeLessThanOrEqual(29.75)
    const restarted = buffer().appends.at(-1)!
    expect(restarted.offset).toBe(30)
    expect(restarted.from).toBe(30)
    expect(audio.currentTime).toBe(30)
  })

  it('reuses the preloaded entry when it is loaded, without fetching it again', async () => {
    served.set('/a', { frames: 1000 })
    served.set('/b', { frames: 2000 })
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 1, media: media(1000) })
    engine.preload({ entryId: 'e2', url: '/b', gain: 1, media: media(2000) })
    await flush()
    engine.load({ entryId: 'e2', url: '/b', startMs: 0, autoplay: false, gain: 1, media: media(2000) })
    await flush()
    expect(requests).toEqual(['/a?intent=play', '/b?intent=next'])
    expect(audio.currentTime).toBe(1)
    expect(engine.getStatus()).toEqual({ entryId: 'e2', state: 'paused', positionMs: 0 })
    expect(events.some(event => event.type === 'ended')).toBe(false)
  })

  it('drops a preload that fails to fetch and fails a loaded entry that does', async () => {
    served.set('/a', { frames: 1000 })
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 1, media: media(1000) })
    engine.preload({ entryId: 'e2', url: '/gone', gain: 1, media: media(2000) })
    await flush()
    expect(engine.inspect().next).toBeNull()
    expect(events.some(event => event.type === 'error')).toBe(false)

    engine.load({ entryId: 'e3', url: '/gone', startMs: 0, autoplay: true, gain: 1, media: media(1000) })
    await flush()
    expect(events.at(-2)).toEqual({ type: 'error', entryId: 'e3', message: expect.stringContaining('could not be loaded') })
    expect(engine.getStatus().state).toBe('error')
  })

  it('keeps bytes that are not the stream\'s type out of the buffer', async () => {
    served.set('/noise', { chunks: [new Uint8Array(64).fill(7)] })
    engine.load({ entryId: 'e1', url: '/noise', startMs: 0, autoplay: true, gain: 1, media: media(1000) })
    await flush()
    expect(events.find(event => event.type === 'error')).toEqual({ type: 'error', entryId: 'e1', message: 'The audio could not be decoded' })
    expect(buffer().appends).toEqual([])
  })

  it('fails a stream the browser cannot append, or one without its descriptor\'s facts, without fetching it', () => {
    engine.load({ entryId: 'e0', url: '/x', startMs: 0, autoplay: true, gain: 1, media: { transcoded: false } })
    expect(events.at(-2)).toEqual({ type: 'error', entryId: 'e0', message: 'The browser cannot play this stream' })
    engine.load({ entryId: 'e1', url: '/x', startMs: 0, autoplay: true, gain: 1, media: { ...media(1000), mime: 'audio/ogg', codec: 'opus' } })
    expect(events.at(-2)).toEqual({ type: 'error', entryId: 'e1', message: 'The browser cannot play this stream' })
    expect(requests).toEqual([])
  })

  it('takes the MP3 decoder delay Chromium drops itself off an MPEG stream\'s priming', async () => {
    served.set('/a', { chunks: [new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]), new Uint8Array(2105)] })
    const mp3: EngineMedia = { transcoded: false, profile: 'original', mime: 'audio/mpeg', codec: 'mp3', sampleRate: RATE, durationMs: 1000, gapless: { sampleRate: RATE, primingFrames: 1105, frames: 1000 } }
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 1, media: mp3 })
    await flush()
    expect(buffer().type).toBe('audio/mpeg')
    expect(Number(buffer().appends[0]!.offset.toFixed(6))).toBe(-0.576)
  })

  it('moves the gain to the next entry\'s on the audio clock at the boundary', async () => {
    served.set('/a', { frames: 3000 })
    served.set('/b', { frames: 2000 })
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: true, gain: 0.5, media: media(3000) })
    engine.preload({ entryId: 'e2', url: '/b', gain: 2, media: media(2000) })
    await flush()
    context.ramps.length = 0
    audio.position = 2.75
    audio.fire('timeupdate')
    expect(context.ramps).toEqual([{ target: 0.5, at: 10 }, { target: 2, at: 10.25 }])
  })

  it('buffers while the stream has not reached the playhead, and plays once it has', async () => {
    served.set('/a', { frames: 1000, hold: true })
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: true, gain: 1, media: media(1000) })
    await flush()
    expect(engine.getStatus().state).toBe('loading')
    held.forEach(send => send())
    await flush()
    expect(engine.getStatus().state).toBe('playing')
    audio.fire('waiting')
    expect(engine.getStatus().state).toBe('buffering')
    audio.fire('playing')
    expect(engine.getStatus().state).toBe('playing')
  })
})

describe('which browsers get MseEngine', () => {
  it('is Chromium by its client hints, or its user agent where there are none', () => {
    expect(playsGaplessThroughMse({ userAgent: 'x', userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }] } })).toBe(true)
    expect(playsGaplessThroughMse({ userAgent: 'x', userAgentData: { brands: [{ brand: 'Not A Brand' }] } })).toBe(false)
    expect(playsGaplessThroughMse({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0' })).toBe(true)
    expect(playsGaplessThroughMse({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0' })).toBe(false)
    expect(playsGaplessThroughMse({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15' })).toBe(false)
    expect(playsGaplessThroughMse({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1' })).toBe(false)
  })

  it('probes each codec\'s SourceBuffer type, WebKit\'s spelling of FLAC included', () => {
    const accepts = (types: string[]) => (type: string) => types.includes(type)
    expect([...mseTypesFor(accepts(['audio/mp4; codecs="fLaC"', 'audio/mp4; codecs="mp4a.40.2"', 'audio/mpeg']))]).toEqual([
      ['flac', 'audio/mp4; codecs="fLaC"'], ['aac', 'audio/mp4; codecs="mp4a.40.2"'], ['mp3', 'audio/mpeg'],
    ])
    expect([...mseTypesFor(accepts(['audio/mp4; codecs="mp3"'])).keys()]).toEqual(['mp3_mp4'])
  })
})
