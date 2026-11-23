/**
 * What a heart (a save to the library) changes, for the user's devices. The entity's flags
 * go out as `patch` changes with the values the server now holds, so every row, page and
 * search result that shows the entity updates in place and none of them is fetched again.
 * Only the lists that gain or lose a member (Liked Songs and the other likes lists, the
 * library's lists, Home) are invalidated.
 */
import { queryKeys, type EntityChange, type EntityFields, type LikeEntityType } from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { likes } from '../../database/schema.js'
import { invalidate, publishChanges } from '../../realtime/index.js'
import { membership } from '../catalog/availability.js'
import { storedType } from './entities.js'

/**
 * Tells the user's devices what a heart or its removal changed about the entity (already
 * redirect-resolved): its `liked`, its own membership (`inLibrary`, and `library` for tracks
 * and album pages), and for an album, the membership of its songs and artists.
 */
export async function announceUserChange(userId: string, type: LikeEntityType, id: string) {
  const [row] = await db.select({ id: likes.entityId }).from(likes)
    .where(and(eq(likes.userId, userId), eq(likes.entityType, storedType[type]), eq(likes.entityId, id)))
  const fields: EntityFields = { liked: Boolean(row) }
  const changes: EntityChange[] = []
  // An album's save also puts its songs (those with a file) and its artists in the library.
  const held = type === 'album' ? await db.execute<{ kind: 'recording' | 'artist'; id: string }>(sql`
    select 'artist' as kind, artist_id as id from album_artists where album_id = ${id}
    union select 'recording', recording_id from media_files where album_id = ${id} and recording_id is not null
    union select 'recording', rt.recording_id from release_tracks rt join releases rl on rl.id = rt.release_id where rl.album_id = ${id}`) : []
  const state = await membership(userId, {
    albums: type === 'album' ? [id] : [],
    recordings: type === 'track' ? [id] : held.filter((entity) => entity.kind === 'recording').map((entity) => entity.id),
    artists: type === 'artist' ? [id] : held.filter((entity) => entity.kind === 'artist').map((entity) => entity.id),
  })
  if (type === 'album') fields.library = state.albums.get(id) ?? null
  for (const [recording, library] of state.recordings) {
    const values = { inLibrary: library !== null, library }
    if (recording === id) Object.assign(fields, values)
    else changes.push({ kind: 'patch', entity: 'track', id: recording, fields: values })
  }
  for (const [artist, inLibrary] of state.artists) {
    if (artist === id) fields.inLibrary = inLibrary
    else changes.push({ kind: 'patch', entity: 'artist', id: artist, fields: { inLibrary } })
  }
  // The entity itself first, so a device that reads only the first patch still has it right.
  await publishChanges({ user: userId }, [{ kind: 'patch', entity: type, id, fields }, ...changes])
  await invalidate({ user: userId }, [queryKeys.likes(), queryKeys.library(), queryKeys.home()])
}
