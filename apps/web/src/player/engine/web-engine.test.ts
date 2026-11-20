import type { EngineEvent } from '@squirmy/client-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_BLOCKED_MESSAGE, clampPosition, mediaErrorMessage, playFailure } from './errors'
import { WebPlayerEngine } from './web-engine'

/** An `<audio>` element whose loading, seeking and playback the test moves along by hand. */
class FakeAudio extends EventTarget {
  preload = ''
  crossOrigin: string | null = null
  readyState = 0
  duration = Number.NaN
  paused = true
  ended = false
  seeking = false
  error: { code: number } | null = null
  /** What the next play() does. */
  playResult: 'play' | 'blocked' | 'pending' = 'play'
  private time = 0
  private source: string | null = null

  get src() { return this.source ?? '' }
  set src(value: string) {
    this.source = value
    this.readyState = 0
    this.duration = Number.NaN
    this.time = 0
    this.ended = false
    this.error = null
  }

  get currentTime() { return this.time }
  set currentTime(value: number) {
    this.time = value
    this.seeking = true
    this.ended = false
  }

  hasAttribute(name: string) { return name === 'src' && this.source !== null }
  removeAttribute() { this.source = null }
  load() {}

  play(): Promise<void> {
    if (this.playResult === 'blocked') return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
    this.paused = false
    if (this.playResult === 'pending') return Promise.resolve()
    queueMicrotask(() => this.fire('playing'))
    return Promise.resolve()
  }

  pause() {
    if (this.paused) return
    this.paused = true
    this.fire('pause')
  }

  metadata(durationSeconds: number) {
    this.duration = durationSeconds
    this.readyState = 1
    this.fire('loadedmetadata')
  }

  canPlay() {
    this.readyState = 4
    this.fire('canplay')
  }

  landSeek() {
    this.seeking = false
    this.fire('seeked')
  }

  advance(seconds: number) { this.time += seconds }

  finish() {
    this.time = this.duration
    this.paused = true
    this.ended = true
    this.fire('pause')
    this.fire('ended')
  }

  fail(code: number) {
    this.error = { code }
    this.fire('error')
  }

  fire(type: string) { this.dispatchEvent(new Event(type)) }
}

class FakeContext {
  state: 'running' | 'suspended' = 'running'
  currentTime = 0
  destination = {}
  readonly gains: { gain: { value: number; setValueAtTime: (value: number) => void } }[] = []
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createGain() {
    const node = { gain: { value: 1, setValueAtTime(value: number) { node.gain.value = value } }, connect: (next: unknown) => next }
    this.gains.push(node)
    return node
  }
  createMediaElementSource() { return { connect: (next: unknown) => next } }
}

let audios: FakeAudio[]
let context: FakeContext
let events: EngineEvent[]
let engine: WebPlayerEngine

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const states = () => events.flatMap(event => event.type === 'status' ? [event.status.state] : [])
/** The element holding `entryId` right now. */
const audioOf = (url: string) => audios.find(audio => audio.src === url)!

function ready(url: string, durationSeconds = 10) {
  const audio = audioOf(url)
  audio.metadata(durationSeconds)
  audio.canPlay()
  return audio
}

beforeEach(() => {
  audios = []
  context = new FakeContext()
  events = []
  engine = new WebPlayerEngine({
    createAudio: () => {
      const audio = new FakeAudio()
      audios.push(audio)
      return audio as unknown as HTMLAudioElement
    },
    createContext: () => context as unknown as AudioContext,
  })
  engine.subscribe(event => events.push(event))
})

afterEach(() => {
  engine.dispose()
  vi.useRealTimers()
})

describe('WebPlayerEngine', () => {
  it('loads paused at the start position, reporting it while the seek is in flight', () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 1500, autoplay: false, gain: 1 })
    expect(states()).toEqual(['loading'])
    const audio = audioOf('/a')
    audio.metadata(10)
    expect(audio.currentTime).toBe(1.5)
    expect(engine.getStatus()).toEqual({ entryId: 'e1', state: 'loading', positionMs: 1500 })
    audio.canPlay()
    expect(states()).toEqual(['loading'])
    audio.landSeek()
    expect(events.at(-1)).toEqual({ type: 'status', status: { entryId: 'e1', state: 'paused', positionMs: 1500 } })
  })

  it('autoplays once it can and treats play as a no-op while loading', async () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: true, gain: 1 })
    engine.play()
    ready('/a')
    await flush()
    expect(states()).toEqual(['loading', 'playing'])
    expect(context.resume).not.toHaveBeenCalled()
  })

  it('pauses, plays and seeks, emitting status once each seek lands', async () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 1 })
    const audio = ready('/a')
    engine.play()
    expect(engine.getStatus().state).toBe('playing')
    engine.seek(4000)
    expect(engine.getStatus().positionMs).toBe(4000)
    const before = events.length
    audio.landSeek()
    expect(events.slice(before)).toEqual([{ type: 'status', status: { entryId: 'e1', state: 'playing', positionMs: 4000 } }])
    engine.seek(60_000)
    expect(audio.currentTime).toBe(10)
    engine.pause()
    await flush()
    expect(states()).toEqual(['loading', 'paused', 'playing', 'playing', 'paused'])
  })

  it('reports buffering when the element waits and playing when it resumes', async () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: true, gain: 1 })
    const audio = ready('/a')
    await flush()
    audio.fire('waiting')
    audio.fire('playing')
    expect(states()).toEqual(['loading', 'playing', 'buffering', 'playing'])
  })

  it('notices a stall the element does not announce', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] })
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 1 })
    const audio = ready('/a')
    engine.play()
    vi.advanceTimersByTime(2000)
    expect(engine.getStatus().state).toBe('buffering')
    audio.advance(0.25)
    vi.advanceTimersByTime(250)
    expect(engine.getStatus().state).toBe('playing')
  })

  it('starts the preload at a natural end before announcing the end', async () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: true, gain: 1 })
    const first = ready('/a')
    engine.preload({ entryId: 'e2', url: '/b', gain: 0.5 })
    const second = ready('/b', 5)
    await flush()
    let seenAtEnd: unknown
    engine.subscribe(event => { if (event.type === 'ended') seenAtEnd = engine.getStatus() })
    const before = events.length
    first.finish()
    expect(seenAtEnd).toEqual({ entryId: 'e2', state: 'playing', positionMs: 0 })
    expect(events.slice(before)).toEqual([
      { type: 'ended', entryId: 'e1' },
      { type: 'status', status: { entryId: 'e2', state: 'playing', positionMs: 0 } },
    ])
    expect(second.paused).toBe(false)
    expect(first.hasAttribute('src')).toBe(false)
    expect(context.gains.map(node => node.gain.value)).toContain(0.5)

    second.finish()
    expect(events.slice(-2)).toEqual([
      { type: 'ended', entryId: 'e2' },
      { type: 'status', status: { entryId: 'e2', state: 'ended', positionMs: 5000 } },
    ])
  })

  it('reuses the preloaded element when the preloaded entry is loaded, and never ends a replaced entry', () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 1 })
    ready('/a')
    engine.preload({ entryId: 'e2', url: '/b', gain: 1 })
    const preloaded = ready('/b')
    engine.load({ entryId: 'e2', url: '/b', startMs: 0, autoplay: false, gain: 1 })
    expect(audioOf('/b')).toBe(preloaded)
    expect(engine.getStatus()).toEqual({ entryId: 'e2', state: 'paused', positionMs: 0 })
    expect(events.some(event => event.type === 'ended')).toBe(false)
  })

  it('keeps the preload when another entry is loaded', () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 1 })
    engine.preload({ entryId: 'e3', url: '/c', gain: 1 })
    engine.load({ entryId: 'e2', url: '/b', startMs: 0, autoplay: false, gain: 1 })
    expect(audios.filter(audio => audio.src).map(audio => audio.src).sort()).toEqual(['/b', '/c'])
  })

  it('maps media errors and drops a failed preload silently', () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: true, gain: 1 })
    engine.preload({ entryId: 'e2', url: '/b', gain: 1 })
    audioOf('/b').fail(2)
    expect(events.filter(event => event.type === 'error')).toEqual([])
    audioOf('/a').fail(4)
    expect(events.slice(-2)).toEqual([
      { type: 'error', entryId: 'e1', message: mediaErrorMessage(4) },
      { type: 'status', status: { entryId: 'e1', state: 'error', positionMs: 0 } },
    ])
    engine.play()
    expect(engine.getStatus().state).toBe('error')
  })

  it('reports a blocked play through the error path until unlocked', async () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: true, gain: 1 })
    const audio = audioOf('/a')
    audio.playResult = 'blocked'
    ready('/a')
    await flush()
    expect(engine.isBlocked()).toBe(true)
    expect(events.slice(-2)).toEqual([
      { type: 'error', entryId: 'e1', message: AUDIO_BLOCKED_MESSAGE },
      { type: 'status', status: { entryId: 'e1', state: 'error', positionMs: 0 } },
    ])
    audio.playResult = 'play'
    engine.unlock()
    expect(engine.isBlocked()).toBe(false)
    expect(engine.getStatus().state).toBe('playing')
    expect(context.resume).toHaveBeenCalled()
  })

  it('counts a suspended output that will not resume as blocked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    context.state = 'suspended'
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 1 })
    const audio = ready('/a')
    audio.playResult = 'pending'
    engine.play()
    await vi.advanceTimersByTimeAsync(600)
    expect(engine.isBlocked()).toBe(true)
    expect(audio.paused).toBe(true)
  })

  it('applies gain to the loaded entry, above unity too', () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 0.8 })
    ready('/a')
    engine.play()
    engine.setGain(1.6)
    expect(context.gains.map(node => node.gain.value)).toContain(1.6)
    expect(engine.canBoost).toBe(true)
  })

  it('stops into idle without ending anything', () => {
    engine.load({ entryId: 'e1', url: '/a', startMs: 0, autoplay: false, gain: 1 })
    ready('/a')
    engine.stop()
    expect(events.at(-1)).toEqual({ type: 'status', status: { entryId: null, state: 'idle', positionMs: 0 } })
    expect(events.some(event => event.type === 'ended')).toBe(false)
    engine.play()
    expect(engine.getStatus().state).toBe('idle')
  })
})

describe('engine errors', () => {
  it('words media errors and ignores aborts', () => {
    expect(mediaErrorMessage(1)).toBeNull()
    expect(mediaErrorMessage(3)).toMatch(/decoded/)
    expect(mediaErrorMessage(undefined)).toMatch(/could not be played/)
  })

  it('classifies play() rejections', () => {
    expect(playFailure(Object.assign(new Error(), { name: 'NotAllowedError' }))).toBe('blocked')
    expect(playFailure(Object.assign(new Error(), { name: 'AbortError' }))).toBe('aborted')
    expect(playFailure(new Error('nope'))).toBe('failed')
  })

  it('clamps positions once the duration is known', () => {
    expect(clampPosition(-5, 10)).toBe(0)
    expect(clampPosition(12_000, 10)).toBe(10_000)
    expect(clampPosition(12_000, Number.NaN)).toBe(12_000)
  })
})
