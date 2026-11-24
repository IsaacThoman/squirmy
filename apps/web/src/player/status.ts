import type { PlaybackNotice } from '@squirmy/client-core'

/**
 * `busy`: something is on its way (a radio starting). `error`: something the listener asked
 * for did not happen. `info`: playback went on without a song, or stopped, and says why.
 */
export type PlayerStatusTone = 'info' | 'error' | 'busy'

/** One line the player shows under the song: what just happened to playback, or what is on its way. */
export type PlayerStatus = PlaybackNotice & { tone: PlayerStatusTone; key: string }

/** How long a line about something that just happened stays. */
export const STATUS_EVENT_MS = 6000
/** How long a failure the listener caused stays: a little longer, so it is read. */
export const STATUS_ERROR_MS = 8000

/**
 * The player's status line: one line at a time, the latest. A line shown `for` a time goes
 * away by itself; one without stays until it is cleared by its key (a stop, until playback
 * resumes; a radio starting, until it has).
 */
export class StatusLine {
  private status: PlayerStatus | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()

  get = (): PlayerStatus | null => this.status

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  show(status: PlayerStatus, forMs?: number): void {
    clearTimeout(this.timer)
    this.set(status)
    if (forMs !== undefined) this.timer = setTimeout(() => this.clear(status.key), forMs)
  }

  /** Clears the line if it is the one with `key`, or whatever it is without one. */
  clear(key?: string): void {
    if (!this.status || (key !== undefined && this.status.key !== key)) return
    clearTimeout(this.timer)
    this.set(null)
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.listeners.clear()
  }

  private set(status: PlayerStatus | null): void {
    this.status = status
    for (const listener of [...this.listeners]) listener()
  }
}
