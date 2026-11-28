import { emitWebhook } from '../integrations/webhooks.js'
import { positionAt, type Session } from '@squirmy/client-core'
import { PlaybackContext, queryKeys } from '@squirmy/contracts'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { plays } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { invalidate } from '../../realtime/index.js'
import { explicitAllowed } from '../catalog/explicit.js'
import { alignedTrackSummaries } from '../catalog/summaries.js'

/**
 * Play accounting. A play opens when an entry is current and running on the active
 * device, and closes when the current entry changes or stops at its end. Listened time
 * is the session's own position arithmetic between changes, so pauses, stalls and seeks
 * add nothing and a track that runs past its end adds nothing after it.
 */

/** Closed plays shorter than this are skips. */
const SKIP_MS = 5000

export function isSkipped(msPlayed: number): boolean {
  return msPlayed < SKIP_MS
}
/** A play counts as completed after half the track or this much, whichever is less. */
const COMPLETE_CAP_MS = 4 * 60_000

/**
 * A play still being listened to. It is stored with the session, so a listen that spans a
 * restart stays one play; `id` is its row's id, so a write at shutdown and the final one
 * after the restart are the same row.
 */
export const OpenPlay = z.object({
  id: z.string(),
  entryId: z.string(),
  recordingId: z.string(),
  albumId: z.string().nullable(),
  context: PlaybackContext.pick({ type: true, id: true }).nullish(),
  deviceId: z.string().nullable(),
  durationMs: z.number(),
  startedAt: z.number(),
  msPlayed: z.number(),
  /** Server time up to which `msPlayed` is counted. */
  countedTo: z.number(),
})
export type OpenPlay = z.infer<typeof OpenPlay>

type PlayStartListener = (userId: string, play: Readonly<OpenPlay>) => void
const playStartListeners = new Set<PlayStartListener>()

/**
 * Calls `listener` each time a play opens: an entry starts running on the user's active
 * device. Called synchronously; it must not throw. Returns a function that unsubscribes.
 */
export function onPlayStart(listener: PlayStartListener): () => void {
  playStartListeners.add(listener)
  return () => void playStartListeners.delete(listener)
}

/** Tells the `onPlayStart` listeners that `play` just opened. */
export function notifyPlayStart(userId: string, play: OpenPlay): void {
  for (const listener of playStartListeners) listener(userId, play)
}

/** Time advances for the current entry: a device is outputting it and nothing holds it up. */
function isRunning(session: Session): boolean {
  return session.activeDeviceId !== null && session.playing && !session.stalled && session.current?.state === 'ready'
}

function stoppedAtEnd(session: Session): boolean {
  const current = session.current
  return !session.playing && current !== null && current.durationMs > 0 && session.positionMs >= current.durationMs
}

/**
 * Advances the open play across a session change from `previous` to `next` at `now`.
 * Returns the play that is open afterwards and the one that closed, if any.
 */
export function followPlay(play: OpenPlay | null, previous: Session, next: Session, now: number): { open: OpenPlay | null; closed: OpenPlay | null } {
  let closed: OpenPlay | null = null
  if (play) {
    countUntil(play, previous, now)
    if (next.current?.id !== play.entryId || stoppedAtEnd(next)) {
      closed = play
      play = null
    }
  }
  if (!play && isRunning(next)) {
    const entry = next.current!
    play = {
      id: newId(),
      entryId: entry.id,
      recordingId: entry.trackId,
      albumId: entry.albumId,
      context: next.context && { type: next.context.type, id: next.context.id },
      deviceId: next.activeDeviceId,
      durationMs: entry.durationMs,
      startedAt: now,
      msPlayed: 0,
      countedTo: now,
    }
  }
  return { open: play, closed }
}

/** Adds the time `session` (unchanged since `play.countedTo`) ran the play's entry up to `now`. */
export function countUntil(play: OpenPlay, session: Session, now: number): void {
  if (now <= play.countedTo) return
  if (isRunning(session) && session.current!.id === play.entryId) {
    play.msPlayed += Math.max(0, positionAt(session, now) - positionAt(session, play.countedTo))
  }
  play.countedTo = now
}

export function isCompleted(msPlayed: number, durationMs: number): boolean {
  return msPlayed >= Math.min(durationMs > 0 ? durationMs / 2 : COMPLETE_CAP_MS, COMPLETE_CAP_MS)
}

/**
 * Writes a closed play, or saves progress at shutdown. A still-open play below the
 * history threshold may resume after restart, so it is too soon to record a skip.
 *
 * The play is filed under the recording and album the track resolves to now, not the ids
 * of its queue entry: an on-demand track queued from a catalog stub album lands on the
 * album its fetched file was filed under, and identification may merge the recording
 * while it plays. The entry's ids would leave plays on empty stubs and merged-away rows.
 *
 * A song the user may not hear (explicit, with explicit content off) is not written: their
 * device sat it out, as a member of a jam does when the host plays one.
 */
export async function savePlay(userId: string, play: OpenPlay, { closed = true } = {}): Promise<void> {
  const skipped = isSkipped(play.msPlayed)
  if (skipped && !closed) return
  const msPlayed = Math.round(play.msPlayed)
  const [track] = await alignedTrackSummaries(userId, [{ id: play.recordingId }])
  if (track?.explicit === true && !(await explicitAllowed(userId))) return
  await insertPlay({
    id: play.id,
    userId,
    recordingId: track?.id ?? play.recordingId,
    albumId: track ? track.album?.id ?? null : play.albumId,
    contextType: play.context?.type ?? null,
    contextId: play.context?.id ?? null,
    deviceId: play.deviceId,
    client: 'app',
    startedAt: new Date(play.startedAt),
    msPlayed,
    completed: !skipped && isCompleted(msPlayed, play.durationMs),
    skipped,
  })
}

/** Inserts a play, or updates the row with the same `id` (a play written again after a restart). */
export async function insertPlay({ id = newId(), ...values }: Omit<typeof plays.$inferInsert, 'id'> & { id?: string }): Promise<void> {
  await db.insert(plays).values({ id, ...values }).onConflictDoUpdate({
    target: plays.id,
    set: { recordingId: values.recordingId, albumId: values.albumId, msPlayed: values.msPlayed, completed: values.completed, skipped: values.skipped },
  })
  if (values.completed) await emitWebhook('scrobble', {
    playId: id, trackId: values.recordingId, albumId: values.albumId, startedAt: values.startedAt, msPlayed: values.msPlayed,
  }, values.userId, id)
  if (!values.skipped) await invalidate({ user: values.userId }, [queryKeys.history(), queryKeys.home()])
}
