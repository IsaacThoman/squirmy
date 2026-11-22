import type { EntryFailure, QueueEntry } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import type { SessionOutage } from './client.js'
import { PlaybackNoticeWatcher, skipNotice, stopNotice } from './notices.js'
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

describe('skipNotice and stopNotice', () => {
  it('words a song that is not available lightly, and anything else as a failure', () => {
    expect(skipNotice('Intro', 'unavailable')).toEqual({ message: 'Skipped “Intro” — not available' })
    expect(skipNotice(undefined, 'unavailable')).toEqual({ message: 'Skipped a song that isn’t available' })
    expect(skipNotice('Intro', 'error')).toEqual({ message: 'Couldn’t play “Intro”', detail: 'Skipped.' })
    // An older server says nothing about why.
    expect(skipNotice('Intro', undefined)).toEqual({ message: 'Couldn’t play “Intro”', detail: 'Skipped.' })
  })

  it('says why playback stopped', () => {
    expect(stopNotice({ kind: 'outage', reason: 'Fetching is down.' })).toEqual({ message: 'Can’t load music right now', detail: 'Fetching is down. Playback is paused.' })
    expect(stopNotice({ kind: 'failures', reason: null })).toEqual({ message: 'Can’t load music right now', detail: 'Playback is paused.' })
    expect(stopNotice({ kind: 'exhausted', reason: null })).toEqual({ message: 'None of the remaining songs are available' })
  })
})

describe('PlaybackNoticeWatcher', () => {
  it('tells a current song that failed and was skipped, with why', () => {
    const { update } = watcher({ [track(1)]: 'unavailable' })
    expect(update({ current: entry(1), queue: [entry(2)] })).toEqual({ skipped: [], stopped: null })
    expect(update({ current: entry(2) })).toEqual({ skipped: [{ entry: entry(1), failure: 'unavailable' }], stopped: null })
  })

  it('tells the next song once it fails, and nothing further down', () => {
    const { update } = watcher({ [track(2)]: 'error' })
    update({ current: entry(1, 'ready'), queue: [entry(2), entry(3), entry(4)] })
    expect(update({ current: entry(1, 'ready'), queue: [entry(2), entry(3), entry(4, 'failed')] }).skipped).toEqual([])
    expect(update({ current: entry(1, 'ready'), queue: [entry(2, 'failed'), entry(3), entry(4, 'failed')] }).skipped)
      .toEqual([{ entry: entry(2, 'failed'), failure: 'error' }])
    // Already told: reaching it says nothing more.
    expect(update({ current: entry(3), queue: [entry(4, 'failed')], history: [entry(1, 'ready')] }).skipped).toEqual([])
  })

  it('tells a song that ended the queue, held failed, as a skip', () => {
    const { update } = watcher({ [track(1)]: 'unavailable' })
    update({ current: entry(1) })
    expect(update({ current: entry(1, 'failed'), playing: false })).toEqual({ skipped: [{ entry: entry(1, 'failed'), failure: 'unavailable' }], stopped: null })
  })

  it('tells a stop once instead of the song, and nothing per song until playback resumes', () => {
    const { update } = watcher({ [track(1)]: 'outage', [track(2)]: 'outage' })
    update({ current: entry(1), queue: [entry(2), entry(3)] })
    const outage: SessionOutage = { trackId: track(1), kind: 'outage', reason: 'Fetching is down.' }
    expect(update({ current: entry(1, 'failed'), queue: [entry(2, 'failed'), entry(3)], playing: false, outage }))
      .toEqual({ skipped: [], stopped: { message: 'Can’t load music right now', detail: 'Fetching is down. Playback is paused.' } })
    expect(update({ current: entry(1, 'failed'), queue: [entry(2, 'failed'), entry(3, 'failed')], playing: false, outage })).toEqual({ skipped: [], stopped: null })

    // Played again: the next failure is told anew.
    update({ current: entry(4), queue: [entry(5)], playing: true })
    const again: SessionOutage = { trackId: track(4), kind: 'outage', reason: 'Fetching is down.' }
    expect(update({ current: entry(4, 'failed'), queue: [entry(5)], playing: false, outage: again }).stopped).not.toBeNull()
  })

  it('tells a run of songs not to be had that ran out of queue as one stop', () => {
    const { update } = watcher({ [track(2)]: 'unavailable' })
    update({ current: entry(2), history: [entry(1, 'ready')] })
    const outage: SessionOutage = { trackId: track(2), kind: 'exhausted', reason: null }
    expect(update({ current: entry(2, 'failed'), history: [entry(1, 'ready')], playing: false, outage }))
      .toEqual({ skipped: [], stopped: { message: 'None of the remaining songs are available' } })
  })

  it('counts the first autoplay suggestion as next when Up Next is empty', () => {
    const { watching } = watcher()
    const shape = (state: QueueEntry['state']) => {
      const { state: session, queue } = splitSession({ ...createInitialSession(), current: entry(1, 'ready'), playing: true, autoplay: true, autoplayQueue: [entry(2, state), entry(3, state)] })
      return { session, queue, connection: 'online' as const, outage: null }
    }
    watching.update(shape('preparing'))
    expect(watching.update(shape('failed')).skipped.map(skip => skip.entry.id)).toEqual(['e.2'])
  })

  it('says nothing offline, or on its first look', () => {
    const { update } = watcher()
    expect(update({ current: entry(1), queue: [entry(2)] })).toEqual({ skipped: [], stopped: null })
    expect(update({ current: entry(2), connection: 'offline' })).toEqual({ skipped: [], stopped: null })
  })
})
