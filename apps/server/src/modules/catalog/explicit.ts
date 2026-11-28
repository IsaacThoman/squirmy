import { isPlayable } from '@squirmy/client-core'
import type { TrackSummary } from '@squirmy/contracts'
import { eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { recordings, users } from '../../database/schema.js'
import { forbidden } from '../../lib/errors.js'
import { matchKey } from '../../lib/text.js'
import { editionFreeTitle } from '../search/keys.js'
import { trackExplicit } from './credits.js'
import { uuidArray } from './sql.js'
import { trackSummaries } from './summaries.js'

/**
 * Explicit content controls. A user who does not allow explicit content (their own
 * `allowExplicit` setting, or an admin's `explicit_restricted`) sees explicit songs gray
 * and never hears them: the session's trusted entries, radio and autoplay leave them out,
 * search, Home and Subsonic hide them, and the playback descriptor refuses them.
 *
 * A song is explicit when its summary says so: a present file's advisory tag, else the
 * catalog's flag (Deezer's). MusicBrainz carries no flag, so unknown is not explicit.
 */

/**
 * Whether explicit songs play for a user: their own setting, unless an admin restricted it
 * (`User.allowsExplicit`, built by `auth/service.ts` with the same rule). No user (the
 * collection alone) and an unknown one allow it.
 */
export async function explicitAllowed(userId: string | null): Promise<boolean> {
  if (!userId) return true
  const [row] = await db.execute<{ allowed: boolean }>(sql`
    select not explicit_restricted and coalesce((settings ->> 'allowExplicit')::boolean, true) as allowed
    from users where id = ${userId}`)
  return row?.allowed ?? true
}

/** SQL: the recording is explicit, the way its summary says (see `trackExplicit`). Unknown is false. */
export const recordingExplicit = (recordingId: SQL, explicitColumn: SQL): SQL =>
  sql`coalesce(${trackExplicit(recordingId, explicitColumn, sql`null::uuid`)}, false)`

/** `tracks` without the explicit ones when `allowed` is false. */
export function withoutExplicit<T extends { explicit: boolean | null }>(tracks: T[], allowed: boolean): T[] {
  return allowed ? tracks : tracks.filter((track) => track.explicit !== true)
}

/** The ids among `ids` (recording ids, merges not followed) that are explicit. */
export async function explicitRecordings(ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)]
  if (!unique.length) return new Set()
  const rows = await db.execute<{ id: string }>(sql`
    select r.id from recordings r
    where r.id = any(${uuidArray(unique)}) and ${recordingExplicit(sql`r.id`, sql`r.explicit`)}`)
  return new Set(rows.map((row) => row.id))
}

/** A clean version may be this much shorter or longer than the explicit one: an edit mutes words, it does not cut verses. */
const CLEAN_LENGTH_TOLERANCE_MS = 15_000

/**
 * Known clean versions of explicit recordings, best first: recordings of the same primary
 * artist with the same title once edition words ("(Clean)", "(Edited)", "Explicit") are
 * dropped, about as long, that are known not to be explicit (a file tagged clean, or a store
 * saying so) and not merged away. A version whose flag is unknown is not taken: it may well be
 * the explicit recording under another row. Owned versions come first, then the more popular.
 * Whether one plays for a given user is the caller's to check.
 */
export async function cleanVersions(ids: readonly string[]): Promise<Map<string, string[]>> {
  const unique = [...new Set(ids)]
  const result = new Map<string, string[]>()
  if (!unique.length) return result
  const songKey = (title: string) => matchKey(editionFreeTitle(title))
  const originals = await db.execute<{ id: string; title: string; artistId: string | null; durationMs: number | null }>(sql`
    select id, title, primary_artist_id as "artistId", duration_ms as "durationMs" from recordings
    where id = any(${uuidArray(unique)}) and primary_artist_id is not null`)
  const wanted = originals.filter((row) => row.artistId && songKey(row.title))
  if (!wanted.length) return result
  // Title keys hold letters, digits and spaces only, so a key is a safe LIKE prefix.
  const values = sql.join(wanted.map((row) =>
    sql`(${row.id}::uuid, ${row.artistId}::uuid, ${`${songKey(row.title)}%`}, ${row.durationMs}::int)`), sql`, `)
  const rows = await db.execute<{ explicitId: string; cleanId: string; cleanTitle: string; owned: boolean; popularity: number | null }>(sql`
    select v.id as "explicitId", c.id as "cleanId", c.title as "cleanTitle", c.owned, c.popularity
    from (values ${values}) v(id, artist_id, prefix, duration_ms)
    cross join lateral (
      select c.id, c.title, c.popularity,
        exists (select 1 from media_files f where f.recording_id = c.id and f.missing_since is null) as owned
      from recordings c
      where c.primary_artist_id = v.artist_id and c.id <> v.id and c.merged_into_id is null
        and c.title_key collate "C" like v.prefix collate "C"
        and (c.duration_ms is null or v.duration_ms is null or abs(c.duration_ms - v.duration_ms) <= ${CLEAN_LENGTH_TOLERANCE_MS})
        and ${trackExplicit(sql`c.id`, sql`c.explicit`, sql`null::uuid`)} is false
      -- The same title first, then the shortest suffixes: "(Clean)" before "Gold Rush".
      order by length(c.title_key), c.id
      limit 20
    ) c`)
  const titles = new Map(wanted.map((row) => [row.id, songKey(row.title)]))
  const ranked = rows
    .filter((row) => songKey(row.cleanTitle) === titles.get(row.explicitId))
    .sort((a, b) => Number(b.owned) - Number(a.owned) || (b.popularity ?? -1) - (a.popularity ?? -1) || a.cleanId.localeCompare(b.cleanId))
  for (const row of ranked) result.set(row.explicitId, [...result.get(row.explicitId) ?? [], row.cleanId])
  return result
}

/** Whether a file is explicit: its own advisory tag, else its recording's flag. Unknown is not. */
export async function fileExplicit(file: { tags: { explicit?: boolean } | null; recordingId: string | null }): Promise<boolean> {
  if (typeof file.tags?.explicit === 'boolean') return file.tags.explicit
  if (!file.recordingId) return false
  const [row] = await db.select({ explicit: recordings.explicit }).from(recordings).where(eq(recordings.id, file.recordingId))
  return row?.explicit === true
}

/**
 * Refuses an explicit file to a user who does not allow explicit content, with 403
 * `explicit_not_allowed`: the playback descriptor and the stream routes, behind the queue's
 * own filter, so a stale queue, an older app or a saved link cannot play one.
 */
export async function assertFileAllowed(userId: string, file: { tags: { explicit?: boolean } | null; recordingId: string | null }): Promise<void> {
  if (await fileExplicit(file) && !await explicitAllowed(userId)) {
    throw forbidden('Explicit content is turned off for this account', 'explicit_not_allowed')
  }
}

/**
 * An album page's songs for a user who has explicit content off: each explicit song with a
 * known clean version that plays for the user (a file on the server, or one a provider
 * fetches for a requester) shows as that version, in its place and under this album, so the
 * page is the clean edition where one is known. Songs without one stay, and clients gray them.
 * The same list for everyone else.
 */
export async function cleanTrackList(userId: string, tracks: readonly (TrackSummary | null)[], albumId: string): Promise<(TrackSummary | null)[]> {
  const explicit = tracks.flatMap((track) => (track?.explicit ? [track.id] : []))
  if (!explicit.length || await explicitAllowed(userId)) return [...tracks]
  const versions = await cleanVersions(explicit)
  if (!versions.size) return [...tracks]
  const [[user], summaries] = await Promise.all([
    db.select({ role: users.role, canAcquire: users.canAcquire }).from(users).where(eq(users.id, userId)),
    trackSummaries(userId, [...new Set([...versions.values()].flat())].map((id) => ({ id, albumId }))),
  ])
  const byId = new Map(summaries.map((summary) => [summary.id, summary]))
  const plays = (track: TrackSummary) => track.explicit !== true && isPlayable(track, user ?? null)
  return tracks.map((track) => {
    const clean = track?.explicit ? versions.get(track.id)?.map((id) => byId.get(id)).find((one) => one && plays(one)) : undefined
    return clean ?? track
  })
}
