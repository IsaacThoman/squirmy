import type { EntryFailure, QueueEntry } from '@squirmy/contracts'
import type { SessionClientSnapshot, SessionOutage } from './client.js'

/** A notice for the listener: a short line, and an optional quieter one under it. */
export type PlaybackNotice = { message: string; detail?: string }

/**
 * The notice for a song playback skipped because it failed for a reason the server does
 * not know (or did not say). A song the provider does not have is told by
 * `unavailableNotice` instead. `held`: playback stays on the song, paused (the listener
 * picked it, or the queue ended on it), so it says the song could not play, not that it
 * was skipped.
 */
export function skipNotice(title: string | null | undefined, failure?: EntryFailure, held = false): PlaybackNotice {
  // Playback stayed on it (it was picked, or the queue ended on it): nothing was skipped.
  if (held) return { message: title ? `Couldn’t play “${title}”` : 'Couldn’t play this song', ...(failure === 'unavailable' && { detail: 'It isn’t available.' }) }
  if (failure === 'unavailable') return unavailableNotice({ count: 1 }, title)
  return { message: title ? `Couldn’t play “${title}”` : 'Couldn’t play a song', detail: 'Skipped.' }
}

/**
 * The one light notice for a run of songs skipped because the provider does not have them:
 * named while it is one song, counted once there are more. Each skip in the run replaces
 * the notice rather than adding another.
 */
export function unavailableNotice(run: Pick<UnavailableRun, 'count'>, title: string | null | undefined): PlaybackNotice {
  if (run.count > 1) return { message: `Skipped ${run.count} songs — not available` }
  return { message: title ? `Skipped “${title}” — not available` : 'Skipped a song that isn’t available' }
}

/** The notice for a session that stopped on a failed entry, with the server's reason when it gave one. */
export function stopNotice(outage: Pick<SessionOutage, 'kind' | 'reason'> | null | undefined): PlaybackNotice {
  if (outage?.kind === 'exhausted') return { message: 'None of the remaining songs are available' }
  if (outage?.kind === 'unavailable') return { message: 'Several songs in a row aren’t available', detail: 'Playback is paused.' }
  return { message: 'Can’t load music right now', detail: outage?.reason ? `${outage.reason} Playback is paused.` : 'Playback is paused.' }
}

/**
 * Whether a failed entry reads as unavailable ("Not available", gray). The one playback
 * paused on in a provider outage does not: the provider failed, not the song, and playing
 * again asks for it again.
 */
export function readsUnavailable(entry: Pick<QueueEntry, 'state' | 'trackId'>, outage: Pick<SessionOutage, 'kind' | 'trackId'> | null | undefined): boolean {
  return entry.state === 'failed' && !(outage?.kind === 'outage' && outage.trackId === entry.trackId)
}

/**
 * A song skipped for a reason other than the provider not having it, and why (undefined:
 * the server did not say). `held`: it failed as the current song and playback stayed on it
 * (see `skipNotice`), whatever the reason.
 */
export type SkippedSong = { entry: QueueEntry; failure: EntryFailure | undefined; held?: boolean }

/** Songs skipped in a row as not available since one last played. `entry`: the first, named while it is the only one. */
export type UnavailableRun = { count: number; entry: QueueEntry }

/**
 * What to tell after one session change. `skipped`: a notice each. `unavailable`: the run
 * grew, so its one notice (`unavailableNotice`) is shown again in place of the last.
 * `stopped`: playback stopped, said once (`stopNotice`); it may replace the run's notice.
 */
export type PlaybackNotices = { skipped: SkippedSong[]; unavailable: UnavailableRun | null; stopped: PlaybackNotice | null }

type Watched = Pick<SessionClientSnapshot, 'session' | 'queue' | 'connection' | 'outage'>

const quiet = (): PlaybackNotices => ({ skipped: [], unavailable: null, stopped: null })

/**
 * Decides what a listener is told when on-demand songs cannot be had, the same on every
 * client. Feed it each snapshot of the session client (`update`); `failureOf` is the
 * client's `failureOf`.
 *
 * - A song is told when it is skipped: the current one as it fails, one further on as
 *   playback reaches it and passes over it. Before its turn it is still in Up next, gray,
 *   and a notice that it was skipped would be early. One the provider does not
 *   have joins the run of such songs since a song last played, which is one notice that
 *   counts them, together with the failed songs the session passed over to get there. Any
 *   other failure is a notice of its own (`skipNotice`).
 * - When the session stops on a failed entry and the server says why (`outage`, set with
 *   the pause itself), that is one `stopNotice`, and nothing more is told per song until
 *   playback resumes.
 * - A session stopped on a failed entry without a word from the server stayed on it: the
 *   listener picked that song, or the queue ended on it. It is told as a song that could
 *   not play (`held`), not as one skipped.
 * - Offline, a snapshot may miss entries that are still there, so nothing is told.
 */
export class PlaybackNoticeWatcher {
  private previous: Watched | null = null
  /** A stop was told: songs are quiet until playback resumes. */
  private stopped = false
  /** The current entry last seen ready: a new one means a song played, which ends a run. */
  private played: string | null = null
  private run: { tracks: Set<string>; entry: QueueEntry } | null = null

  constructor(private readonly failureOf: (trackId: string) => EntryFailure | undefined) {}

  update(snapshot: Watched): PlaybackNotices {
    const before = this.previous
    this.previous = snapshot
    const { session, outage } = snapshot
    // Playing again is the listener asking for more: a failure after it is told anew.
    if (session.playing) this.stopped = false
    if (session.current?.state === 'ready' && session.current.id !== this.played) {
      this.played = session.current.id
      this.run = null
    }
    if (!before || snapshot.connection !== 'online') return quiet()

    if (outage && outage !== before.outage) {
      const tell = !this.stopped
      this.stopped = true
      this.run = null
      return { ...quiet(), stopped: tell ? stopNotice(outage) : null }
    }
    if (this.stopped) return quiet()

    const entries = entriesOf(snapshot)
    const find = (id: string) => entries.find(entry => entry.id === id)
    const failed: QueueEntry[] = []
    /** The current entry, failed, that playback stayed on. */
    let held: QueueEntry | null = null
    /** Failed entries the session passed over to its new current one: songs skipped, but no one was waiting on them. */
    const passed: QueueEntry[] = []
    const current = before.session.current
    if (current?.state === 'preparing') {
      // The session skips a current entry that failed and keeps no trace of it (one skipped
      // by hand or replaced goes to the history), nor of the failed entries it passed over
      // to its new current one. One still current, failed, ended the queue.
      const now = find(current.id)
      if (!now) {
        failed.push(current)
        const ahead = [...before.queue.queue, ...before.queue.autoplayQueue]
        const to = ahead.findIndex(entry => entry.id === session.current?.id)
        passed.push(...ahead.slice(0, Math.max(0, to)).filter(entry => entry.state === 'failed' && !find(entry.id)))
      } else if (now.state === 'failed' && session.current?.id === now.id) held = now
    }
    // A song further on that failed is told at its turn, when the session passes over it,
    // not when it fails: until then it is still in Up next, where its row is gray. Only a
    // move that passed nothing but failed songs counts: one that jumped past songs that
    // could play was the listener's choice.
    const reached = session.current
    if (!failed.length && !held && reached && current?.id !== reached.id) {
      const ahead = [...before.queue.queue, ...before.queue.autoplayQueue]
      const over = ahead.slice(0, Math.max(0, ahead.findIndex(entry => entry.id === reached.id)))
      if (over.every(entry => entry.state === 'failed' && !find(entry.id))) failed.push(...over)
    }

    const skipped: SkippedSong[] = held ? [{ entry: held, failure: this.failureOf(held.trackId), held: true }] : []
    let grew = false
    for (const entry of [...failed, ...passed]) {
      const failure = this.failureOf(entry.trackId)
      if (failure !== 'unavailable') {
        if (failed.includes(entry)) skipped.push({ entry, failure })
        continue
      }
      this.run ??= { tracks: new Set(), entry }
      if (this.run.tracks.has(entry.trackId)) continue
      this.run.tracks.add(entry.trackId)
      grew = true
    }
    const unavailable = grew && this.run ? { count: this.run.tracks.size, entry: this.run.entry } : null
    return { skipped, unavailable, stopped: null }
  }
}

function entriesOf({ session, queue }: Pick<Watched, 'session' | 'queue'>): QueueEntry[] {
  return [session.current, ...queue.queue, ...queue.autoplayQueue, ...queue.history].filter((entry): entry is QueueEntry => entry !== null)
}
