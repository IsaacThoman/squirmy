import { queryKeys, type PlaybackContext } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { invalidate } from '../../realtime/index.js'
import { LIKED_SONGS_ID } from '../catalog/library-items.js'
import { resolveOne } from '../catalog/redirects.js'

/**
 * Plays of collections, for the Library's "Recently played" (`collection_plays`, read by
 * `catalog/library-items.ts`). A collection is played when the user starts playback from it:
 * a `playTracks` command whose context is an album, playlist or artist with its id, or Liked
 * Songs. Pages send their own context for Play, Shuffle and their song rows, so a song
 * started on an album page counts for the album, and one started from Search, Home, a radio,
 * the history or the queue does not. Nothing else counts: `play` after a pause, `next`,
 * `previous`, a song ending, autoplay, a transfer, and the server's own commands (Subsonic's
 * saved queue) leave the order as it is.
 *
 * It is recorded here, where every client's commands arrive, so a web tab, the iOS app
 * and one device controlling another all count the same way.
 */

type Played = { type: 'album' | 'playlist' | 'artist' | 'liked'; id: string }

const uuid = z.uuid()

/** The collection a `playTracks` context names, or null when it names none. */
export function playedCollection(context: PlaybackContext | null | undefined): Played | null {
  if (!context) return null
  if (context.type === 'liked') return { type: 'liked', id: LIKED_SONGS_ID }
  if (context.type !== 'album' && context.type !== 'playlist' && context.type !== 'artist') return null
  return context.id && uuid.safeParse(context.id).success ? { type: context.type, id: context.id } : null
}

/**
 * Records that the user started playback from `context` at `at` (epoch milliseconds). Tells
 * the user's open Libraries to list it again, unless it was already the latest played and
 * so the order is the same. Album and artist ids follow merges.
 */
export async function recordCollectionPlay(userId: string, context: PlaybackContext | null | undefined, at: number): Promise<void> {
  const played = playedCollection(context)
  if (!played) return
  const id = played.type === 'album' ? await resolveOne('albums', played.id)
    : played.type === 'artist' ? await resolveOne('artists', played.id)
      : played.id
  if (!id) return
  const [row] = await db.execute<{ wasLatest: boolean }>(sql`
    with latest as (
      select entity_type, entity_id from collection_plays where user_id = ${userId}
      order by played_at desc, entity_id desc limit 1
    ), upserted as (
      insert into collection_plays (user_id, entity_type, entity_id, played_at)
      values (${userId}, ${played.type}, ${id}, to_timestamp(${at / 1000}))
      on conflict (user_id, entity_type, entity_id) do update set played_at = greatest(collection_plays.played_at, excluded.played_at)
    )
    select exists (select 1 from latest where entity_type = ${played.type} and entity_id = ${id}) as "wasLatest"`)
  if (!row?.wasLatest) await invalidate({ user: userId }, [queryKeys.libraryItems()])
}
