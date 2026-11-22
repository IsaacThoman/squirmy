import { FakeEngine, positionAt, type SessionClientSnapshot } from '@squirmy/client-core'
import type { QueueEntry, SessionCommand, SessionState } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { audibleOf, Listening } from './listening'

const entry = (state: QueueEntry['state'] = 'ready', id = 'e1'): QueueEntry => ({ id, trackId: `t-${id}`, albumId: null, durationMs: 200_000, state })

/** A session client that holds one snapshot and records what is sent. */
function client(state: Partial<SessionState>, isActiveDevice = true) {
  let now = 1_000
  const sent: SessionCommand[] = []
  const session: SessionState = {
    current: entry(), playing: true, positionMs: 0, anchorAt: now, stalled: false, activeDeviceId: 'here',
    shuffle: false, repeat: 'off', autoplay: false, context: null, volumes: {}, ...state,
  }
  const value = {
    snapshot: { session, isActiveDevice } as SessionClientSnapshot,
    sent,
    advance: (ms: number) => { now += ms },
    set: (next: Partial<SessionState>) => { value.snapshot = { ...value.snapshot, session: { ...value.snapshot.session, ...next } } },
    getSnapshot: () => value.snapshot,
    getPositionMs: () => positionAt(value.snapshot.session, now),
    dispatch: (command: SessionCommand) => { sent.push(command) },
  }
  return value
}

/** A fake engine that never blocks, playing `entryId` (or loading it). */
function engine(entryId: string | null, state: 'loading' | 'playing' | 'buffering' = 'playing', blocked = false) {
  const fake = Object.assign(new FakeEngine(() => 0), { isBlocked: () => blocked })
  if (entryId) fake.load({ entryId, url: '/stream', startMs: 0, autoplay: state !== 'loading', gain: 1 })
  if (entryId && state === 'loading') {
    // FakeEngine settles at once; hold it in `loading` the way a real stream does at first.
    fake.getStatus = () => ({ entryId, state: 'loading', positionMs: 0 })
  }
  if (state === 'buffering') fake.buffer()
  return fake
}

describe('audibleOf', () => {
  it('is waiting while the session plays and this tab has no sound yet', () => {
    expect(audibleOf(client({}).snapshot, engine(null))).toBe('waiting')
    expect(audibleOf(client({}).snapshot, engine('e1', 'loading'))).toBe('waiting')
    expect(audibleOf(client({}).snapshot, engine('e1', 'buffering'))).toBe('waiting')
    // Still the previous song, while the next one's stream is being asked for.
    expect(audibleOf(client({}).snapshot, engine('e0'))).toBe('waiting')
    expect(audibleOf(client({ current: entry('preparing') }).snapshot, engine(null))).toBe('waiting')
  })

  it('is playing only once the engine plays the current entry', () => {
    expect(audibleOf(client({}).snapshot, engine('e1'))).toBe('playing')
  })

  it('is blocked when the browser held back the current entry', () => {
    expect(audibleOf(client({}).snapshot, engine('e1', 'playing', true))).toBe('blocked')
  })

  it('is paused whatever the engine does while the session is paused', () => {
    expect(audibleOf(client({ playing: false }).snapshot, engine('e1'))).toBe('paused')
  })

  it('follows the session’s stall for a device that plays elsewhere', () => {
    expect(audibleOf(client({ stalled: true }, false).snapshot, engine(null))).toBe('waiting')
    expect(audibleOf(client({ current: entry('preparing') }, false).snapshot, engine(null))).toBe('waiting')
    expect(audibleOf(client({}, false).snapshot, engine(null))).toBe('playing')
  })
})

describe('Listening', () => {
  it('holds the clock where a new song will start while its stream cannot be had', () => {
    // Offline: the session moved on to the next song and its clock runs, but nothing loads.
    const session = client({ positionMs: 0 })
    const listening = new Listening(session, engine(null))
    session.advance(23_000)
    expect(session.getPositionMs()).toBe(23_000)
    expect(listening.position()).toBe(0)
  })

  it('keeps the place of a song that stops being heard instead of jumping', () => {
    const session = client({ positionMs: 0 })
    const playing = engine('e1')
    const listening = new Listening(session, playing)
    session.advance(40_000)
    expect(listening.position()).toBe(40_000)
    playing.stop()
    session.advance(10_000)
    expect(listening.position()).toBe(40_000)
  })

  it('shows where a loading stream is heading', () => {
    const session = client({ positionMs: 90_000 })
    const loading = engine('e1', 'loading')
    loading.getStatus = () => ({ entryId: 'e1', state: 'loading', positionMs: 90_000 })
    session.advance(2_000)
    expect(new Listening(session, loading).position()).toBe(90_000)
  })

  it('reads the session client while there is sound, and on a device that does not play', () => {
    const session = client({})
    const listening = new Listening(session, engine('e1'))
    session.advance(5_000)
    expect(listening.position()).toBe(5_000)
    const remote = client({}, false)
    remote.advance(7_000)
    expect(new Listening(remote, engine(null)).position()).toBe(7_000)
  })

  it('keeps a seek made while the song is fetched and sends it once the song is ready', () => {
    const session = client({ current: entry('preparing') })
    const listening = new Listening(session, engine(null))
    listening.seek(100_000)
    expect(session.sent).toEqual([])
    expect(listening.position()).toBe(100_000)
    listening.update()
    expect(session.sent).toEqual([])
    session.set({ current: entry('ready') })
    listening.update()
    expect(session.sent).toEqual([{ type: 'seek', positionMs: 100_000 }])
    listening.update()
    expect(session.sent).toHaveLength(1)
  })

  it('forgets a kept seek when another song becomes current or the song fails', () => {
    const session = client({ current: entry('preparing') })
    const listening = new Listening(session, engine(null))
    listening.seek(100_000)
    session.set({ current: entry('ready', 'e2') })
    listening.update()
    session.set({ current: entry('ready') })
    listening.update()
    expect(session.sent).toEqual([])

    listening.seek(50_000)
    expect(session.sent).toEqual([{ type: 'seek', positionMs: 50_000 }])
    session.set({ current: entry('preparing', 'e3') })
    listening.seek(10_000)
    session.set({ current: entry('failed', 'e3') })
    listening.update()
    session.set({ current: entry('ready', 'e3') })
    listening.update()
    expect(session.sent).toHaveLength(1)
  })
})
