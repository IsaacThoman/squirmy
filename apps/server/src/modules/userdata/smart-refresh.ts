/**
 * Which smart playlists an invalidation makes stale. A smart playlist is evaluated from its
 * owner's library, hearts, ratings and plays, and from the server's collection, so whatever
 * tells clients those changed (the `library`, `likes` and `history` roots) changes it too.
 * `realtime/invalidate` asks here and sends each playlist's own key, so only smart playlists'
 * pages refetch, never the playlists of songs beside them.
 *
 * Kept apart from playlists.ts so realtime can import it without a cycle: it reads the
 * database and nothing else.
 */
import { queryKeys } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'

type Target = { user: string } | 'admins' | 'all'
type QueryKey = readonly unknown[]

const sources = new Set(['library', 'likes', 'history'])

/**
 * The invalidations to send beside one of `keys` to `targets`: each stale smart playlist's
 * key, to its owner, or to everyone when it is public. A change for everyone (a scan) stales
 * every smart playlist; one user's (a heart, a play) stales theirs.
 */
export async function smartPlaylistInvalidations(targets: readonly Target[], keys: readonly QueryKey[]): Promise<[Target, QueryKey[]][]> {
  if (!keys.some((key) => sources.has(String(key[0])))) return []
  const everyone = targets.includes('all')
  const users = targets.flatMap((target) => typeof target === 'object' ? [target.user] : [])
  if (!everyone && users.length === 0) return []
  const rows = await db.execute<{ id: string; ownerId: string; isPublic: boolean }>(sql`
    select id, owner_id as "ownerId", is_public as "isPublic" from playlists
    where rules is not null ${everyone ? sql`` : sql`and owner_id = any(${`{${users.join(',')}}`}::uuid[])`}`)
  if (rows.length === 0) return []
  if (everyone) return [['all', rows.map((row) => queryKeys.playlist(row.id))]]
  const shared = rows.filter((row) => row.isPublic).map((row) => queryKeys.playlist(row.id))
  const byOwner = new Map<string, QueryKey[]>()
  for (const row of rows.filter((candidate) => !candidate.isPublic)) byOwner.set(row.ownerId, [...byOwner.get(row.ownerId) ?? [], queryKeys.playlist(row.id)])
  return [
    ...shared.length > 0 ? [['all', shared] as [Target, QueryKey[]]] : [],
    ...[...byOwner].map(([user, list]): [Target, QueryKey[]] => [{ user }, list]),
  ]
}
