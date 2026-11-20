import { afterEach, describe, expect, it, vi } from 'vitest'
import { estimatePosition, mediaArtwork, MediaSessionAdapter, positionState } from './media-session'

class FakeMediaSession {
  metadata: unknown = null
  playbackState = 'none'
  readonly handlers = new Map<string, ((details: object) => void) | null>()
  readonly positions: unknown[] = []
  setActionHandler(action: string, handler: ((details: object) => void) | null) {
    if (action === 'seekto' && handler) throw new Error('unsupported')
    this.handlers.set(action, handler)
  }
  setPositionState(state?: unknown) { this.positions.push(state) }
  act(action: string, details: object = {}) { this.handlers.get(action)?.({ action, ...details }) }
}

const track = { title: 'Night Swimming', artist: 'Mira Vale', album: 'Blue Hour', artwork: [] }

afterEach(() => vi.unstubAllGlobals())

describe('media session', () => {
  it('builds position states in seconds and skips unknown durations', () => {
    expect(positionState(90_000, 180_000)).toEqual({ duration: 180, position: 90, playbackRate: 1 })
    expect(positionState(200_000, 180_000)?.position).toBe(180)
    expect(positionState(0, 0)).toBeNull()
  })

  it('estimates the position since the last update only while playing', () => {
    const snapshot = { track, playing: true, positionMs: 1000, durationMs: 3000 }
    expect(estimatePosition(snapshot, 500)).toBe(1500)
    expect(estimatePosition(snapshot, 5000)).toBe(3000)
    expect(estimatePosition({ ...snapshot, playing: false }, 500)).toBe(1000)
  })

  it('lists every rendition as artwork', () => {
    expect(mediaArtwork(size => `/art/x/${size}`).map(image => image.sizes)).toEqual(['96x96', '300x300', '600x600', '1200x1200'])
  })

  it('mirrors the snapshot and turns actions into commands', () => {
    vi.stubGlobal('MediaMetadata', class {
      init: object
      constructor(init: object) { this.init = init }
    })
    const session = new FakeMediaSession()
    const commands = { play: vi.fn(), pause: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn() }
    const adapter = new MediaSessionAdapter(commands, session as unknown as MediaSession)

    adapter.update({ track, playing: true, positionMs: 30_000, durationMs: 180_000 })
    expect(session.playbackState).toBe('playing')
    expect(session.metadata).toMatchObject({ init: track })
    expect(session.positions.at(-1)).toEqual({ duration: 180, position: 30, playbackRate: 1 })

    session.act('pause')
    session.act('nexttrack')
    session.act('seekbackward', { seekOffset: 5 })
    expect(commands.pause).toHaveBeenCalled()
    expect(commands.next).toHaveBeenCalled()
    expect(commands.seek.mock.calls[0][0]).toBeGreaterThanOrEqual(25_000)
    expect(commands.seek.mock.calls[0][0]).toBeLessThan(26_000)

    adapter.dispose()
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
    expect([...session.handlers.values()].every(handler => handler === null)).toBe(true)
  })
})
