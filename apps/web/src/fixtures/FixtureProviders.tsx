import type { QueueEntry, TrackSummary } from '@squirmy/contracts'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { LibraryContext, type LibraryActions } from '@/player/library-context'
import { OnDemandContext, type OnDemand } from '@/player/on-demand-context'
import { NowPlayingContext, PlayerContext, PlayerControlsContext, PositionClock, PositionContext, useNowPlayingStore, type Player, type PlayerControls, type PlayerState, type QueueItem, type StatusMessage } from '@/player/player-context'
import { ArtUrlContext } from '@/lib/artwork'
import { STILL_LOADING_MS } from '@/player/use-still-loading'
import { STATUS_ERROR_MS, STATUS_EVENT_MS } from '@/player/status'
import { fixtureArtUrl, lyricsFor, playlistSummaries, track } from './catalog'
import { devices, thisDeviceId } from './server'

/**
 * Stands in for the session client and the API in tests and on the /dev pages: holds a
 * playback session in memory, advances a fake clock, and remembers wants for this page
 * load. No audio, and no network.
 */
export function FixtureProviders({ children, initial }: { children: ReactNode; initial?: Partial<PlayerState> }) {
  const [{ session: state, position }, dispatch] = useReducer(clock, initial, init)
  const library = useFixtureLibrary()
  const advancing = state.playing && state.current?.entry.state === 'ready'
  const [positionClock] = useState(() => {
    let current = 0
    const shown = new PositionClock(() => current)
    return { shown, set: (next: number) => { current = next; shown.sync() } }
  })
  useEffect(() => positionClock.set(position), [positionClock, position])

  useEffect(() => {
    if (!advancing) return
    const timer = setInterval(() => dispatch({ type: 'tick', ms: 250 }), 250)
    return () => clearInterval(timer)
  }, [advancing])

  // An on-demand track is fetched by the server; pretend it arrives some seconds later, after
  // the player has said "Still loading…", so the dev pages show that too.
  // Keyed by the entries waiting, so a song played later waits its own full time.
  const preparing = [state.current, ...state.queue].flatMap(item => (item?.entry.state === 'preparing' ? [item.entry.id] : [])).join()
  useEffect(() => {
    if (!preparing) return
    const timer = setTimeout(() => dispatch({ type: 'ready' }), STILL_LOADING_MS + 2000)
    return () => clearTimeout(timer)
  }, [preparing])

  // The status line, as the real player has it: a line goes away by itself.
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(statusTimer.current), [])
  const tell = useCallback((line: StatusMessage) => {
    clearTimeout(statusTimer.current)
    dispatch({ type: 'patch', patch: () => ({ status: { ...line, key: 'action' } }) })
    statusTimer.current = setTimeout(() => dispatch({ type: 'patch', patch: () => ({ status: null }) }), line.tone === 'error' ? STATUS_ERROR_MS : STATUS_EVENT_MS)
  }, [])

  const controls = useMemo<PlayerControls>(() => {
    const restart = (action: Action) => dispatch({ type: 'restart', action })
    return {
      togglePlay: () => dispatch({ type: 'patch', patch: state => ({ playing: !state.playing }) }),
      next: () => restart({ type: 'next' }),
      previous: () => dispatch({ type: 'previous' }),
      seek: positionMs => dispatch({ type: 'seek', positionMs }),
      setVolume: volume => dispatch({ type: 'patch', patch: state => ({ volume, volumes: { ...state.volumes, [state.activeDeviceId ?? state.thisDeviceId]: volume } }) }),
      setShuffle: shuffle => dispatch({ type: 'patch', patch: () => ({ shuffle }) }),
      cycleRepeat: () => dispatch({ type: 'patch', patch: state => ({ repeat: state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off' }) }),
      setAutoplay: autoplay => dispatch({ type: 'patch', patch: () => ({ autoplay }) }),
      setSleepTimer: request => dispatch({
        type: 'patch',
        patch: () => ({ sleepTimer: !request ? undefined : request.kind === 'time' ? { kind: 'time', endsAt: Date.now() + request.durationMs, durationMs: request.durationMs } : request }),
      }),
      playTracks: (tracks, startIndex = 0, context, options) => {
        if (options?.shuffle) dispatch({ type: 'patch', patch: () => ({ shuffle: true }) })
        restart({ type: 'play', tracks, startIndex, context: context ?? null })
      },
      enqueue: (tracks, placement) => dispatch({ type: 'enqueue', tracks, placement }),
      playEntry: entryId => restart({ type: 'playEntry', entryId }),
      removeEntry: entryId => dispatch({ type: 'patch', patch: state => ({ queue: state.queue.filter(item => item.entry.id !== entryId) }) }),
      moveEntry: (entryId, toIndex) => dispatch({ type: 'move', entryId, toIndex }),
      startRadio: () => tell({ message: 'Radio needs the server', tone: 'error' }),
      clearQueue: () => dispatch({ type: 'patch', patch: () => ({ queue: [] }) }),
      clearHistory: () => {
        dispatch({ type: 'patch', patch: () => ({ history: [] }) })
        tell({ message: 'History cleared', tone: 'info' })
      },
      transfer: deviceId => dispatch({ type: 'patch', patch: state => ({ activeDeviceId: deviceId, devices: state.devices.map(device => ({ ...device, isActive: device.id === deviceId })) }) }),
      detach: async () => {
        dispatch({ type: 'patch', patch: () => ({ detached: true }) })
        return { ok: true }
      },
      attach: async () => {
        dispatch({ type: 'patch', patch: () => ({ detached: false }) })
        return { ok: true }
      },
      prepareHere: () => {},
      jam: async () => ({ ok: false, error: 'unsupported' }),
      dismissJamInvite: () => {},
      renameDevice: () => {},
      tell,
    }
  }, [tell])

  // No audio here: what waits is what the fake server is still fetching.
  const player = useMemo<Player>(() => ({ state: { ...state, waiting: state.waiting || (state.playing && state.current?.entry.state === 'preparing') }, controls }), [state, controls])
  const nowPlaying = useNowPlayingStore(player.state)

  return (
    <ArtUrlContext value={fixtureArtUrl}>
      <LibraryContext value={library}>
        <OnDemandContext value={onDemand}>
          <PlayerControlsContext value={controls}>
            <PlayerContext value={player}>
              <NowPlayingContext value={nowPlaying}>
                <PositionContext value={positionClock.shown}>{children}</PositionContext>
              </NowPlayingContext>
            </PlayerContext>
          </PlayerControlsContext>
        </OnDemandContext>
      </LibraryContext>
    </ArtUrlContext>
  )
}

/** Everyone may request; nothing is fetched apart from what the fake session prepares. */
const onDemand: OnDemand = { viewer: { role: 'admin', canAcquire: true } }

function useFixtureLibrary(): LibraryActions {
  const [wanted, setWanted] = useState(() => new Map<string, boolean>())
  return useMemo(() => ({
    wantlistEnabled: true,
    isWanted: (id, fromServer = false) => wanted.get(id) ?? fromServer,
    // Nothing is kept: the heart's state comes from the fixture data.
    setSaved: async () => {},
    setWanted: async (target, value) => setWanted(map => new Map(map).set(target.type === 'album' ? target.album.id : target.track.id, value)),
    playlists: playlistSummaries,
    addToPlaylist: async () => true,
    // New playlists need the server.
    newPlaylist: () => {},
  }), [wanted])
}

type Clock = { session: PlayerState; position: number }
type ClockAction =
  | Action
  | { type: 'tick'; ms: number }
  | { type: 'seek'; positionMs: number }
  | { type: 'restart'; action: Action }

type Action =
  | { type: 'patch'; patch: (state: PlayerState) => Partial<PlayerState> }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'ready' }
  | { type: 'play'; tracks: TrackSummary[]; startIndex: number; context: PlayerState['context'] }
  | { type: 'enqueue'; tracks: TrackSummary[]; placement: 'next' | 'last' }
  | { type: 'playEntry'; entryId: string }
  | { type: 'move'; entryId: string; toIndex: number }

let entryCount = 0

function item(track: TrackSummary): QueueItem {
  const entry: QueueEntry = {
    id: `entry-${++entryCount}`,
    trackId: track.id,
    albumId: track.album?.id ?? null,
    durationMs: track.durationMs,
    state: track.availability === 'on_demand' ? 'preparing' : 'ready',
  }
  return { entry, track }
}

const playable = (tracks: TrackSummary[]) => tracks.filter(track => track.availability !== 'none')

function withCurrent(state: PlayerState, current: QueueItem | null): PlayerState {
  return { ...state, current, lyrics: current?.track.hasLyrics ? lyricsFor(current.track.id) : null }
}

function clock({ session, position }: Clock, action: ClockAction): Clock {
  switch (action.type) {
    case 'tick': {
      const duration = session.current?.entry.durationMs ?? 0
      if (position + action.ms < duration) return { session, position: position + action.ms }
      return { session: reduce(session, { type: 'next' }), position: 0 }
    }
    case 'seek':
      return { session, position: action.positionMs }
    case 'restart':
      return { session: reduce(session, action.action), position: 0 }
    case 'previous':
      // Like every player: restart the song unless it has only just begun.
      return { session: position < 3000 ? reduce(session, action) : session, position: 0 }
    default:
      return { session: reduce(session, action), position }
  }
}

function reduce(state: PlayerState, action: Action): PlayerState {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch(state) }
    case 'next': {
      const history = state.current ? [...state.history, state.current] : state.history
      if (state.repeat === 'one' && state.current) return state
      const [next, ...queue] = state.queue
      if (next) return withCurrent({ ...state, history, queue }, next)
      const [suggested, ...autoplayQueue] = state.autoplay ? state.autoplayQueue : []
      if (suggested) return withCurrent({ ...state, history, autoplayQueue }, suggested)
      return { ...withCurrent({ ...state, history }, null), playing: false }
    }
    case 'previous': {
      const previous = state.history.at(-1)
      if (!previous) return state
      const queue = state.current ? [state.current, ...state.queue] : state.queue
      return withCurrent({ ...state, history: state.history.slice(0, -1), queue }, previous)
    }
    case 'ready': {
      const ready = (entry: QueueItem): QueueItem => ({ ...entry, entry: { ...entry.entry, state: 'ready' } })
      return { ...state, current: state.current && ready(state.current), queue: state.queue.map(ready) }
    }
    case 'play': {
      const start = action.tracks[action.startIndex]
      const [current, ...queue] = playable([start, ...action.tracks.slice(action.startIndex + 1)]).map(item)
      const history = state.current ? [...state.history, state.current] : state.history
      return { ...withCurrent({ ...state, history, queue, context: action.context }, current ?? null), playing: Boolean(current) }
    }
    case 'enqueue': {
      const added = playable(action.tracks).map(item)
      return { ...state, queue: action.placement === 'next' ? [...added, ...state.queue] : [...state.queue, ...added] }
    }
    case 'playEntry': {
      const all = [...state.queue, ...state.autoplayQueue, ...state.history]
      const target = all.find(entry => entry.entry.id === action.entryId)
      if (!target) return state
      const history = state.current ? [...state.history, state.current] : state.history
      const index = state.queue.indexOf(target)
      return withCurrent({
        ...state,
        history: history.filter(entry => entry !== target),
        queue: index >= 0 ? state.queue.slice(index + 1) : state.queue,
        autoplayQueue: state.autoplayQueue.filter(entry => entry !== target),
        playing: true,
      }, target)
    }
    case 'move': {
      const from = state.queue.findIndex(entry => entry.entry.id === action.entryId)
      if (from < 0) return state
      const queue = [...state.queue]
      const [moved] = queue.splice(from, 1)
      queue.splice(action.toIndex, 0, moved)
      return { ...state, queue }
    }
  }
}

function init(initial?: Partial<PlayerState>): Clock {
  const queued = (slugs: string[]) => slugs.map(slug => item(track(slug)))
  const [current] = queued(['night-swimming'])
  const session: PlayerState = {
    ...withCurrent({
      current,
      playing: true,
      waiting: false,
      blocked: false,
      volume: 0.72,
      volumes: { [thisDeviceId]: 0.72, phone: 0.5 },
      shuffle: false,
      repeat: 'off',
      autoplay: true,
      context: { type: 'album', id: current.track.album?.id ?? null, title: 'Blue Hour' },
      queue: queued(['soft-signal', 'blue-in-the-dark', 'underwater-light', 'stay-until-morning', 'night-swimming-demo', 'amber', 'passing-glass']),
      history: queued(['riverside', 'static-bloom', 'copper-lines']),
      autoplayQueue: queued(['strange-seasons', 'violet-noise-song', 'paper-flowers', 'tail-lights']),
      devices,
      thisDeviceId,
      activeDeviceId: thisDeviceId,
      away: null,
      lyrics: null,
      detached: false,
      canDetach: true,
      canSetSleepTimer: true,
    }, current),
    ...initial,
  }
  return { session, position: 74_000 }
}
