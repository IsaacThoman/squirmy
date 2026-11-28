import { sql } from 'drizzle-orm'

/** Checks playlist visibility for a trusted SQL alias. Public sharing has its own rules. */
export function playlistVisibleTo(userId: string, alias = 'p') {
  const p = sql.raw(alias)
  return sql`(${p}.owner_id = ${userId} or ${p}.is_public or exists (
    select 1 from playlist_collaborators c where c.playlist_id = ${p}.id and c.user_id = ${userId}
  ))`
}
