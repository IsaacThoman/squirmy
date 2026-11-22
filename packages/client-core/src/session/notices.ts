import type { EntryFailure, QueueEntry } from '@squirmy/contracts'
import type { SessionClientSnapshot, SessionOutage } from './client.js'

/** A notice for the listener: a short line, and an optional quieter one under it. */
export type PlaybackNotice = { message: string; detail?: string }

/**
 * The notice for a song playback skipped because it could not be had. A song the provider
 * does not have is a light one-liner, as any streaming app says it; a song that failed for
 * a reason the server does not know says it could not play. A failure from a server that
 * does not say why reads as the latter.
 */
export function skipNotice(title: string | null | undefined, failure: EntryFailure | undefined): PlaybackNotice {
  if (failure === 'unavailable') return { message: title ? `Skipped “${title}” — not available` : 'Skipped a song that isn’t available' }
  return { message: title ? `Couldn’t play “${title}”` : 'Couldn’t play a song', detail: 'Skipped.' }
}

/** The notice for a session that stopped on a failed entry, with the server's reason when it gave one. */
export function stopNotice(outage: Pick<SessionOutage, 'kind' | 'reason'> | null | undefined): PlaybackNotice {
  if (outage?.kind === 'exhausted') return { message: 'None of the remaining songs are available' }
  return { message: 'Can’t load music right now', detail: outage?.reason ? `${outage.reason} Playback is paused.` : 'Playback is paused.' }
}

/** A song to tell was skipped, and why the server said it failed (undefined: it did not say). */
export type SkippedSong = { entry: QueueEntry; failure: EntryFailure | undefined }

/** What to tell after one session change. */
export type PlaybackNotices = { skipped: SkippedSong[]; stopped: PlaybackNotice | null }

type Watched = Pick<SessionClientSnapshot, 'session' | 'queue' | 'connection' | 'outage'>

/**
 * Decides what a listener is told when on-demand songs cannot be had, the same on every
 * client. Feed it each snapshot of the session client (`update`); `failureOf` is the
 * client's `failureOf`.
 *
 * - A song that just failed and was current or next is `skipped`: one `skipNotice` each.
 *   Failures further down the queue are quiet; their rows turn gray and the session skips
 *   them when it gets there, so a provider outage does not become a stream of notices.
 * - When the session stops on a failed entry and the server says why (`outage`, set with
 *   the pause itself), that is one `stopNotice`, and nothing more is told per song until
 *   playback resumes.
 * - A session stopped on a failed entry without a word from the server reached the end of
 *   the queue on it: the song is `skipped` like any other.
 * - Offline, a snapshot may miss entries that are still there, so nothing is told.
 */
export class PlaybackNoticeWatcher {
  private previous: Watched | null = null
  /** A stop was told: songs are quiet until playback resumes. */
  private stopped = false

  constructor(private readonly failureOf: (trackId: string) => EntryFailure | undefined) {}

  update(snapshot: Watched): PlaybackNotices {
    const before = this.previous
    this.previous = snapshot
    const { session, outage } = snapshot
    // Playing again is the listener asking for more: a failure after it is told anew.
    if (session.playing) this.stopped = false
    if (!before || snapshot.connection !== 'online') return { skipped: [], stopped: null }

    if (outage && outage !== before.outage) {
      const tell = !this.stopped
      this.stopped = true
      return { skipped: [], stopped: tell ? stopNotice(outage) : null }
    }
    if (this.stopped) return { skipped: [], stopped: null }

    const entries = entriesOf(snapshot)
    const find = (id: string) => entries.find(entry => entry.id === id)
    const failed: QueueEntry[] = []
    const current = before.session.current
    if (current?.state === 'preparing') {
      // The session skips a current entry that failed and keeps no trace of it (one skipped
      // by hand or replaced goes to the history). One still current, failed, ended the queue.
      const now = find(current.id)
      if (!now) failed.push(current)
      else if (now.state === 'failed' && session.current?.id === now.id) failed.push(now)
    }
    const next = before.queue.queue[0] ?? before.queue.autoplayQueue[0]
    if (next && next.state !== 'failed') {
      const now = find(next.id)
      if (now?.state === 'failed' && session.current?.id !== now.id) failed.push(now)
    }
    return { skipped: failed.map(entry => ({ entry, failure: this.failureOf(entry.trackId) })), stopped: null }
  }
}

function entriesOf({ session, queue }: Pick<Watched, 'session' | 'queue'>): QueueEntry[] {
  return [session.current, ...queue.queue, ...queue.autoplayQueue, ...queue.history].filter((entry): entry is QueueEntry => entry !== null)
}
