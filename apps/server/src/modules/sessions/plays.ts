import { positionAt, type Session } from '@squirmy/client-core'
import { queryKeys } from '@squirmy/contracts'
import { db } from '../../database/client.js'
import { plays } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { invalidate } from '../../realtime/index.js'

/**
 * Play accounting. A play opens when an entry is current and running on the active
 * device, and closes when the current entry changes or stops at its end. Listened time
 * is the session's own position arithmetic between changes, so pauses, stalls and seeks
 * add nothing and a track that runs past its end adds nothing after it.
 */

/** Plays shorter than this are skips and leave no row. */
const SKIP_MS = 5000
/** A play counts as completed after half the track or this much, whichever is less. */
const COMPLETE_CAP_MS = 4 * 60_000

export type OpenPlay = {
  entryId: string
  recordingId: string
  albumId: string | null
  deviceId: string | null
  durationMs: number
  startedAt: number
  msPlayed: number
  /** Server time up to which `msPlayed` is counted. */
  countedTo: number
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
      entryId: entry.id,
      recordingId: entry.trackId,
      albumId: entry.albumId,
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

/** Writes a closed play unless it was a skip, then refreshes the user's history screens. */
export async function savePlay(userId: string, play: OpenPlay): Promise<void> {
  if (play.msPlayed < SKIP_MS) return
  const msPlayed = Math.round(play.msPlayed)
  await insertPlay({
    userId,
    recordingId: play.recordingId,
    albumId: play.albumId,
    deviceId: play.deviceId,
    client: 'app',
    startedAt: new Date(play.startedAt),
    msPlayed,
    completed: isCompleted(msPlayed, play.durationMs),
  })
}

export async function insertPlay(values: Omit<typeof plays.$inferInsert, 'id'>): Promise<void> {
  await db.insert(plays).values({ id: newId(), ...values })
  await invalidate({ user: values.userId }, [queryKeys.history(), queryKeys.home()])
}
