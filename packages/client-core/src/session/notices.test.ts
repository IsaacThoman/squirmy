import type { EntryFailure, QueueEntry } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import type { SessionOutage } from './client.js'
import { PlaybackNoticeWatcher, skipNotice, stopNotice, unavailableNotice } from './notices.js'
import { createInitialSession, splitSession } from './reducer.js'

const track = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const entry = (n: number, state: QueueEntry['state'] = 'preparing'): QueueEntry => ({ id: `e.${n}`, trackId: track(n), albumId: null, durationMs: 1000, state })

type Shape = { current?: QueueEntry | null; queue?: QueueEntry[]; history?: QueueEntry[]; playing?: boolean; outage?: SessionOutage | null; connection?: 'online' | 'offline' }

function snapshot({ current = null, queue = [], history = [], playing = true, outage = null, connection = 'online' }: Shape) {
  const { state, queue: half } = splitSession({ ...createInitialSession(), current, queue, history, playing })
  return { session: state, queue: half, connection, outage }
}

function watcher(failures: Record<string, EntryFailure> = {}) {
  const watching = new PlaybackNoticeWatcher(trackId => failures[trackId])
  return { watching, update: (shape: Shape) => watching.update(snapshot(shape)) }
}

describe('skipNotice, unavailableNotice and stopNotice', () => {
  it('names one song not available and counts a run of them, and words anything else as a failure', () => {
    expect(unavailableNotice({ count: 1 }, 'Intro')).toEqual({ message: 'Skipped “Intro” — not available' })
    expect(unavailableNotice({ count: 1 }, undefined)).toEqual({ message: 'Skipped a song that isn’t available' })
    expect(unavailableNotice({ count: 3 }, 'Intro')).toEqual({ message: 'Skipped 3 songs — not available' })
    expect(skipNotice('Intro', 'error')).toEqual({ message: 'Couldn’t play “Intro”', detail: 'Skipped.' })
    // An older server says nothing about why.
    expect(skipNotice('Intro', undefined)).toEqual({ message: 'Couldn’t play “Intro”', detail: 'Skipped.' })
  })

  it('says why playback stopped', () => {
    expect(stopNotice({ kind: 'outage', reason: 'Fetching is down.' })).toEqual({ message: 'Can’t load music right now', detail: 'Fetching is down. Playback is paused.' })
    expect(stopNotice({ kind: 'failures', reason: null })).toEqual({ message: 'Can’t load music right now', detail: 'Playback is paused.' })
    expect(stopNotice({ kind: 'exhausted', reason: null })).toEqual({ message: 'None of the remaining songs are available' })
    expect(stopNotice({ kind: 'unavailable', reason: null })).toEqual({ message: 'Several songs in a row aren’t available', detail: 'Playback is paused.' })
  })
})

const none = { skipped: [], unavailable: null, stopped: null }

describe('PlaybackNoticeWatcher', () => {
  it('tells a current song that failed for no known reason and was skipped', () => {
    const { update } = watcher({ [track(1)]: 'error' })
    expect(update({ current: entry(1), queue: [entry(2)] })).toEqual(none)
    expect(update({ current: entry(2) })).toEqual({ ...none, skipped: [{ entry: entry(1), failure: 'error' }] })
  })

  it('tells a song further on at its turn, when playback passes over it, not when it fails', () => {
    const { update } = watcher({ [track(2)]: 'error' })
    update({ current: entry(1, 'ready'), queue: [entry(2), entry(3), entry(4)] })
    expect(update({ current: entry(1, 'ready'), queue: [entry(2), entry(3), entry(4, 'failed')] })).toEqual(none)
    // Still first in Up next: nothing is said yet.
    expect(update({ current: entry(1, 'ready'), queue: [entry(2, 'failed'), entry(3), entry(4, 'failed')] })).toEqual(none)
    // Its turn: the session passes over it.
    expect(update({ current: entry(3), queue: [entry(4, 'failed')], history: [entry(1, 'ready')] }).skipped)
      .toEqual([{ entry: entry(2, 'failed'), failure: 'error' }])
  })

  it('says nothing of failed songs the listener jumped past', () => {
    const { update } = watcher({ [track(2)]: 'error' })
    update({ current: entry(1, 'ready'), queue: [entry(2, 'failed'), entry(3), entry(4)] })
    expect(update({ current: entry(4), history: [entry(1, 'ready')] })).toEqual(none)
  })

  it('collapses songs not available into one run that counts them, the passed-over ones too, until a song plays', () => {
    const { update } = watcher(Object.fromEntries([1, 2, 3, 4, 5].map(n => [track(n), 'unavailable' as const])))
    update({ current: entry(1), queue: [entry(2), entry(3), entry(4), entry(5), entry(6), entry(7)] })
    expect(update({ current: entry(2), queue: [entry(3), entry(4), entry(5), entry(6), entry(7)] }).unavailable).toEqual({ count: 1, entry: entry(1) })
    // Two ahead fail quietly; then the current one fails and the session passes over them.
    expect(update({ current: entry(2), queue: [entry(3), entry(4, 'failed'), entry(5, 'failed'), entry(6), entry(7)] })).toEqual(none)
    expect(update({ current: entry(3), queue: [entry(4, 'failed'), entry(5, 'failed'), entry(6), entry(7)] }).unavailable).toEqual({ count: 2, entry: entry(1) })
    expect(update({ current: entry(6), queue: [entry(7)] }).unavailable).toEqual({ count: 5, entry: entry(1) })
    // A song plays: the next one not available starts a new run.
    update({ current: entry(6, 'ready'), queue: [entry(7)] })
    const failures = watcher({ [track(7)]: 'unavailable' })
    failures.update({ current: entry(6, 'ready'), queue: [entry(7), entry(8)] })
    expect(failures.update({ current: entry(6, 'ready'), queue: [entry(7, 'failed'), entry(8)] })).toEqual(none)
    expect(failures.update({ current: entry(8), history: [entry(6, 'ready')] }).unavailable).toEqual({ count: 1, entry: entry(7, 'failed') })
  })

  it('tells a song playback stayed on, failed (picked, or the end of the queue), as one that could not play', () => {
    const { update } = watcher({ [track(1)]: 'unavailable' })
    update({ current: entry(1), queue: [entry(2)] })
    expect(update({ current: entry(1, 'failed'), queue: [entry(2)], playing: false })).toEqual({ ...none, skipped: [{ entry: entry(1, 'failed'), failure: 'unavailable', held: true }] })
    expect(skipNotice('Intro', 'unavailable', true)).toEqual({ message: 'Couldn’t play “Intro”', detail: 'It isn’t available.' })
    expect(skipNotice(undefined, 'error', true)).toEqual({ message: 'Couldn’t play this song' })
  })

  it('tells a stop once instead of the song, and nothing per song until playback resumes', () => {
    const { update } = watcher({ [track(1)]: 'outage', [track(2)]: 'outage' })
    update({ current: entry(1), queue: [entry(2), entry(3)] })
    const outage: SessionOutage = { trackId: track(1), kind: 'outage', reason: 'Fetching is down.' }
    expect(update({ current: entry(1, 'failed'), queue: [entry(2, 'failed'), entry(3)], playing: false, outage }))
      .toEqual({ ...none, stopped: { message: 'Can’t load music right now', detail: 'Fetching is down. Playback is paused.' } })
    expect(update({ current: entry(1, 'failed'), queue: [entry(2, 'failed'), entry(3, 'failed')], playing: false, outage })).toEqual(none)

    // Played again: the next failure is told anew.
    update({ current: entry(4), queue: [entry(5)], playing: true })
    const again: SessionOutage = { trackId: track(4), kind: 'outage', reason: 'Fetching is down.' }
    expect(update({ current: entry(4, 'failed'), queue: [entry(5)], playing: false, outage: again }).stopped).not.toBeNull()
  })

  it('tells a run of songs not to be had that ran out of queue, or ran too long, as one stop', () => {
    const { update } = watcher({ [track(2)]: 'unavailable' })
    update({ current: entry(2), history: [entry(1, 'ready')] })
    const outage: SessionOutage = { trackId: track(2), kind: 'exhausted', reason: null }
    expect(update({ current: entry(2, 'failed'), history: [entry(1, 'ready')], playing: false, outage }))
      .toEqual({ ...none, stopped: { message: 'None of the remaining songs are available' } })
    const capped = watcher({ [track(3)]: 'unavailable' })
    capped.update({ current: entry(3), queue: [entry(4)] })
    const run: SessionOutage = { trackId: track(3), kind: 'unavailable', reason: null }
    expect(capped.update({ current: entry(3, 'failed'), queue: [entry(4)], playing: false, outage: run }))
      .toEqual({ ...none, stopped: { message: 'Several songs in a row aren’t available', detail: 'Playback is paused.' } })
  })

  it('tells a failed autoplay suggestion at its turn too', () => {
    const { watching } = watcher({ [track(2)]: 'error' })
    const shape = (state: QueueEntry['state']) => {
      const { state: session, queue } = splitSession({ ...createInitialSession(), current: entry(1, 'ready'), playing: true, autoplay: true, autoplayQueue: [entry(2, state), entry(3, state)] })
      return { session, queue, connection: 'online' as const, outage: null }
    }
    watching.update(shape('preparing'))
    expect(watching.update(shape('failed'))).toEqual(none)
    const { state: session, queue } = splitSession({ ...createInitialSession(), current: entry(3), playing: true, autoplay: true, history: [entry(1, 'ready')] })
    expect(watching.update({ session, queue, connection: 'online', outage: null }).skipped.map(skip => skip.entry.id)).toEqual(['e.2'])
  })

  it('says nothing offline, or on its first look', () => {
    const { update } = watcher()
    expect(update({ current: entry(1), queue: [entry(2)] })).toEqual(none)
    expect(update({ current: entry(2), connection: 'offline' })).toEqual(none)
  })
})
