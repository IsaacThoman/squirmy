/**
 * Which cached files users still hold on to, for the acquisition module's cache eviction
 * (docs/architecture.md, "Acquisition"). A provider-delivered file is pinned, never evicted,
 * while any user:
 * - has saved its album or its recording to their library,
 * - likes its recording or its album,
 * - has its recording in a playlist,
 * - has it in a stored playback queue (the current entry, up next or autoplay), or
 * - played it in the last 24 hours.
 *
 * Likes, saves, playlist items and plays follow merges (`matching/merge.ts` repoints them),
 * so they are compared with the file's own links. Queue entries keep the ids they were
 * added with, so those are resolved through merge redirects first.
 *
 * The stored queues belong to the sessions module; they are only read here.
 */
import { Id } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { resolveMerged } from '../catalog/redirects.js'
import { uuidArray } from '../catalog/sql.js'

/** A play this recent pins the file it played. */
export const RECENT_PLAY_PIN_MS = 24 * 60 * 60_000

/** Recordings in any user's stored queue, as stored and as they resolve after merges. */
export async function queuedRecordings(): Promise<string[]> {
  const rows = await db.execute<{ id: string | null }>(sql`
    select distinct entry.id from playback_sessions s
    cross join lateral (
      select s.state->'state'->'current'->>'trackId' as id
      union all select item->>'trackId' from jsonb_array_elements(case when jsonb_typeof(s.state->'queue'->'queue') = 'array' then s.state->'queue'->'queue' else '[]'::jsonb end) item
      union all select item->>'trackId' from jsonb_array_elements(case when jsonb_typeof(s.state->'queue'->'autoplayQueue') = 'array' then s.state->'queue'->'autoplayQueue' else '[]'::jsonb end) item
    ) entry`)
  const ids = rows.flatMap((row) => row.id && Id.safeParse(row.id).success ? [row.id] : [])
  if (ids.length === 0) return []
  const resolved = await resolveMerged('recordings', ids)
  return [...new Set([...ids, ...resolved.values()])]
}

/**
 * SQL that is true when a file with these links is pinned. `queued` comes from
 * `queuedRecordings()`. A file with neither link has nothing to hold it.
 */
export function pinnedFile(file: { recordingId: SQL; albumId: SQL }, queued: readonly string[]): SQL {
  const since = new Date(Date.now() - RECENT_PLAY_PIN_MS)
  // `in (union …)` runs as one hashed set per query rather than a lookup per file: the
  // likes and playlist tables have no index by entity, and eviction looks at every file.
  return sql`(
    (${file.recordingId} is not null and ${file.recordingId} in (
      select entity_id from library_items where entity_type = 'recording'
      union all select entity_id from likes where entity_type = 'recording'
      union all select recording_id from playlist_items
      union all select recording_id from plays where started_at > ${since}
      union all select unnest(${uuidArray(queued)})
    ))
    or (${file.albumId} is not null and ${file.albumId} in (
      select entity_id from library_items where entity_type = 'album'
      union all select entity_id from likes where entity_type = 'album'
    ))
  )`
}
