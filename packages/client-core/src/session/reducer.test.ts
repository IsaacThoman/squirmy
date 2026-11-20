import { type QueueEntry, type QueueSeed, SessionQueue, SessionState } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import {
  type AnySessionCommand,
  createInitialSession,
  HISTORY_LIMIT,
  joinSession,
  positionAt,
  queueChanged,
  reduceSession,
  type Session,
  splitSession,
} from './reducer.js'

const track = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const album = track(999)
const seed = (n: number, extra: Partial<QueueSeed> = {}): QueueSeed => ({ trackId: track(n), albumId: album, durationMs: 200_000, ...extra })
const seeds = (...ns: number[]) => ns.map(n => seed(n))

let commandCounter = 0
function run(session: Session, command: AnySessionCommand, now = 1000, deviceId = 'phone'): Session {
  commandCounter += 1
  return reduceSession(session, { command, now, commandId: `c${commandCounter}`, deviceId })
}

/** Plays tracks 1..count at t=0 on `phone`. */
function playing(count = 5, extra: Partial<Extract<AnySessionCommand, { type: 'playTracks' }>> = {}): Session {
  return run(createInitialSession(), { type: 'playTracks', tracks: seeds(...range(1, count)), seed: 1, ...extra }, 0)
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const trackNumbers = (entries: QueueEntry[]) => entries.map(entry => Number(entry.trackId.slice(-12)))
const currentTrack = (session: Session) => session.current && Number(session.current.trackId.slice(-12))

describe('reduceSession', () => {
  it('returns the same object for invalid and unknown commands', () => {
    const session = playing()
    expect(run(session, { type: 'seek', positionMs: -5 })).toBe(session)
    expect(run(session, { type: 'bogus' } as unknown as AnySessionCommand)).toBe(session)
    expect(run(session, { type: 'playTracks', tracks: [], seed: 1 })).toBe(session)
    expect(reduceSession(session, { command: { type: 'pause' }, now: Number.NaN, commandId: 'x' })).toBe(session)
  })

  describe('playTracks', () => {
    it('starts the first track and queues the rest', () => {
      const session = playing(3, { context: { type: 'album', id: album, title: 'A' } })
      expect(currentTrack(session)).toBe(1)
      expect(trackNumbers(session.queue)).toEqual([2, 3])
      expect(session).toMatchObject({ playing: true, positionMs: 0, anchorAt: 0, activeDeviceId: 'phone', playOrder: [], context: { id: album } })
    })

    it('starts at startIndex and drops earlier tracks without shuffle', () => {
      const session = playing(5, { startIndex: 2 })
      expect(currentTrack(session)).toBe(3)
      expect(trackNumbers(session.queue)).toEqual([4, 5])
    })

    it('clamps startIndex', () => {
      expect(currentTrack(playing(3, { startIndex: 10 }))).toBe(3)
    })

    it('derives entry ids from the command id', () => {
      const session = reduceSession(createInitialSession(), { command: { type: 'playTracks', tracks: seeds(1, 2), seed: 1 }, now: 0, commandId: 'abc' })
      expect([session.current!.id, ...session.queue.map(entry => entry.id)]).toEqual(['abc.0', 'abc.1'])
    })

    it('with shuffle and a start index, queues every other track in shuffled order', () => {
      const session = playing(6, { shuffle: true, startIndex: 3 })
      expect(currentTrack(session)).toBe(4)
      expect(trackNumbers(session.queue).sort()).toEqual([1, 2, 3, 5, 6])
      expect(session.shuffle).toBe(true)
      expect(session.playOrder).toEqual([...session.queue].sort((a, b) => a.trackId.localeCompare(b.trackId)).map(entry => entry.id))
    })

    it('with shuffle and no start index, starts at the first of the shuffled order', () => {
      const a = playing(6, { shuffle: true, seed: 7 })
      const b = playing(6, { shuffle: true, seed: 7 })
      expect(currentTrack(a)).toBe(currentTrack(b))
      expect(trackNumbers(a.queue)).toEqual(trackNumbers(b.queue))
      expect(a.queue).toHaveLength(5)
    })

    it('moves the previous current entry to history and resets the cycle', () => {
      let session = playing(2)
      session = run(session, { type: 'next' })
      session = run(session, { type: 'playTracks', tracks: seeds(7), seed: 1 })
      expect(trackNumbers(session.history)).toEqual([1, 2])
      expect(session.playedInCycle).toEqual([])
    })

    it('starts a preparing entry stalled at 0', () => {
      const session = run(createInitialSession(), { type: 'playTracks', tracks: [seed(1, { state: 'preparing' })], seed: 1 })
      expect(session).toMatchObject({ playing: true, stalled: true, positionMs: 0 })
      expect(positionAt(session, 60_000)).toBe(0)
    })
  })

  describe('position', () => {
    it('advances from the anchor while playing and caps at the duration', () => {
      const session = playing()
      expect(positionAt(session, 5000)).toBe(5000)
      expect(positionAt(session, 10_000_000)).toBe(200_000)
    })

    it('does not cap when the duration is unknown', () => {
      const session = run(createInitialSession(), { type: 'playTracks', tracks: [seed(1, { durationMs: 0 })], seed: 1 }, 0)
      expect(positionAt(session, 500_000)).toBe(500_000)
    })

    it('is 0 without a current entry', () => {
      expect(positionAt(createInitialSession(), 5000)).toBe(0)
    })
  })

  describe('play and pause', () => {
    it('pause re-anchors at the current position', () => {
      const session = run(playing(), { type: 'pause' }, 4000)
      expect(session).toMatchObject({ playing: false, positionMs: 4000, anchorAt: 4000 })
      expect(positionAt(session, 9000)).toBe(4000)
    })

    it('play resumes from the paused position', () => {
      const session = run(run(playing(), { type: 'pause' }, 4000), { type: 'play' }, 6000)
      expect(session).toMatchObject({ playing: true, positionMs: 4000, anchorAt: 6000 })
    })

    it('play at the end restarts the track', () => {
      let session = run(createInitialSession(), { type: 'playTracks', tracks: seeds(1), seed: 1 }, 0)
      session = run(session, { type: 'trackEnded', entryId: session.current!.id }, 200_000)
      expect(session).toMatchObject({ playing: false, positionMs: 200_000 })
      expect(run(session, { type: 'play' }, 300_000)).toMatchObject({ playing: true, positionMs: 0, anchorAt: 300_000 })
    })

    it('play with nothing current starts the queue', () => {
      const session = run(createInitialSession(), { type: 'enqueue', tracks: seeds(1, 2), placement: 'last' })
      expect(session.current).toBeNull()
      const started = run(session, { type: 'play' })
      expect(currentTrack(started)).toBe(1)
      expect(started.playing).toBe(true)
    })

    it('are no-ops in the state they ask for', () => {
      const session = playing()
      expect(run(session, { type: 'play' })).toBe(session)
      const paused = run(session, { type: 'pause' })
      expect(run(paused, { type: 'pause' })).toBe(paused)
      expect(run(createInitialSession(), { type: 'play' })).toEqual(createInitialSession())
    })
  })

  describe('active device', () => {
    it('is claimed by the device that starts playback when none is active', () => {
      expect(playing().activeDeviceId).toBe('phone')
      const paused = run(playing(), { type: 'deviceLost', deviceId: 'phone' })
      expect(run(paused, { type: 'play' }, 2000, 'web').activeDeviceId).toBe('web')
    })

    it('is not claimed without a device id or without playback', () => {
      const queued = run(createInitialSession(), { type: 'enqueue', tracks: seeds(1), placement: 'last' }, 0, 'web')
      expect(queued.activeDeviceId).toBeNull()
      expect(reduceSession(createInitialSession(), { command: { type: 'playTracks', tracks: seeds(1), seed: 1 }, now: 0, commandId: 'x' }).activeDeviceId).toBeNull()
    })

    it('does not change when another device starts playback', () => {
      const paused = run(playing(), { type: 'pause' })
      expect(run(paused, { type: 'play' }, 2000, 'web').activeDeviceId).toBe('phone')
    })

    it('transfer re-anchors and moves playback', () => {
      const session = run(playing(), { type: 'transfer', deviceId: 'web' }, 7000)
      expect(session).toMatchObject({ activeDeviceId: 'web', playing: true, positionMs: 7000, anchorAt: 7000 })
      expect(run(session, { type: 'transfer', deviceId: 'web', play: false }, 8000)).toMatchObject({ playing: false, positionMs: 8000 })
      expect(run(session, { type: 'transfer', deviceId: 'web' }, 9000)).toBe(session)
    })

    it('transfer cannot start playback without a current entry', () => {
      expect(run(createInitialSession(), { type: 'transfer', deviceId: 'web', play: true })).toMatchObject({ playing: false, activeDeviceId: 'web' })
    })

    it('deviceLost pauses at the computed position and clears the device', () => {
      const session = run(playing(), { type: 'deviceLost', deviceId: 'phone' }, 12_000)
      expect(session).toMatchObject({ playing: false, positionMs: 12_000, activeDeviceId: null })
      const other = playing()
      expect(run(other, { type: 'deviceLost', deviceId: 'web' })).toBe(other)
    })
  })

  describe('next and track end', () => {
    it('next plays the queue head and records history', () => {
      const session = run(playing(3), { type: 'next' }, 5000)
      expect(currentTrack(session)).toBe(2)
      expect(trackNumbers(session.queue)).toEqual([3])
      expect(trackNumbers(session.history)).toEqual([1])
      expect(trackNumbers(session.playedInCycle)).toEqual([1])
      expect(session).toMatchObject({ playing: true, positionMs: 0, anchorAt: 5000 })
    })

    it('next while paused starts playing', () => {
      const paused = run(playing(3), { type: 'pause' })
      expect(run(paused, { type: 'next' }).playing).toBe(true)
    })

    it('at the end of the queue pauses at the end of the current track', () => {
      let session = playing(1)
      session = run(session, { type: 'setAutoplay', value: false })
      session = run(session, { type: 'next' }, 3000)
      expect(currentTrack(session)).toBe(1)
      expect(session).toMatchObject({ playing: false, positionMs: 200_000 })
    })

    it('continues from the autoplay queue when the queue runs out', () => {
      let session = playing(1)
      session = run(session, { type: 'setAutoplayQueue', tracks: seeds(50, 51) })
      session = run(session, { type: 'trackEnded', entryId: session.current!.id })
      expect(currentTrack(session)).toBe(50)
      expect(trackNumbers(session.autoplayQueue)).toEqual([51])
      const off = run(run(playing(1), { type: 'setAutoplayQueue', tracks: seeds(50) }), { type: 'setAutoplay', value: false })
      expect(currentTrack(run(off, { type: 'next' }))).toBe(1)
    })

    it('trackEnded is ignored unless it names the current entry', () => {
      const session = playing(3)
      expect(run(session, { type: 'trackEnded', entryId: 'nope' })).toBe(session)
      const ended = run(session, { type: 'trackEnded', entryId: session.current!.id })
      expect(run(ended, { type: 'trackEnded', entryId: session.current!.id })).toBe(ended)
    })

    it('trackEnded from a device other than the active one is ignored', () => {
      const session = playing(3)
      expect(run(session, { type: 'trackEnded', entryId: session.current!.id }, 1000, 'web')).toBe(session)
    })

    it('repeat one restarts the track under a fresh id on trackEnded, but next still advances', () => {
      let session = run(playing(3), { type: 'setRepeat', value: 'one' })
      const first = session.current!
      session = run(session, { type: 'trackEnded', entryId: first.id }, 200_000)
      expect(session.current).toMatchObject({ trackId: first.trackId })
      expect(session.current!.id).not.toBe(first.id)
      expect(session.history.at(-1)).toBe(first)
      expect(session).toMatchObject({ playing: true, positionMs: 0, anchorAt: 200_000 })
      expect(currentTrack(run(session, { type: 'next' }))).toBe(2)
    })

    it('repeat all starts a new cycle in the order played', () => {
      let session = run(playing(3), { type: 'setRepeat', value: 'all' })
      for (let i = 0; i < 3; i += 1) session = run(session, { type: 'trackEnded', entryId: session.current!.id })
      expect(currentTrack(session)).toBe(1)
      expect(trackNumbers(session.queue)).toEqual([2, 3])
      expect(session.playedInCycle).toEqual([])
      const ids = [session.current!.id, ...session.queue.map(entry => entry.id), ...session.history.map(entry => entry.id)]
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('repeat all with shuffle keeps playOrder in step with the queue', () => {
      let session = run(playing(4, { shuffle: true }), { type: 'setRepeat', value: 'all' })
      for (let i = 0; i < 4; i += 1) session = run(session, { type: 'next' })
      expect(session.playOrder).toEqual(session.queue.map(entry => entry.id))
    })

    it('history is bounded', () => {
      let session = playing(HISTORY_LIMIT + 10)
      for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) session = run(session, { type: 'next' })
      expect(session.history).toHaveLength(HISTORY_LIMIT)
      expect(currentTrack({ ...session, current: session.history.at(-1)! })).toBe(HISTORY_LIMIT + 5)
    })
  })

  describe('previous', () => {
    it('steps back through history within the first 3 seconds', () => {
      let session = run(playing(3), { type: 'next' }, 1000)
      session = run(session, { type: 'previous' }, 2000)
      expect(currentTrack(session)).toBe(1)
      expect(trackNumbers(session.queue)).toEqual([2, 3])
      expect(session.history).toEqual([])
      expect(session.playedInCycle).toEqual([])
    })

    it('restarts the track after 3 seconds', () => {
      const session = run(playing(3), { type: 'previous' }, 3000)
      expect(currentTrack(session)).toBe(1)
      expect(session).toMatchObject({ positionMs: 0, anchorAt: 3000 })
    })

    it('restarts the track when there is no history', () => {
      expect(run(playing(3), { type: 'previous' }, 1000)).toMatchObject({ positionMs: 0, anchorAt: 1000 })
    })

    it('puts the current entry at the front of playOrder with shuffle', () => {
      let session = run(playing(4, { shuffle: true }), { type: 'next' }, 1000)
      const current = session.current!
      session = run(session, { type: 'previous' }, 1500)
      expect(session.queue[0]).toBe(current)
      expect(session.playOrder[0]).toBe(current.id)
    })

    it('with nothing current and no history is a no-op', () => {
      const session = createInitialSession()
      expect(run(session, { type: 'previous' })).toBe(session)
    })
  })

  describe('seek', () => {
    it('re-anchors at the clamped position', () => {
      expect(run(playing(), { type: 'seek', positionMs: 50_000 }, 9000)).toMatchObject({ positionMs: 50_000, anchorAt: 9000 })
      expect(run(playing(), { type: 'seek', positionMs: 900_000 }).positionMs).toBe(200_000)
    })

    it('is ignored without a current entry or while preparing', () => {
      const empty = createInitialSession()
      expect(run(empty, { type: 'seek', positionMs: 10 })).toBe(empty)
      const preparing = run(empty, { type: 'playTracks', tracks: [seed(1, { state: 'preparing' })], seed: 1 })
      expect(run(preparing, { type: 'seek', positionMs: 10 })).toBe(preparing)
    })
  })

  describe('shuffle', () => {
    it('shuffling then un-shuffling restores collection order', () => {
      let session = playing(12)
      const original = session.queue
      session = run(session, { type: 'setShuffle', value: true, seed: 42 })
      expect(trackNumbers(session.queue)).not.toEqual(trackNumbers(original))
      expect(session.playOrder).toEqual(original.map(entry => entry.id))
      session = run(session, { type: 'setShuffle', value: false, seed: 0 })
      expect(session.queue).toEqual(original)
      expect(session.playOrder).toEqual([])
    })

    it('un-shuffling after play next keeps the added entry first', () => {
      let session = run(playing(5), { type: 'setShuffle', value: true, seed: 3 })
      session = run(session, { type: 'enqueue', tracks: seeds(9), placement: 'next' })
      session = run(session, { type: 'setShuffle', value: false, seed: 0 })
      expect(trackNumbers(session.queue)).toEqual([9, 2, 3, 4, 5])
    })

    it('is deterministic for a seed and never returns the input order', () => {
      const a = run(playing(2), { type: 'setShuffle', value: true, seed: 5 })
      expect(trackNumbers(a.queue)).toEqual([2])
      const three = run(playing(3), { type: 'setShuffle', value: true, seed: 0 })
      expect(trackNumbers(three.queue)).toEqual([3, 2])
    })

    it('setting the current value is a no-op', () => {
      const session = playing()
      expect(run(session, { type: 'setShuffle', value: false, seed: 1 })).toBe(session)
    })
  })

  describe('queue editing', () => {
    it('enqueue next and last', () => {
      let session = playing(3)
      session = run(session, { type: 'enqueue', tracks: seeds(8, 9), placement: 'next' })
      session = run(session, { type: 'enqueue', tracks: seeds(7), placement: 'last' })
      expect(trackNumbers(session.queue)).toEqual([8, 9, 2, 3, 7])
      expect(session.playOrder).toEqual([])
    })

    it('enqueue keeps playOrder in step while shuffled', () => {
      let session = run(playing(3), { type: 'setShuffle', value: true, seed: 1 })
      session = run(session, { type: 'enqueue', tracks: seeds(7), placement: 'last' })
      expect(session.playOrder.at(-1)).toBe(session.queue.at(-1)!.id)
    })

    it('playQueueEntry plays the entry and keeps the ones before it', () => {
      let session = playing(4)
      session = run(session, { type: 'playQueueEntry', entryId: session.queue[1]!.id })
      expect(currentTrack(session)).toBe(3)
      expect(trackNumbers(session.queue)).toEqual([2, 4])
      expect(trackNumbers(session.history)).toEqual([1])
    })

    it('playQueueEntry plays from the autoplay queue', () => {
      let session = run(playing(2), { type: 'setAutoplayQueue', tracks: seeds(50, 51) })
      session = run(session, { type: 'playQueueEntry', entryId: session.autoplayQueue[1]!.id })
      expect(currentTrack(session)).toBe(51)
      expect(trackNumbers(session.autoplayQueue)).toEqual([50])
      expect(run(session, { type: 'playQueueEntry', entryId: 'missing' })).toBe(session)
    })

    it('removeFromQueue removes from the queue, playOrder and autoplay queue', () => {
      let session = run(run(playing(4), { type: 'setShuffle', value: true, seed: 2 }), { type: 'setAutoplayQueue', tracks: seeds(50) })
      const victim = session.queue[0]!
      session = run(session, { type: 'removeFromQueue', entryId: victim.id })
      expect(session.queue).not.toContain(victim)
      expect(session.playOrder).not.toContain(victim.id)
      session = run(session, { type: 'removeFromQueue', entryId: session.autoplayQueue[0]!.id })
      expect(session.autoplayQueue).toEqual([])
      expect(run(session, { type: 'removeFromQueue', entryId: 'missing' })).toBe(session)
    })

    it('moveInQueue moves within the queue and clamps the index', () => {
      let session = playing(5)
      session = run(session, { type: 'moveInQueue', entryId: session.queue[0]!.id, toIndex: 99 })
      expect(trackNumbers(session.queue)).toEqual([3, 4, 5, 2])
      expect(run(session, { type: 'moveInQueue', entryId: session.queue[0]!.id, toIndex: 0 })).toBe(session)
    })

    it('moveInQueue while shuffled makes the new order the one shuffle-off restores', () => {
      let session = run(playing(5), { type: 'setShuffle', value: true, seed: 9 })
      session = run(session, { type: 'moveInQueue', entryId: session.queue[3]!.id, toIndex: 0 })
      const order = session.queue
      expect(session.playOrder).toEqual(order.map(entry => entry.id))
      expect(run(session, { type: 'setShuffle', value: false, seed: 0 }).queue).toEqual(order)
    })

    it('moveInQueue moves within the autoplay queue', () => {
      let session = run(playing(1), { type: 'setAutoplayQueue', tracks: seeds(50, 51, 52) })
      session = run(session, { type: 'moveInQueue', entryId: session.autoplayQueue[2]!.id, toIndex: 0 })
      expect(trackNumbers(session.autoplayQueue)).toEqual([52, 50, 51])
    })

    it('clearQueue and clearHistory', () => {
      let session = run(playing(3), { type: 'next' })
      session = run(session, { type: 'clearQueue' })
      expect(session.queue).toEqual([])
      expect(run(session, { type: 'clearQueue' })).toBe(session)
      session = run(session, { type: 'clearHistory' })
      expect(session.history).toEqual([])
      expect(run(session, { type: 'clearHistory' })).toBe(session)
    })
  })

  describe('settings', () => {
    it('repeat, autoplay and volume', () => {
      let session = createInitialSession()
      session = run(session, { type: 'setRepeat', value: 'all' })
      session = run(session, { type: 'setAutoplay', value: false })
      session = run(session, { type: 'setVolume', deviceId: 'phone', value: 0.5 })
      expect(session).toMatchObject({ repeat: 'all', autoplay: false, volumes: { phone: 0.5 } })
      expect(run(session, { type: 'setRepeat', value: 'all' })).toBe(session)
      expect(run(session, { type: 'setVolume', deviceId: 'phone', value: 0.5 })).toBe(session)
      expect(run(session, { type: 'setVolume', deviceId: 'phone', value: 2 })).toBe(session)
    })
  })

  describe('on-demand entries', () => {
    const preparing = () => run(createInitialSession(), {
      type: 'playTracks',
      tracks: [seed(1, { state: 'preparing' }), seed(2), seed(1, { state: 'preparing' }), seed(3)],
      seed: 1,
    }, 0)

    it('ready un-stalls the current entry and updates every entry of the track', () => {
      const session = run(preparing(), { type: 'setEntryState', trackId: track(1), state: 'ready' }, 5000)
      expect(session).toMatchObject({ stalled: false, positionMs: 0, anchorAt: 5000, playing: true })
      expect(session.current!.state).toBe('ready')
      expect(session.queue[1]!.state).toBe('ready')
      expect(positionAt(session, 6000)).toBe(1000)
    })

    it('failed on the current entry advances to the next playable entry', () => {
      let session = preparing()
      session = run(session, { type: 'setEntryState', trackId: track(1), state: 'failed' }, 5000)
      expect(currentTrack(session)).toBe(2)
      expect(session.history).toEqual([])
      session = run(session, { type: 'next' })
      expect(currentTrack(session)).toBe(3)
      expect(session.queue).toEqual([])
    })

    it('failed with nothing playable left pauses on the failed entry', () => {
      let session = run(createInitialSession(), { type: 'playTracks', tracks: [seed(1, { state: 'preparing' })], seed: 1 }, 0)
      session = run(session, { type: 'setAutoplay', value: false })
      session = run(session, { type: 'setEntryState', trackId: track(1), state: 'failed' })
      expect(session).toMatchObject({ playing: false, stalled: false, positionMs: 0, current: { state: 'failed' } })
      expect(run(session, { type: 'previous' })).toMatchObject({ positionMs: 0 })
    })

    it('playQueueEntry refuses a failed entry, previous skips failed history', () => {
      let session = run(playing(3), { type: 'next' })
      session = run(session, { type: 'setEntryState', trackId: track(3), state: 'failed' })
      expect(run(session, { type: 'playQueueEntry', entryId: session.queue[0]!.id })).toBe(session)
      session = run(session, { type: 'setEntryState', trackId: track(1), state: 'failed' })
      expect(currentTrack(run(session, { type: 'previous' }, 1000))).toBe(2)
    })

    it('failed leaves a ready current entry playing and fails its other entries', () => {
      let session = run(preparing(), { type: 'setEntryState', trackId: track(1), state: 'ready' }, 5000)
      session = run(session, { type: 'setEntryState', trackId: track(1), state: 'failed' }, 6000)
      expect(session).toMatchObject({ playing: true, current: { trackId: track(1), state: 'ready' } })
      expect(positionAt(session, 7000)).toBe(2000)
      expect(session.queue[1]).toMatchObject({ trackId: track(1), state: 'failed' })
    })

    it('unknown track is a no-op', () => {
      const session = playing()
      expect(run(session, { type: 'setEntryState', trackId: track(77), state: 'ready' })).toBe(session)
    })
  })

  describe('syncPosition', () => {
    it('re-anchors at the reported position', () => {
      const session = playing()
      expect(run(session, { type: 'syncPosition', entryId: session.current!.id, positionMs: 4000, stalled: true }, 5000))
        .toMatchObject({ positionMs: 4000, anchorAt: 5000, stalled: true })
      expect(run(session, { type: 'syncPosition', entryId: 'other', positionMs: 4000, stalled: false })).toBe(session)
    })
  })

  describe('split, join and queueChanged', () => {
    it('round-trips and detects queue changes', () => {
      const session = playing()
      const { state, queue } = splitSession(session)
      expect(SessionState.parse(state)).toEqual(state)
      expect(SessionQueue.parse(queue)).toEqual(queue)
      expect(joinSession(state, queue)).toEqual(session)
      expect(queueChanged(session, run(session, { type: 'pause' }))).toBe(false)
      expect(queueChanged(session, run(session, { type: 'next' }))).toBe(true)
      expect(queueChanged(session, run(session, { type: 'setEntryState', trackId: track(1), state: 'ready' }))).toBe(false)
    })
  })
})

describe('reduceSession under random commands', () => {
  /** Mulberry32: a small deterministic PRNG. */
  function prng(seedValue: number) {
    let state = seedValue
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function randomCommand(random: () => number, session: Session): AnySessionCommand {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    const int = (max: number) => Math.floor(random() * max)
    const someSeeds = () => Array.from({ length: 1 + int(6) }, () => seed(1 + int(12), {
      state: random() < 0.2 ? 'preparing' : 'ready',
      durationMs: random() < 0.1 ? 0 : 1000 + int(300_000),
    }))
    const entryIds = [...session.queue, ...session.autoplayQueue, ...(session.current ? [session.current] : [])].map(entry => entry.id)
    const anEntry = () => (entryIds.length && random() < 0.9 ? pick(entryIds) : 'missing')
    const device = () => pick(['phone', 'web', 'tv'])
    const commands: (() => AnySessionCommand)[] = [
      () => ({ type: 'play' }),
      () => ({ type: 'pause' }),
      () => ({ type: 'next' }),
      () => ({ type: 'previous' }),
      () => ({ type: 'seek', positionMs: int(400_000) }),
      () => ({ type: 'setShuffle', value: random() < 0.5, seed: int(1e9) }),
      () => ({ type: 'setRepeat', value: pick(['off', 'all', 'one'] as const) }),
      () => ({ type: 'setAutoplay', value: random() < 0.5 }),
      () => ({ type: 'playTracks', tracks: someSeeds(), seed: int(1e9), shuffle: random() < 0.5, ...(random() < 0.5 ? { startIndex: int(8) } : {}) }),
      () => ({ type: 'enqueue', tracks: someSeeds(), placement: pick(['next', 'last'] as const) }),
      () => ({ type: 'playQueueEntry', entryId: anEntry() }),
      () => ({ type: 'removeFromQueue', entryId: anEntry() }),
      () => ({ type: 'moveInQueue', entryId: anEntry(), toIndex: int(10) }),
      () => ({ type: 'clearQueue' }),
      () => ({ type: 'clearHistory' }),
      () => ({ type: 'transfer', deviceId: device(), ...(random() < 0.5 ? { play: random() < 0.5 } : {}) }),
      () => ({ type: 'setVolume', deviceId: device(), value: random() }),
      () => ({ type: 'trackEnded', entryId: anEntry() }),
      () => ({ type: 'setEntryState', trackId: track(1 + int(12)), state: pick(['ready', 'preparing', 'failed'] as const) }),
      () => ({ type: 'setAutoplayQueue', tracks: random() < 0.2 ? [] : someSeeds() }),
      () => ({ type: 'deviceLost', deviceId: device() }),
      () => ({ type: 'syncPosition', entryId: anEntry(), positionMs: int(400_000), stalled: random() < 0.3 }),
    ]
    return pick(commands)()
  }

  function invariantViolations(session: Session): string[] {
    const problems: string[] = []
    const { state, queue } = splitSession(session)
    if (!SessionState.safeParse(state).success) problems.push('state does not match SessionState')
    if (!SessionQueue.safeParse(queue).success) problems.push('queue does not match SessionQueue')
    const ids = [session.current, ...session.queue, ...session.autoplayQueue, ...session.history].filter(Boolean).map(entry => entry!.id)
    if (new Set(ids).size !== ids.length) problems.push('duplicate entry ids')
    const queueIds = session.queue.map(entry => entry.id)
    if (session.shuffle) {
      if ([...session.playOrder].sort().join() !== [...queueIds].sort().join()) problems.push('playOrder is not a permutation of the queue')
    } else if (session.playOrder.length) {
      problems.push('playOrder set without shuffle')
    }
    if (session.current?.state === 'preparing' && (!session.stalled || session.positionMs !== 0)) problems.push('preparing but not stalled at 0')
    if (session.current && session.current.durationMs > 0 && session.positionMs > session.current.durationMs) problems.push('position past the end')
    if (session.playing && (!session.current || session.current.state === 'failed')) problems.push('playing nothing')
    if (session.playing && session.activeDeviceId === null) problems.push('playing without an active device')
    if (session.history.length > HISTORY_LIMIT) problems.push('history too long')
    return problems
  }

  it('never produces an invalid state', () => {
    for (let run = 0; run < 200; run += 1) {
      const random = prng(run + 1)
      let session = createInitialSession()
      let now = 0
      for (let step = 0; step < 150; step += 1) {
        const command = randomCommand(random, session)
        now += Math.floor(random() * 20_000)
        const next = reduceSession(session, { command, now, commandId: `r${run}s${step}`, deviceId: random() < 0.5 ? 'phone' : 'web' })
        const problems = invariantViolations(next)
        if (problems.length) throw new Error(`run ${run}, step ${step}, ${JSON.stringify(command)}: ${problems.join(', ')}`)
        if (next === session) expect(queueChanged(session, next)).toBe(false)
        session = next
      }
    }
  })

  it('is deterministic', () => {
    const play = () => {
      const random = prng(99)
      let session = createInitialSession()
      for (let step = 0; step < 200; step += 1) {
        session = reduceSession(session, { command: randomCommand(random, session), now: step * 1000, commandId: `d${step}`, deviceId: 'phone' })
      }
      return session
    }
    expect(play()).toEqual(play())
  })

  it('shuffle then un-shuffle restores collection order from any queue', () => {
    for (let run = 0; run < 100; run += 1) {
      const random = prng(1000 + run)
      const count = 2 + Math.floor(random() * 40)
      let session = playing(count)
      session = reduceSession(session, { command: { type: 'enqueue', tracks: seeds(70, 71), placement: 'last' }, now: 1, commandId: `e${run}` })
      const original = session.queue
      session = reduceSession(session, { command: { type: 'setShuffle', value: true, seed: Math.floor(random() * 1e9) }, now: 2, commandId: `s${run}` })
      session = reduceSession(session, { command: { type: 'setShuffle', value: false, seed: 0 }, now: 3, commandId: `u${run}` })
      expect(session.queue).toEqual(original)
    }
  })
})
