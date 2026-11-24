/**
 * Pins of the Library's All (`library_pins`): what a user put at the top of their library,
 * on every device. `catalog/library-items.ts` lists them first. Not to be confused with
 * `pins.ts`, which keeps cached files from eviction.
 */
import { LIBRARY_PIN_LIMIT, LIKED_SONGS_ID, queryKeys, type LibraryPinKind } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { conflict, notFound } from '../../lib/errors.js'
import { invalidate } from '../../realtime/index.js'
import { listsEntry } from '../catalog/library-items.js'
import { resolveMerged } from '../catalog/redirects.js'
import { uuidArray } from '../catalog/sql.js'
import { resolveEntity } from './entities.js'

/** The stored id of what `kind` and `id` name: albums and artists follow merges. 404 for what does not exist or the user may not see. */
async function pinnedId(userId: string, kind: LibraryPinKind, id: string): Promise<string> {
  switch (kind) {
    case 'album': return resolveEntity('album', id)
    case 'artist': return resolveEntity('artist', id)
    case 'liked':
      if (id !== LIKED_SONGS_ID) throw notFound('Liked Songs is pinned by its own id', 'liked_not_found')
      return id
    case 'playlist': {
      const [row] = await db.execute<{ id: string }>(sql`
        select id from playlists where id = ${id} and (owner_id = ${userId} or is_public)`)
      if (!row) throw notFound('No such playlist', 'playlist_not_found')
      return row.id
    }
  }
}

/**
 * Pins an item to the top of the user's Library (idempotent: a pinned item keeps its place).
 * Pins whose item has left the library are dropped first, so they do not count toward
 * `LIBRARY_PIN_LIMIT`.
 */
export async function pinLibraryItem(userId: string, kind: LibraryPinKind, id: string): Promise<void> {
  const entityId = await pinnedId(userId, kind, id)
  await db.transaction(async (tx) => {
    // One user's pins take turns, so concurrent ones cannot all pass the count.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`squirmy:library-pins:${userId}`}, 0))`)
    await tx.execute(sql`delete from library_pins pin where pin.user_id = ${userId} and not (${listsEntry('pin', userId)})`)
    const [row] = await tx.execute<{ count: number; pinned: boolean }>(sql`
      select count(*)::int as count, bool_or(entity_type = ${kind} and entity_id = ${entityId}) as pinned
      from library_pins where user_id = ${userId}`)
    if (row?.pinned) return
    if ((row?.count ?? 0) >= LIBRARY_PIN_LIMIT) throw conflict(`You can pin at most ${LIBRARY_PIN_LIMIT} items`, 'too_many_pins')
    await tx.execute(sql`
      insert into library_pins (user_id, entity_type, entity_id) values (${userId}, ${kind}, ${entityId})
      on conflict do nothing`)
  })
  await invalidate({ user: userId }, [queryKeys.libraryItems()])
}

/** Unpins an item (idempotent), under the given id and wherever its merges lead. */
export async function unpinLibraryItem(userId: string, kind: LibraryPinKind, id: string): Promise<void> {
  const ids = new Set([id])
  if (kind === 'album' || kind === 'artist') {
    const resolved = (await resolveMerged(kind === 'album' ? 'albums' : 'artists', [id])).get(id)
    if (resolved) ids.add(resolved)
  }
  await db.execute(sql`
    delete from library_pins where user_id = ${userId} and entity_type = ${kind}
      and entity_id = any(${uuidArray([...ids])})`)
  await invalidate({ user: userId }, [queryKeys.libraryItems()])
}
