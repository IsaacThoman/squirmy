/**
 * The play queue is the user's Squirmy session queue, through the sessions service: a
 * queue saved here plays on in the Squirmy apps, and theirs restores in Subsonic clients.
 *
 * A session keeps the current entry and what comes after it. The songs a Subsonic
 * client saved before its current one are remembered here, in memory, for as long as
 * the session's queue is unchanged, so a save and a restore give back the same list.
 */
import { positionAt } from '@squirmy/client-core'
import type { SessionSnapshot } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../../database/client.js'
import { isoTime } from '../../catalog/sql.js'
import { getSnapshot, replaceQueue } from '../../sessions/index.js'
import { expectId, trackId } from '../ids.js'
import { ErrorCode, invalidParameter, missingParameter, SubsonicError, type Context, type Handler, type Payload } from '../protocol.js'
import { songs } from '../songs.js'

type Saved = { queueVersion: number; before: string[]; client: string; at: string }

const saved = new Map<string, Saved>()

async function save(context: Context, ids: string[], currentIndex: number | undefined) {
  const { user, params, client } = context
  const positionMs = params.int('position', 0, { min: 0 })
  const start = currentIndex ?? 0
  const snapshot = await replaceQueue(user.id, { trackIds: ids.slice(start), currentId: ids[start] ?? null, positionMs })
  saved.set(user.id, { queueVersion: snapshot.queueVersion, before: ids.slice(0, start), client, at: new Date().toISOString() })
  return {}
}

/** The queue as Subsonic sees it, with the index of the current song among `entry`. */
async function load({ user }: Context): Promise<{ queue: Payload; currentIndex: number | undefined }> {
  const snapshot: SessionSnapshot = await getSnapshot(user.id)
  const remembered = saved.get(user.id)
  const fresh = remembered?.queueVersion === snapshot.queueVersion ? remembered : undefined
  const { current } = snapshot.state
  // songs() leaves out what the server cannot play, so the current index is counted after it.
  const [before, rest] = await Promise.all([
    songs(user.id, (fresh?.before ?? []).map((id) => ({ id }))),
    songs(user.id, [...(current ? [current] : []), ...snapshot.queue.queue].map((entry) => ({ id: entry.trackId, albumId: entry.albumId }))),
  ])
  const entry = [...before, ...rest]
  const currentIndex = current && rest[0]?.id === trackId(current.trackId) ? before.length : undefined
  let changed = fresh?.at
  if (!changed) {
    const [row] = await db.execute<{ at: string }>(sql`select ${isoTime('updated_at')} as at from playback_sessions where user_id = ${user.id}`)
    changed = row?.at ?? new Date().toISOString()
  }
  return {
    queue: {
      position: current ? Math.round(positionAt(snapshot.state, Date.now())) : undefined,
      username: user.username,
      changed,
      changedBy: fresh?.client ?? 'Squirmy',
      entry,
    },
    currentIndex,
  }
}

const ids = (context: Context) => context.params.all('id').map((value) => expectId(value, 'track').id)

export const queueEndpoints: Record<string, Handler> = {
  getPlayQueue: async (context) => {
    const { queue, currentIndex } = await load(context)
    const entry = queue.entry as Payload[]
    return { playQueue: { current: currentIndex === undefined ? undefined : entry[currentIndex]!.id, ...queue } }
  },
  getPlayQueueByIndex: async (context) => {
    const { queue, currentIndex } = await load(context)
    return { playQueueByIndex: { currentIndex, ...queue } }
  },
  savePlayQueue: async (context) => {
    const list = ids(context)
    if (list.length === 0) return save(context, [], undefined)
    const current = context.params.string('current')
    if (!current) throw missingParameter('current')
    const index = list.indexOf(expectId(current, 'track').id)
    if (index < 0) throw invalidParameter('current')
    return save(context, list, index)
  },
  savePlayQueueByIndex: async (context) => {
    const list = ids(context)
    const index = context.params.int('currentIndex')
    if (list.length === 0) {
      if (index !== undefined) throw invalidParameter('currentIndex')
      return save(context, [], undefined)
    }
    if (index === undefined) throw missingParameter('currentIndex')
    if (index < 0 || index >= list.length) {
      throw new SubsonicError(ErrorCode.missingParameter, 'currentIndex must be the index of one of the ids')
    }
    return save(context, list, index)
  },
}
