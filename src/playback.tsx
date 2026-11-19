import 'expo-sqlite/localStorage/install'

import {
  createContext, type PropsWithChildren, useContext, useEffect, useMemo, useReducer, useState,
} from 'react'
import { AppState } from 'react-native'

import { albums, autoplayTrackIds, devices, tracks } from './catalog'

export type QueueEntry = { id: string; trackId: string }
type Repeat = 'off' | 'all' | 'one'
type Placement = 'next' | 'last'
type PlayOptions = { shuffled?: boolean; trackId?: string }

type Session = {
  trackId: string
  playing: boolean
  positionAtAnchor: number
  anchorTime: number
  queue: QueueEntry[]
  history: QueueEntry[]
  autoplayQueue: QueueEntry[]
  autoplay: boolean
  shuffle: boolean
  repeat: Repeat
  volume: number
  deviceId: string
  favorites: string[]
  playOrder: string[]
  playedInCycle: string[]
  serial: number
}

type Command =
  | { type: 'togglePlayback' | 'next' | 'previous' | 'tick' | 'toggleAutoplay' | 'cycleRepeat' | 'clearHistory' | 'clearQueue' }
  | { type: 'toggleShuffle'; seed: number }
  | { type: 'seek' | 'volume'; value: number }
  | { type: 'device' | 'favorite' | 'playTrack' | 'playQueueEntry' | 'removeFromQueue'; id: string }
  | { type: 'playCollection'; ids: readonly string[]; options?: PlayOptions; seed: number }
  | { type: 'queue'; id: string; placement: Placement }
  | { type: 'moveInQueue'; id: string; toIndex: number }

type TimedCommand = { command: Command; now: number }

// Keep the original key so existing installs retain their playback state.
const storageKey = 'tone.playback.v1'
const initialHistory = ['tail-lights', 'fern-line', 'paper-flowers', 'after-the-rain']
const historyLimit = 50
const initialTrack = 'night-swimming'

function initialSession(): Session {
  return {
    trackId: initialTrack,
    playing: false,
    positionAtAnchor: 48,
    anchorTime: 0,
    queue: albums['blue-hour'].trackIds.slice(1).map((trackId, index) => ({ id: `initial-${index}`, trackId })),
    history: initialHistory.map((trackId, index) => ({ id: `history-${index}`, trackId })),
    autoplayQueue: autoplayTrackIds.map((trackId, index) => ({ id: `autoplay-${index}`, trackId })),
    autoplay: true,
    shuffle: false,
    repeat: 'off',
    volume: 0.65,
    deviceId: devices[0].id,
    favorites: [initialTrack, 'static-bloom', 'amber', 'paper-flowers'],
    playOrder: [],
    playedInCycle: [],
    serial: 1,
  }
}

function hasTrack(id: string): boolean {
  return Object.hasOwn(tracks, id)
}

function clamp(value: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0
}

function positionAt(session: Session, now: number): number {
  const elapsed = session.playing ? Math.max(0, now - session.anchorTime) / 1000 : 0
  return Math.min(tracks[session.trackId].duration, session.positionAtAnchor + elapsed)
}

function loadSession(): Session {
  const fallback = initialSession()

  try {
    const json = globalThis.localStorage?.getItem(storageKey)
    if (!json) return fallback
    const saved = JSON.parse(json) as Partial<Session>
    if (typeof saved.trackId !== 'string' || !hasTrack(saved.trackId)) return fallback

    return {
      ...fallback,
      ...saved,
      playing: false,
      positionAtAnchor: clamp(saved.positionAtAnchor ?? 0, tracks[saved.trackId].duration),
      anchorTime: 0,
    }
  } catch {
    return fallback
  }
}

function saveSession(session: Session, now: number) {
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify({
      ...session,
      positionAtAnchor: positionAt(session, now),
      anchorTime: now,
    }))
  } catch {
    // Playback still works when local storage is unavailable.
  }
}

function allocate(session: Session, ids: readonly string[]) {
  return {
    entries: ids.map((trackId, index) => ({ id: `entry-${session.serial + index}`, trackId })),
    serial: session.serial + ids.length,
  }
}

function shuffleEntries<T>(entries: readonly T[], seed: number): T[] {
  const result = [...entries]
  for (let end = result.length - 1; end > 0; end -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const index = Math.floor(seed / 4294967296 * (end + 1))
    const entry = result[end]
    result[end] = result[index]
    result[index] = entry
  }
  if (result.length > 1 && result.every((value, index) => value === entries[index])) {
    return [...result.slice(1), result[0]]
  }
  return result
}

function startTrack(session: Session, id: string, now: number): Session {
  const { entries, serial } = allocate(session, [session.trackId])
  return {
    ...session,
    trackId: id,
    playing: true,
    positionAtAnchor: 0,
    anchorTime: now,
    history: [...session.history, ...entries].slice(-historyLimit),
    playedInCycle: [...session.playedInCycle, session.trackId].slice(-historyLimit),
    serial,
  }
}

function refreshAutoplay(session: Session): Session {
  const recent = new Set(session.history.slice(-4).map(entry => entry.trackId))
  const ids = autoplayTrackIds.filter(id => id !== session.trackId)
  const { entries, serial } = allocate(session, [
    ...ids.filter(id => !recent.has(id)),
    ...ids.filter(id => recent.has(id)),
  ])
  return { ...session, autoplayQueue: entries, serial }
}

function playEntry(session: Session, entry: QueueEntry, now: number): Session {
  const next = startTrack(session, entry.trackId, now)
  return {
    ...next,
    queue: next.queue.filter(item => item.id !== entry.id),
    playOrder: next.playOrder.filter(id => id !== entry.id),
    autoplayQueue: next.autoplayQueue.filter(item => item.id !== entry.id),
  }
}

function advance(session: Session, now: number, automatic: boolean): Session {
  if (automatic && session.repeat === 'one') {
    return { ...session, positionAtAnchor: 0, anchorTime: now }
  }

  if (session.queue.length) return playEntry(session, session.queue[0], now)

  if (session.repeat === 'all') {
    const cycle = [...session.playedInCycle, session.trackId]
    const next = startTrack(session, cycle[0], now)
    const { entries, serial } = allocate(next, cycle.slice(1))
    return { ...next, queue: entries, serial, playedInCycle: [] }
  }

  if (session.autoplay) {
    const next = session.autoplayQueue.length ? session : refreshAutoplay(session)
    return playEntry(next, next.autoplayQueue[0], now)
  }

  return {
    ...session,
    playing: false,
    positionAtAnchor: tracks[session.trackId].duration,
    anchorTime: now,
  }
}

function moveEntry(entries: QueueEntry[], id: string, toIndex: number): QueueEntry[] {
  const from = entries.findIndex(entry => entry.id === id)
  if (from < 0) return entries
  const destination = Math.trunc(clamp(toIndex, entries.length - 1))
  if (from === destination) return entries
  const result = [...entries]
  const [entry] = result.splice(from, 1)
  result.splice(destination, 0, entry)
  return result
}

function reduceSession(session: Session, { command, now }: TimedCommand): Session {
  switch (command.type) {
    case 'togglePlayback': {
      const position = positionAt(session, now)
      const ended = position >= tracks[session.trackId].duration
      return {
        ...session,
        playing: !session.playing,
        positionAtAnchor: !session.playing && ended ? 0 : position,
        anchorTime: now,
      }
    }
    case 'tick': {
      let next = session
      // The timestamp keeps the demo clock advancing while a client surface is suspended.
      for (let i = 0; i < 50 && next.playing; i += 1) {
        const endTime = next.anchorTime + (tracks[next.trackId].duration - next.positionAtAnchor) * 1000
        if (endTime > now) return next
        next = advance(next, endTime, true)
      }
      return next
    }
    case 'seek':
      return {
        ...session,
        positionAtAnchor: clamp(command.value, tracks[session.trackId].duration),
        anchorTime: now,
      }
    case 'volume':
      return { ...session, volume: clamp(command.value, 1) }
    case 'device':
      return devices.some(device => device.id === command.id)
        ? { ...session, deviceId: command.id }
        : session
    case 'favorite':
      if (!hasTrack(command.id)) return session
      return {
        ...session,
        favorites: session.favorites.includes(command.id)
          ? session.favorites.filter(id => id !== command.id)
          : [command.id, ...session.favorites],
      }
    case 'next':
      return advance(session, now, false)
    case 'previous': {
      const entry = session.history.at(-1)
      if (positionAt(session, now) >= 3 || !entry) {
        return { ...session, positionAtAnchor: 0, anchorTime: now }
      }
      const { entries, serial } = allocate(session, [session.trackId])
      return {
        ...session,
        trackId: entry.trackId,
        queue: [...entries, ...session.queue],
        playOrder: session.shuffle ? [...entries.map(item => item.id), ...session.playOrder] : [],
        history: session.history.slice(0, -1),
        playedInCycle: session.playedInCycle.slice(0, -1),
        serial,
        positionAtAnchor: 0,
        anchorTime: now,
      }
    }
    case 'playTrack':
      if (!hasTrack(command.id)) return session
      if (command.id !== session.trackId) return startTrack(session, command.id, now)
      return session.playing ? session : reduceSession(session, { command: { type: 'togglePlayback' }, now })
    case 'playCollection': {
      const ids = command.ids.filter(hasTrack)
      if (!ids.length) return session
      const shuffle = command.options?.shuffled ?? session.shuffle
      const ordered = shuffle ? shuffleEntries(ids, command.seed) : ids
      const requested = command.options?.trackId
      const startIndex = requested ? Math.max(0, ordered.indexOf(requested)) : 0
      const trackId = ordered[startIndex]
      const upcoming = ordered.slice(startIndex + 1)
      if (shuffle) upcoming.push(...ordered.slice(0, startIndex))
      const next = trackId === session.trackId
        ? { ...session, playing: true, positionAtAnchor: 0, anchorTime: now }
        : startTrack(session, trackId, now)
      const { entries, serial } = allocate(next, upcoming)
      const inCollectionOrder = [...entries].sort((a, b) => ids.indexOf(a.trackId) - ids.indexOf(b.trackId))
      return {
        ...next,
        queue: entries,
        shuffle,
        playOrder: shuffle ? inCollectionOrder.map(item => item.id) : [],
        playedInCycle: [],
        serial,
      }
    }
    case 'queue': {
      if (!hasTrack(command.id)) return session
      const { entries, serial } = allocate(session, [command.id])
      const entry = entries[0]
      const queue = command.placement === 'next' ? [entry, ...session.queue] : [...session.queue, entry]
      const playOrder = command.placement === 'next'
        ? [entry.id, ...session.playOrder]
        : [...session.playOrder, entry.id]
      return { ...session, queue, serial, playOrder: session.shuffle ? playOrder : [] }
    }
    case 'playQueueEntry': {
      const entry = [...session.queue, ...session.autoplayQueue].find(item => item.id === command.id)
      return entry ? playEntry(session, entry, now) : session
    }
    case 'moveInQueue': {
      const queue = moveEntry(session.queue, command.id, command.toIndex)
      const autoplayQueue = moveEntry(session.autoplayQueue, command.id, command.toIndex)
      const playOrder = session.shuffle && queue !== session.queue ? queue.map(item => item.id) : session.playOrder
      return { ...session, queue, autoplayQueue, playOrder }
    }
    case 'removeFromQueue':
      return {
        ...session,
        queue: session.queue.filter(item => item.id !== command.id),
        playOrder: session.playOrder.filter(id => id !== command.id),
        autoplayQueue: session.autoplayQueue.filter(item => item.id !== command.id),
      }
    case 'toggleAutoplay':
      return { ...session, autoplay: !session.autoplay }
    case 'toggleShuffle':
      if (session.shuffle) {
        return {
          ...session,
          shuffle: false,
          queue: [...session.queue].sort((a, b) => session.playOrder.indexOf(a.id) - session.playOrder.indexOf(b.id)),
          playOrder: [],
        }
      }
      return {
        ...session,
        shuffle: true,
        playOrder: session.queue.map(item => item.id),
        queue: shuffleEntries(session.queue, command.seed),
      }
    case 'cycleRepeat': {
      const repeat = { off: 'all', all: 'one', one: 'off' } as const
      return { ...session, repeat: repeat[session.repeat] }
    }
    case 'clearQueue':
      return { ...session, queue: [], playOrder: [] }
    case 'clearHistory':
      return { ...session, history: [] }
  }
}

function useSession() {
  const [state, dispatch] = useReducer(reduceSession, undefined, loadSession)
  const [now, setNow] = useState(Date.now)

  const actions = useMemo(() => {
    const send = (command: Command) => dispatch({ command, now: Date.now() })
    const seed = () => Math.floor(Math.random() * 4294967296)

    return {
      playPause: () => send({ type: 'togglePlayback' }),
      seek: (value: number) => send({ type: 'seek', value }),
      next: () => send({ type: 'next' }),
      previous: () => send({ type: 'previous' }),
      setVolume: (value: number) => send({ type: 'volume', value }),
      setDevice: (id: string) => send({ type: 'device', id }),
      toggleFavorite: (id: string) => send({ type: 'favorite', id }),
      toggleAutoplay: () => send({ type: 'toggleAutoplay' }),
      toggleShuffle: () => send({ type: 'toggleShuffle', seed: seed() }),
      cycleRepeat: () => send({ type: 'cycleRepeat' }),
      playTrack: (id: string) => send({ type: 'playTrack', id }),
      playCollection: (ids: readonly string[], options?: PlayOptions) =>
        send({ type: 'playCollection', ids, options, seed: seed() }),
      playAlbum: (id: string, options?: PlayOptions) => {
        if (Object.hasOwn(albums, id)) {
          send({ type: 'playCollection', ids: albums[id].trackIds, options, seed: seed() })
        }
      },
      addToQueue: (id: string, placement: Placement = 'last') => send({ type: 'queue', id, placement }),
      removeFromQueue: (id: string) => send({ type: 'removeFromQueue', id }),
      moveInQueue: (id: string, toIndex: number) => send({ type: 'moveInQueue', id, toIndex }),
      playQueueEntry: (id: string) => send({ type: 'playQueueEntry', id }),
      clearHistory: () => send({ type: 'clearHistory' }),
      clearQueue: () => send({ type: 'clearQueue' }),
    }
  }, [])

  useEffect(() => {
    if (!state.playing) return
    const tick = () => {
      const now = Date.now()
      dispatch({ command: { type: 'tick' }, now })
      setNow(now)
    }
    const timer = setInterval(tick, 500)
    tick()
    return () => clearInterval(timer)
  }, [state.playing])

  useEffect(() => {
    saveSession(state, Date.now())
    const listener = AppState.addEventListener('change', status => {
      const now = Date.now()
      if (status === 'active') {
        dispatch({ command: { type: 'tick' }, now })
        setNow(now)
      } else {
        saveSession(state, now)
      }
    })
    return () => listener.remove()
  }, [state])

  const playback = useMemo(() => {
    const track = tracks[state.trackId]
    const album = albums[track.albumId]
    const device = devices.find(item => item.id === state.deviceId) ?? devices[0]
    return { state, track, album, device, actions }
  }, [state, actions])

  return { playback, position: positionAt(state, now) }
}

const PlaybackContext = createContext<ReturnType<typeof useSession>['playback'] | null>(null)
const PositionContext = createContext(0)

export function PlaybackProvider({ children }: PropsWithChildren) {
  const { playback, position } = useSession()
  return (
    <PlaybackContext.Provider value={playback}>
      <PositionContext.Provider value={position}>{children}</PositionContext.Provider>
    </PlaybackContext.Provider>
  )
}

export function usePlaybackState() {
  const playback = useContext(PlaybackContext)
  if (!playback) throw new Error('Playback hooks must be used inside PlaybackProvider')
  return playback
}

export function usePlayback() {
  const playback = usePlaybackState()
  const position = useContext(PositionContext)
  return { ...playback, position }
}
