/**
 * What held up an entry the session plays here: its stream address being resolved (or not
 * loaded at all), the engine loading it, or the engine waiting for data mid-song.
 */
export type StallState = 'resolving' | 'loading' | 'buffering'

/** One look at the current entry, taken while this device should be playing it. */
export type StallReading = {
  entryId: string
  trackId: string
  /** What it waits on, or null when it does not wait. */
  waiting: StallState | null
  /** The engine plays it. */
  playing: boolean
  /** Giving up skips the song, which is right only while the server can be reached. */
  canGiveUp: boolean
}

export type StallAction =
  /** Reload the entry: a fresh stream address, a new player, the same position. `attempt` counts from 1. */
  | { type: 'recover'; state: StallState; attempt: number; stuckMs: number }
  /** It plays again after `attempts` reloads. */
  | { type: 'recovered'; state: StallState; attempts: number; stuckMs: number }
  /** Reloading did not help: move on, as for a track that failed. */
  | { type: 'giveUp'; state: StallState; attempts: number; stuckMs: number }

/**
 * How long the entry may wait before each reload, and the last before giving up: 6 s, then
 * 8 s, then 12 s after each reload, then 16 s more. A stream that is ready starts within a
 * second or two even over a slow network, and AVPlayer and browsers recover short stalls
 * by themselves well inside 6 s; a song the server is still fetching is `preparing` and
 * never watched. The waits grow so a slow network gets more time on each try, and the
 * user hears silence for at most about 40 s before the song is skipped.
 */
export const STALL_WAITS_MS = [6_000, 8_000, 12_000, 16_000] as const
/** Playing this long after a stall counts as recovered for good: a new stall starts over at the first wait. */
export const STALL_SETTLED_MS = 10_000

type Watch = {
  entryId: string
  state: StallState
  /** When the current wait began; null while it plays. */
  since: number | null
  /** The last reload, or the start of the wait. */
  lastAction: number
  attempts: number
  playingSince: number | null
  toldRecovered: boolean
  gaveUp: boolean
}

/**
 * Notices an entry that should be playing and is not, and says when to reload it and when
 * to give up. It holds no timers: `check` is called every second or so with a fresh
 * reading. Reloads of one entry escalate until it has played for `STALL_SETTLED_MS`, so
 * a stream that keeps breaking after a few seconds is given up on too.
 */
export class StallWatchdog {
  private watch: Watch | null = null

  constructor(private readonly waits: readonly number[] = STALL_WAITS_MS, private readonly settledMs = STALL_SETTLED_MS) {}

  /** `reading` is null while nothing should be playing here; that ends any watch. */
  check(reading: StallReading | null, now: number): StallAction | null {
    if (!reading) {
      this.watch = null
      return null
    }
    let watch = this.watch
    if (!watch || watch.entryId !== reading.entryId) {
      watch = { entryId: reading.entryId, state: 'loading', since: null, lastAction: now, attempts: 0, playingSince: null, toldRecovered: false, gaveUp: false }
      this.watch = watch
    }
    if (!reading.waiting) {
      if (!reading.playing) {
        // Paused, ended or failed: not a stall, and nothing to recover from.
        watch.since = null
        return null
      }
      let action: StallAction | null = null
      if (watch.since !== null && watch.attempts > 0 && !watch.toldRecovered) {
        watch.toldRecovered = true
        action = { type: 'recovered', state: watch.state, attempts: watch.attempts, stuckMs: now - watch.since }
      }
      watch.since = null
      watch.playingSince ??= now
      if (now - watch.playingSince >= this.settledMs) {
        watch.attempts = 0
        watch.toldRecovered = false
      }
      return action
    }
    watch.playingSince = null
    watch.state = reading.waiting
    if (watch.since === null) {
      watch.since = now
      watch.lastAction = now
      watch.toldRecovered = false
    }
    if (watch.gaveUp) return null
    const last = this.waits.length - 1
    if (now - watch.lastAction < this.waits[Math.min(watch.attempts, last)]!) return null
    watch.lastAction = now
    const stuckMs = now - watch.since
    if (watch.attempts >= last) {
      if (reading.canGiveUp) {
        watch.gaveUp = true
        return { type: 'giveUp', state: watch.state, attempts: watch.attempts, stuckMs }
      }
      // Offline nothing is skipped: the song may play from the phone's files or once the connection is back.
      return { type: 'recover', state: watch.state, attempt: watch.attempts, stuckMs }
    }
    watch.attempts += 1
    return { type: 'recover', state: watch.state, attempt: watch.attempts, stuckMs }
  }
}

/** Reloading a song that would not start did not help; the client moves on as for a failed load. */
export class PlaybackStallError extends Error {
  constructor(readonly state: StallState, readonly attempts: number, readonly stuckMs: number) {
    super(`Playback did not start after ${attempts} ${attempts === 1 ? 'reload' : 'reloads'}`)
    this.name = 'PlaybackStallError'
  }
}
