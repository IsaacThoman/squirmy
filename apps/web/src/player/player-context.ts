import type { DeviceInfo, Lyrics, PlaybackContext, QueueEntry, RepeatMode, TrackSummary } from '@squirmy/contracts'
import { createContext, useContext } from 'react'

/** A queue entry with the track it points at, hydrated for display. */
export type QueueItem = { entry: QueueEntry; track: TrackSummary }

/** What the UI shows of the user's playback session. */
export type PlayerState = {
  current: QueueItem | null
  playing: boolean
  volume: number
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
  lyrics: Lyrics | null
}

/** The commands the UI sends. They mirror `SessionCommand` in the contracts. */
export type PlayerControls = {
  togglePlay: () => void
  next: () => void
  previous: () => void
  seek: (positionMs: number) => void
  setVolume: (volume: number) => void
  setShuffle: (value: boolean) => void
  cycleRepeat: () => void
  setAutoplay: (value: boolean) => void
  playTracks: (tracks: TrackSummary[], startIndex?: number, context?: PlaybackContext) => void
  enqueue: (tracks: TrackSummary[], placement: 'next' | 'last') => void
  playEntry: (entryId: string) => void
  removeEntry: (entryId: string) => void
  moveEntry: (entryId: string, toIndex: number) => void
  clearHistory: () => void
  transfer: (deviceId: string) => void
}

export type Player = { state: PlayerState; controls: PlayerControls }

export const PlayerContext = createContext<Player | null>(null)
/** Position changes many times a second, so it has its own context and only the clocks re-render. */
export const PositionContext = createContext(0)

export function usePlayer() {
  const player = useContext(PlayerContext)
  if (!player) throw new Error('usePlayer needs a player provider')
  return player
}

export function usePosition() {
  return useContext(PositionContext)
}
