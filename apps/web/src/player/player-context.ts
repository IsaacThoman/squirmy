import { type AwayDevice, deviceLabel, listedDevices, playingOnText, reconnectingText, type DeviceLabel, type SessionMoveResult, type SessionOutage } from '@squirmy/client-core'
import type { DeviceInfo, Lyrics, PlaybackContext, QueueEntry, RepeatMode, TrackSummary } from '@squirmy/contracts'
import { createContext, useContext, useSyncExternalStore } from 'react'
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
}

export type LyricsStatus = 'none' | 'loading' | 'failed' | 'ready'

export type PlayOptions = { shuffle?: boolean }
export type RadioSeed = { type: 'track' | 'artist'; id: string }

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
  /** Replaces the queue with the playable `tracks`, starting at `startIndex` (or shuffled). */
  playTracks: (tracks: TrackSummary[], startIndex?: number, context?: PlaybackContext, options?: PlayOptions) => void
  enqueue: (tracks: TrackSummary[], placement: 'next' | 'last') => void
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
  /** Gets this tab ready to take over what another device plays, so a transfer here starts sooner. For a pointer on "Play here". */
  prepareHere: () => void
  /** Takes this tab out of the shared session into one of its own. Resolves once the server has answered. */
  detach: () => Promise<SessionMoveResult>
  /** Puts this tab back in the shared session; `bringQueue` makes the shared session what this tab was playing. */
  attach: (options?: { bringQueue?: boolean }) => Promise<SessionMoveResult>
  /** Renames this browser in every device list; null goes back to the name from the user agent. */
  renameDevice: (name: string | null) => void
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

/**
 * The device that plays when it is not this one. One that dropped off the list during its
 * grace period is still that device, as it was last listed (`whereItPlays` says it is
 * reconnecting), or "another device" when this tab never saw it.
 */
export function playingElsewhere(state: Pick<PlayerState, 'activeDeviceId' | 'thisDeviceId' | 'devices' | 'away'>): DeviceInfo | undefined {
  const { activeDeviceId, thisDeviceId, devices, away } = state
  if (activeDeviceId === null || activeDeviceId === thisDeviceId) return undefined
  return devices.find(device => device.id === activeDeviceId)
    ?? (away?.id === activeDeviceId ? away.device : null)
    ?? { id: activeDeviceId, name: 'another device', kind: 'other', canPlay: false, isActive: true }
}

/**
 * Where the session's sound is, for the device `playingElsewhere` gave: "Reconnecting to …"
 * while the session waits for it to come back, else "Playing on …" or, paused, "Paused on …".
 */
export function whereItPlays(state: Pick<PlayerState, 'thisDeviceId' | 'devices' | 'away' | 'playing'>, device: DeviceInfo): string {
  if (state.away?.id === device.id) return reconnectingText(state.away.device ? labelDevice(state, device) : null)
  return playingOnText(labelDevice(state, device), state.playing)
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
