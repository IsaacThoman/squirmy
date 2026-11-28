import { type AwayDevice, deviceLabel, listedDevices, readsUnavailable, type DeviceLabel, type JamResult, type SessionMoveResult, type SessionOutage } from '@squirmy/client-core'
import type { DeviceInfo, JamInfo, JamRequest, Lyrics, PlaybackContext, QueueEntry, RepeatMode, SignalPath, SleepTimer, SleepTimerRequest, TrackSummary } from '@squirmy/contracts'
import { createContext, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { CurrentUserContext } from '@/auth/session'
import type { PlayerStatus } from './status'

/** A queue entry with the track it points at, hydrated for display. */
export type QueueItem = { entry: QueueEntry; track: TrackSummary }

/** What the UI shows of the user's playback session. */
export type PlayerState = {
  current: QueueItem | null
  /** Playback is meant to go on: the session plays, and the browser is not holding this tab's audio back. */
  playing: boolean
  /**
   * Playing, and nothing can be heard yet: the song is being fetched, its stream is loading or
   * buffering, or the device that plays has stalled. It looks like buffering, a spinner.
   */
  waiting: boolean
  /** This tab should play and the browser held its audio back; play (a click) starts it. */
  blocked: boolean
  /** The volume of the device that plays: this one, or the one it controls. */
  volume: number
  /** Per-device volumes, keyed by device id. */
  volumes: Record<string, number>
  shuffle: boolean
  repeat: RepeatMode
  autoplay: boolean
  context: PlaybackContext | null
  queue: QueueItem[]
  history: QueueItem[]
  autoplayQueue: QueueItem[]
  devices: DeviceInfo[]
  thisDeviceId: string
  activeDeviceId: string | null
  /** The active device while it is gone and the session waits for it to come back; see `SessionClientSnapshot.away`. */
  away: AwayDevice | null
  lyrics: Lyrics | null
  /**
   * Where the current track's lyrics are: `none` when it has none, else on their way, failed or
   * there. Left out by fixtures, which then read as `ready` with lyrics and `none` without.
   */
  lyricsStatus?: LyricsStatus
  /** Asks for the lyrics again after they failed. */
  retryLyrics?: () => void
  /** This tab plays on its own: everything above is its own session, not the one the user's other devices share. */
  detached: boolean
  /** `detach` can work: this tab plays and the server supports it. */
  canDetach: boolean
  /** The line under the song: what just happened to playback, or what is on its way. Left out by fixtures. */
  status?: PlayerStatus | null
  /** The radio being started, while it is. Left out by fixtures. */
  radioPending?: RadioSeed | null
  /** Why playback stopped on a failed current entry, when the server said (client-core's `SessionOutage`). */
  outage?: SessionOutage | null
  /** What the playing device plays, as it plays it (client-core's `SessionClientSnapshot.signal`). Left out by fixtures. */
  signal?: SignalPath | null
  /** The session's sleep timer, while one is set: it stops whichever device plays. */
  sleepTimer?: SleepTimer
  /** The server takes a sleep timer, so the player offers one. */
  canSetSleepTimer?: boolean
  /** The server's clock, which a sleep timer's end is told in. Left out by fixtures: this browser's. */
  serverNow?: () => number
  /** The jam this session hosts or follows, while it does (see "Listen together" in the session contract). */
  jam?: JamInfo
  /** The server can listen together, so the player offers it. */
  canJam?: boolean
  /** Someone asked this user to join their jam, until it is answered or dismissed. */
  jamInvite?: JamInvite | null
}

export type JamInvite = { jamId: string; hostName: string }

export type LyricsStatus = 'none' | 'loading' | 'failed' | 'ready'

/**
 * `collection`: the listener played the list as a whole (a header's or card's Play), not one of
 * its songs by name, so a first song that cannot be had is passed over. Shuffle always is.
 */
export type PlayOptions = { shuffle?: boolean; collection?: boolean }
/** `sonic`: a radio of songs that sound like the track (`POST /radio/sonic/:id`). */
export type RadioSeed = { type: 'track' | 'artist' | 'sonic'; id: string }

/** The commands the UI sends. They mirror `SessionCommand` in the contracts. */
export type PlayerControls = {
  togglePlay: () => void
  next: () => void
  previous: () => void
  seek: (positionMs: number) => void
  /** Sets a device's volume; by default the device that plays. */
  setVolume: (volume: number, deviceId?: string) => void
  setShuffle: (value: boolean) => void
  cycleRepeat: () => void
  setAutoplay: (value: boolean) => void
  /** Sets the session's sleep timer, or turns it off with null. */
  setSleepTimer: (timer: SleepTimerRequest | null) => void
  /** Replaces the queue with the playable `tracks`, starting at `startIndex` (or shuffled). */
  playTracks: (tracks: TrackSummary[], startIndex?: number, context?: PlaybackContext, options?: PlayOptions) => void
  /** Adds to Up next: before it, after it, or at `toIndex` of the entries it shows (a drop into the queue). */
  enqueue: (tracks: TrackSummary[], placement: 'next' | 'last', toIndex?: number) => void
  startRadio: (seed: RadioSeed) => void
  /** Plays an entry of the queue, the autoplay queue or the history. */
  playEntry: (entryId: string) => void
  removeEntry: (entryId: string) => void
  /** `toIndex` counts the entries shown in the queue. */
  moveEntry: (entryId: string, toIndex: number) => void
  clearQueue: () => void
  /** Clears the history at once; the queue asks first. */
  clearHistory: () => void
  transfer: (deviceId: string) => void
  /** Gets this tab ready to take over what another device plays, so a transfer here starts sooner. For this tab’s row in the device picker. */
  prepareHere: () => void
  /** Takes this tab out of the shared session into one of its own. Resolves once the server has answered. */
  detach: () => Promise<SessionMoveResult>
  /** Puts this tab back in the shared session; `bringQueue` makes the shared session what this tab was playing. */
  attach: (options?: { bringQueue?: boolean }) => Promise<SessionMoveResult>
  /** Starts, joins, leaves, ends or changes a jam. Resolves once the server has answered. */
  jam: (request: JamRequest) => Promise<JamResult>
  /** Forgets the invite shown, answered or not. */
  dismissJamInvite: () => void
  /** Renames this browser in every device list; null goes back to the name from the user agent. */
  renameDevice: (name: string | null) => void
  /**
   * Loads songs again from the server the next time they start (all of them, or one track's),
   * for when the copy they play from changed: the user picked another version. What plays now goes on.
   */
  forgetPlayback: (trackId?: string) => void
  /**
   * Says something on the player's status line, under the song: a playback command that failed
   * (an album that did not load to play, a device that could not be moved to), or what one
   * changed out of sight. It goes away by itself, an error a little later.
   */
  tell: (line: StatusMessage) => void
}

/** A line for `tell`: `info` for what happened, `error` for what the listener asked for and did not happen. */
export type StatusMessage = { message: string; detail?: string; tone: 'info' | 'error' }

export type Player = { state: PlayerState; controls: PlayerControls }

export const PlayerContext = createContext<Player | null>(null)

/** The session's jam, apart from the rest of the session, so queue rows can name who added a song without rendering on every update. */
export const JamContext = createContext<JamInfo | undefined>(undefined)

/** The controls alone. They keep one identity, so readers that only send commands skip every session update. */
export const PlayerControlsContext = createContext<PlayerControls | null>(null)

/** The radio being started, while it is: a value of its own, so the control that started it re-renders only when it changes. */
export const RadioPendingContext = createContext<RadioSeed | null>(null)

/** Whether a radio is starting from `seed`: its control shows that it is on its way. */
export function useRadioStarting(seed: RadioSeed): boolean {
  const pending = useContext(RadioPendingContext)
  return pending?.type === seed.type && pending.id === seed.id
}

/**
 * How `device` is named here: "This browser", "Another tab" for this browser's other tabs,
 * else its own name, with a hint when two listed devices share it.
 */
export function labelDevice(state: Pick<PlayerState, 'thisDeviceId' | 'devices'>, device: DeviceInfo): DeviceLabel {
  return deviceLabel(device, listedDevices(state.devices, state.thisDeviceId), state.thisDeviceId, 'This browser')
}

/** Whether only the jam's host controls playback here: this user follows someone else's jam. */
export function hostControls(state: Pick<PlayerState, 'jam'>): boolean {
  return state.jam?.role === 'member'
}

/**
 * What this listener may do to what plays, under the jam's rules (`memberCommandRoute` and the
 * server's): everything, unless they follow someone's jam. There the host controls playback; a
 * member adds songs while the jam's queue policy lets everyone, and takes out only what they
 * added. Volume and the device that plays are each listener's own, so they are not here.
 */
export type JamRights = {
  /** Play, pause, seek, skip, shuffle, repeat, Autoplay, a radio, a queued song picked to play, clearing the queue or history. */
  transport: boolean
  /** Adding songs to Up next. */
  add: boolean
  /** Moving songs in Up next. */
  reorder: boolean
  /** Taking this entry out of the queue. */
  remove: (entry: Pick<QueueEntry, 'addedBy'>) => boolean
}

const allRights: JamRights = { transport: true, add: true, reorder: true, remove: () => true }

export function jamRights(jam: JamInfo | undefined, userId: string | null): JamRights {
  if (jam?.role !== 'member') return allRights
  const add = jam.queuePolicy === 'everyone'
  return { transport: false, add, reorder: false, remove: entry => add && userId !== null && entry.addedBy === userId }
}

/** `jamRights` of this user's session. Reads the jam alone, so it renders again only when the jam changes. */
export function useJamRights(): JamRights {
  const jam = useContext(JamContext)
  // Null in a fixture that renders the player without signing in, where there is no jam either.
  const userId = useContext(CurrentUserContext)?.id ?? null
  return useMemo(() => jamRights(jam, userId), [jam, userId])
}

/** Whether this tab controls playback on another device, including while it reconnects. */
export function playingElsewhere({ activeDeviceId, thisDeviceId }: Pick<PlayerState, 'activeDeviceId' | 'thisDeviceId'>): boolean {
  return activeDeviceId !== null && activeDeviceId !== thisDeviceId
}

export function usePlayer() {
  const player = useContext(PlayerContext)
  if (!player) throw new Error('usePlayer needs a player provider')
  return player
}

/** The player's commands, for components that show nothing of the session: they do not re-render as it changes. */
export function usePlayerControls() {
  const controls = useContext(PlayerControlsContext)
  if (!controls) throw new Error('usePlayerControls needs a player provider')
  return controls
}

/**
 * The playback position, kept apart from the session so that only the clocks re-render.
 * `read` asks the session client (or the fixtures) where playback is; while playing, the
 * clock reads it on every animation frame and tells subscribers when it moved.
 */
export class PositionClock {
  private position: number
  private frame: number | null = null
  private readonly listeners = new Set<() => void>()
  private readonly read: () => number

  constructor(read: () => number) {
    this.read = read
    this.position = read()
  }

  get = (): number => this.position

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Reads the position now, for changes that happen while the clock is not running. */
  sync = (): void => {
    const position = this.read()
    if (position === this.position) return
    this.position = position
    for (const listener of [...this.listeners]) listener()
  }

  /** Runs the clock on animation frames while `running`. */
  setRunning(running: boolean): void {
    if (running === (this.frame !== null)) return
    if (!running) {
      cancelAnimationFrame(this.frame!)
      this.frame = null
      return
    }
    const tick = () => {
      this.sync()
      this.frame = requestAnimationFrame(tick)
    }
    this.frame = requestAnimationFrame(tick)
  }
}

export const PositionContext = createContext(new PositionClock(() => 0))

/**
 * The session's current track as a song row shows it. `loading`: its music is on its way (a
 * fetch looks like buffering). `failed`: its music could not be had, so that row is unavailable
 * rather than current, before the track's own availability reaches the list.
 */
export type NowPlaying = { trackId: string; playing: boolean; loading: boolean; failed?: boolean }

/** What one row shows of the session: nothing, unless it is the current track. */
export type TrackPlayback = 'playing' | 'paused' | 'loading' | 'failed' | null

const sameNowPlaying = (a: NowPlaying | null, b: NowPlaying | null) => a === b || (a !== null && b !== null
  && a.trackId === b.trackId && a.playing === b.playing && a.loading === b.loading && Boolean(a.failed) === Boolean(b.failed))

/**
 * The current track, kept apart from the session as the position is, so that song rows render
 * only when what they show changes: a volume, a seek or a queue change renders none, and a new
 * current track renders the row it leaves and the row it reaches.
 */
export class NowPlayingStore {
  private value: NowPlaying | null
  private readonly listeners = new Set<() => void>()

  constructor(value: NowPlaying | null = null) {
    this.value = value
  }

  get = (): NowPlaying | null => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(value: NowPlaying | null): void {
    if (sameNowPlaying(value, this.value)) return
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
}

/** What the rows show of `state`. */
export function nowPlayingOf(state: Pick<PlayerState, 'current' | 'playing' | 'waiting' | 'outage'>): NowPlaying | null {
  return state.current && {
    trackId: state.current.track.id,
    playing: state.playing,
    loading: state.waiting,
    failed: readsUnavailable(state.current.entry, state.outage),
  }
}

/**
 * A `NowPlayingStore` that follows `state`. It is told after the provider's render commits, so
 * the rows that change render in the same frame, after it.
 */
export function useNowPlayingStore(state: Pick<PlayerState, 'current' | 'playing' | 'waiting' | 'outage'>): NowPlayingStore {
  const [store] = useState(() => new NowPlayingStore(nowPlayingOf(state)))
  const value = nowPlayingOf(state)
  useLayoutEffect(() => store.set(value))
  return store
}

export const NowPlayingContext = createContext(new NowPlayingStore())

function playbackOf(now: NowPlaying | null, trackId: string): TrackPlayback {
  if (now?.trackId !== trackId) return null
  if (now.failed) return 'failed'
  return now.loading ? 'loading' : now.playing ? 'playing' : 'paused'
}

/** Whether `trackId` is the current track, and how it plays. The caller re-renders only when that changes. */
export function useTrackPlayback(trackId: string): TrackPlayback {
  const store = useContext(NowPlayingContext)
  return useSyncExternalStore(store.subscribe, () => playbackOf(store.get(), trackId))
}

/**
 * The position in milliseconds, or what `select` makes of it. The caller re-renders only
 * when that value changes: pass a selector (the lyric line, the second shown) to re-render
 * less than every frame.
 */
export function usePosition(): number
export function usePosition<T>(select: (positionMs: number) => T): T
export function usePosition<T>(select?: (positionMs: number) => T): T | number {
  const clock = useContext(PositionContext)
  return useSyncExternalStore(clock.subscribe, () => (select ? select(clock.get()) : clock.get()))
}
