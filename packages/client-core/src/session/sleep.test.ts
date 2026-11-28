import { type QueueSeed, SLEEP_FADE_MS } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { type AnySessionCommand, createInitialSession, reduceSession, type Session } from './reducer.js'
import { bringSession, forkSession, leftBehind } from './scope.js'
import { sleepFade, sleepRemainingMs, sleepTimerAccessibilityLabel, sleepTimerChoiceId, sleepTimerChoices, sleepTimerLabel } from './sleep.js'

const track = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const seed = (n: number, extra: Partial<QueueSeed> = {}): QueueSeed => ({ trackId: track(n), albumId: null, durationMs: 200_000, ...extra })
const MINUTE = 60_000

let serial = 0
function run(session: Session, command: AnySessionCommand, now: number, deviceId = 'phone'): Session {
  serial += 1
  return reduceSession(session, { command, now, commandId: `s${serial}`, deviceId })
}

/** Tracks 1..count playing on `phone` from t=0. */
function playing(count = 3): Session {
  return run(createInitialSession(), { type: 'playTracks', tracks: Array.from({ length: count }, (_, index) => seed(index + 1)), seed: 1 }, 0)
}

const currentTrack = (session: Session) => session.current && Number(session.current.trackId.slice(-12))

describe('sleep timer in the reducer', () => {
  it('sets a timer that ends its length after the command, and replaces or clears it', () => {
    let session = run(playing(), { type: 'setSleepTimer', timer: { kind: 'time', durationMs: 30 * MINUTE } }, 5000)
    expect(session.sleepTimer).toEqual({ kind: 'time', endsAt: 5000 + 30 * MINUTE, durationMs: 30 * MINUTE })
    session = run(session, { type: 'setSleepTimer', timer: { kind: 'track' } }, 6000)
    expect(session.sleepTimer).toEqual({ kind: 'track' })
    expect(run(session, { type: 'setSleepTimer', timer: { kind: 'track' } }, 7000)).toBe(session)
    session = run(session, { type: 'setSleepTimer', timer: null }, 8000)
    expect(session).not.toHaveProperty('sleepTimer')
    expect(run(session, { type: 'setSleepTimer', timer: null }, 9000)).toBe(session)
  })

  it('refuses lengths it does not take', () => {
    const session = playing()
    expect(run(session, { type: 'setSleepTimer', timer: { kind: 'time', durationMs: 0 } }, 0)).toBe(session)
    expect(run(session, { type: 'setSleepTimer', timer: { kind: 'time', durationMs: 25 * 60 * MINUTE } }, 0)).toBe(session)
  })

  it('pauses where playback is and clears the timer when a time timer ends, not before', () => {
    const session = run(playing(), { type: 'setSleepTimer', timer: { kind: 'time', durationMs: MINUTE } }, 1000)
    expect(run(session, { type: 'endSleepTimer' }, 1000 + MINUTE - 1)).toBe(session)
    const ended = run(session, { type: 'endSleepTimer' }, 1000 + MINUTE)
    expect(ended).toMatchObject({ playing: false, positionMs: 1000 + MINUTE, anchorAt: 1000 + MINUTE })
    expect(ended).not.toHaveProperty('sleepTimer')
    expect(currentTrack(ended)).toBe(1)
  })

  it('clears an ended time timer while paused without moving anything', () => {
    let session = run(playing(), { type: 'setSleepTimer', timer: { kind: 'time', durationMs: MINUTE } }, 0)
    session = run(session, { type: 'pause' }, 10_000)
    const ended = run(session, { type: 'endSleepTimer' }, 2 * MINUTE)
    expect(ended).toMatchObject({ playing: false, positionMs: 10_000, anchorAt: 10_000 })
    expect(ended).not.toHaveProperty('sleepTimer')
  })

  it('ignores endSleepTimer without a time timer', () => {
    const session = run(playing(), { type: 'setSleepTimer', timer: { kind: 'track' } }, 0)
    expect(run(session, { type: 'endSleepTimer' }, 10 * MINUTE)).toBe(session)
    const plain = playing()
    expect(run(plain, { type: 'endSleepTimer' }, 10 * MINUTE)).toBe(plain)
  })

  it('at the end of the song, moves on to the next one paused and clears the timer', () => {
    let session = run(playing(), { type: 'setSleepTimer', timer: { kind: 'track' } }, 0)
    // Skipping keeps it: it stops at the end of whatever song plays.
    session = run(session, { type: 'next' }, 1000)
    expect(session.sleepTimer).toEqual({ kind: 'track' })
    const ended = run(session, { type: 'trackEnded', entryId: session.current!.id }, 201_000)
    expect(currentTrack(ended)).toBe(3)
    expect(ended).toMatchObject({ playing: false, positionMs: 0 })
    expect(ended).not.toHaveProperty('sleepTimer')
  })

  it('at the end of the song, wins over repeat one', () => {
    let session = run(playing(), { type: 'setRepeat', value: 'one' }, 0)
    session = run(session, { type: 'setSleepTimer', timer: { kind: 'track' } }, 0)
    const ended = run(session, { type: 'trackEnded', entryId: session.current!.id }, 200_000)
    expect(currentTrack(ended)).toBe(1)
    expect(ended).toMatchObject({ playing: false, positionMs: 0 })
    expect(ended).not.toHaveProperty('sleepTimer')
  })

  it('at the end of the queue, plays the queue through and stops before autoplay or repeat would go on', () => {
    let session = run(playing(2), { type: 'setSleepTimer', timer: { kind: 'queue' } }, 0)
    session = run(session, { type: 'setAutoplayQueue', tracks: [seed(9)] }, 0)
    session = run(session, { type: 'trackEnded', entryId: session.current!.id }, 200_000)
    expect(currentTrack(session)).toBe(2)
    expect(session).toMatchObject({ playing: true, sleepTimer: { kind: 'queue' } })
    const ended = run(session, { type: 'trackEnded', entryId: session.current!.id }, 400_000)
    expect(currentTrack(ended)).toBe(9)
    expect(ended).toMatchObject({ playing: false, positionMs: 0 })
    expect(ended).not.toHaveProperty('sleepTimer')

    const repeating = run(run(playing(2), { type: 'setRepeat', value: 'all' }, 0), { type: 'setSleepTimer', timer: { kind: 'queue' } }, 0)
    const last = run(repeating, { type: 'trackEnded', entryId: repeating.current!.id }, 200_000)
    expect(run(last, { type: 'trackEnded', entryId: last.current!.id }, 400_000)).toMatchObject({ playing: false })
  })

  it('at the end of the queue with nothing after it, stops at the end as playback would', () => {
    let session = run(playing(1), { type: 'setAutoplay', value: false }, 0)
    session = run(session, { type: 'setSleepTimer', timer: { kind: 'queue' } }, 0)
    const ended = run(session, { type: 'trackEnded', entryId: session.current!.id }, 200_000)
    expect(ended).toMatchObject({ playing: false, positionMs: 200_000 })
    expect(ended).not.toHaveProperty('sleepTimer')
  })

  it('keeps the timer through a transfer, a pause and a new queue', () => {
    let session = run(playing(), { type: 'setSleepTimer', timer: { kind: 'time', durationMs: MINUTE } }, 0)
    const timer = session.sleepTimer
    session = run(session, { type: 'transfer', deviceId: 'tv' }, 1000)
    session = run(session, { type: 'pause' }, 2000)
    session = run(session, { type: 'playTracks', tracks: [seed(5)], seed: 1 }, 3000)
    expect(session.sleepTimer).toBe(timer)
  })
})

describe('sleep timer across detaching', () => {
  it('goes with the active device that detaches and leaves the shared session without one', () => {
    const shared = run(playing(), { type: 'setSleepTimer', timer: { kind: 'track' } }, 0)
    expect(forkSession(shared, 'phone', 1000).sleepTimer).toEqual({ kind: 'track' })
    const left = leftBehind(shared, 'phone', { now: 1000, commandId: 'x' })
    expect(left).toMatchObject({ playing: false, activeDeviceId: null })
    expect(left).not.toHaveProperty('sleepTimer')
  })

  it('stays with the shared session when another device detaches', () => {
    const shared = run(playing(), { type: 'setSleepTimer', timer: { kind: 'track' } }, 0)
    expect(forkSession(shared, 'web', 1000)).not.toHaveProperty('sleepTimer')
    expect(leftBehind(shared, 'web', { now: 1000, commandId: 'x' })).toBe(shared)
  })

  it('comes back with a queue brought into the shared session, replacing its own', () => {
    const shared = run(playing(), { type: 'setSleepTimer', timer: { kind: 'track' } }, 0)
    const own = run(playing(), { type: 'setSleepTimer', timer: { kind: 'queue' } }, 0)
    expect(bringSession(shared, own, { now: 1000, commandId: 'b', deviceId: 'phone' }).sleepTimer).toEqual({ kind: 'queue' })
    expect(bringSession(shared, playing(), { now: 1000, commandId: 'b', deviceId: 'phone' })).not.toHaveProperty('sleepTimer')
  })
})

describe('sleep timer arithmetic', () => {
  it('counts a time timer down to its end', () => {
    const session = run(playing(), { type: 'setSleepTimer', timer: { kind: 'time', durationMs: 5 * MINUTE } }, 0)
    expect(sleepRemainingMs(session, 60_000)).toBe(4 * MINUTE)
    expect(sleepRemainingMs(session, 10 * MINUTE)).toBe(0)
    expect(sleepRemainingMs(playing(), 0)).toBeNull()
  })

  it('counts the end of the song from the position, the engine’s when given', () => {
    const session = run(playing(), { type: 'setSleepTimer', timer: { kind: 'track' } }, 0)
    expect(sleepRemainingMs(session, 50_000)).toBe(150_000)
    expect(sleepRemainingMs(session, 50_000, 60_000)).toBe(140_000)
    const unknown = run(createInitialSession(), { type: 'playTracks', tracks: [seed(1, { durationMs: 0 })], seed: 1 }, 0)
    expect(sleepRemainingMs(run(unknown, { type: 'setSleepTimer', timer: { kind: 'track' } }, 0), 0)).toBeNull()
  })

  it('counts the end of the queue through what is left of it, unless a length is unknown or repeat one never ends', () => {
    const session = run(playing(3), { type: 'setSleepTimer', timer: { kind: 'queue' } }, 0)
    expect(sleepRemainingMs(session, 50_000)).toBe(150_000 + 400_000)
    expect(sleepRemainingMs(run(session, { type: 'setRepeat', value: 'one' }, 0), 50_000)).toBeNull()
    const unknown = run(session, { type: 'enqueue', tracks: [seed(7, { durationMs: 0 })], placement: 'last' }, 0)
    expect(sleepRemainingMs(unknown, 0)).toBeNull()
  })

  it('fades over the last seconds only', () => {
    const session = run(playing(), { type: 'setSleepTimer', timer: { kind: 'time', durationMs: MINUTE } }, 0)
    expect(sleepFade(session, 0)).toBe(1)
    expect(sleepFade(session, MINUTE - SLEEP_FADE_MS)).toBe(1)
    expect(sleepFade(session, MINUTE - SLEEP_FADE_MS / 2)).toBeCloseTo(0.5)
    expect(sleepFade(session, MINUTE)).toBe(0)
    expect(sleepFade(playing(), 0)).toBe(1)
  })

  it('words the timer for the player and for a screen reader', () => {
    const timed = run(playing(), { type: 'setSleepTimer', timer: { kind: 'time', durationMs: 60 * MINUTE } }, 0)
    expect(sleepTimerLabel(timed, 0)).toBe('1:00:00')
    expect(sleepTimerLabel(timed, 59 * MINUTE + 500)).toBe('1:00')
    expect(sleepTimerAccessibilityLabel(timed, 59 * MINUTE + 500)).toBe('Sleep timer, 1:00 left')
    const song = run(createInitialSession(), { type: 'playTracks', tracks: [seed(1, { durationMs: 0 })], seed: 1 }, 0)
    const atEnd = run(song, { type: 'setSleepTimer', timer: { kind: 'track' } }, 0)
    expect(sleepTimerLabel(atEnd, 0)).toBe('End of song')
    expect(sleepTimerAccessibilityLabel(atEnd, 0)).toBe('Sleep timer, end of song')
    expect(sleepTimerLabel(playing(), 0)).toBeNull()
  })

  it('offers the lengths and the ends, named after where playback started, and marks the one set', () => {
    expect(sleepTimerChoices({ type: 'album', id: null, title: 'A' }).map(choice => choice.label)).toEqual([
      '5 minutes', '10 minutes', '15 minutes', '30 minutes', '45 minutes', '1 hour', 'End of song', 'End of album',
    ])
    expect(sleepTimerChoices({ type: 'playlist', id: null, title: 'P' }).at(-1)!.label).toBe('End of playlist')
    expect(sleepTimerChoices(null).at(-1)!.label).toBe('End of queue')
    expect(sleepTimerChoiceId({ kind: 'time', endsAt: 0, durationMs: 15 * MINUTE })).toBe('15')
    expect(sleepTimerChoiceId({ kind: 'time', endsAt: 0, durationMs: 7 * MINUTE })).toBeNull()
    expect(sleepTimerChoiceId({ kind: 'queue' })).toBe('queue')
    expect(sleepTimerChoiceId(undefined)).toBeNull()
  })
})
