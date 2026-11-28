/**
 * The daily `search.cleanup` job: deletes stubs from catalog searches that nobody kept.
 *
 * A stub goes when it is older than `stubMaxAgeDays`, never gained detail (albums and
 * artists at `detail_level` 0 with no MusicBrainz releases; recordings on no release),
 * is not a merge redirect or target, and nothing points at it: no file, like, rating,
 * want, library save, playlist item, play, stored playback session, acquisition still
 * running, album hint of a kept recording or credit. Their `external_ids` rows go with
 * them; `assets` are left alone.
 */
import { sql, type SQL } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { invalidate } from '../../realtime/index.js'
import { uuidArray } from '../catalog/sql.js'
import { lockCatalog } from '../library/cleanup.js'
import { lockStubs } from './materialize.js'

export const stubMaxAgeDays = 30

/** Nothing a user keeps points at the row `alias`.id of `table`, and no row was merged into it. */
function unreferenced(type: 'recording' | 'album' | 'artist', table: string, alias: string): SQL {
  const id = sql.raw(`${alias}.id`)
  const userData = sql`
    not exists (select 1 from likes where entity_type = ${type} and entity_id = ${id})
    and not exists (select 1 from ratings where entity_type = ${type} and entity_id = ${id})
    and not exists (select 1 from session_ids s where s.id = ${id})
    and not exists (select 1 from ${sql.identifier(table)} merged where merged.merged_into_id = ${id})`
  if (type === 'artist') return userData
  const column = sql.raw(`${type}_id`)
  // A job still running would lose its target and could not check its delivery.
  const fetching = type === 'recording'
    ? sql`(j.recording_id = ${id} or ${id} = any(j.recording_ids))`
    : sql`j.album_id = ${id}`
  return sql`${userData}
    and not exists (select 1 from acquisition_jobs j where ${fetching} and j.status not in ('completed', 'failed', 'rejected'))
    and not exists (select 1 from wants where entity_type = ${type} and entity_id = ${id})
    and not exists (select 1 from playlist_items where ${column} = ${id})
    and not exists (select 1 from plays where ${column} = ${id})`
}

async function ids(tx: Transaction, query: SQL): Promise<string[]> {
  return (await tx.execute<{ id: string }>(query)).map((row) => row.id)
}

/** Deletes unkept stubs created before `now` minus `stubMaxAgeDays`, and returns how many of each. */
export async function cleanupStubs(now = new Date()) {
  const cutoff = new Date(now.getTime() - stubMaxAgeDays * 86_400_000).toISOString()
  const deleted = await db.transaction(async (tx) => {
    // The library lock first: ingest may link files to a stub while this runs.
    await lockCatalog(tx)
    await lockStubs(tx, 'exclusive')
    // Queues and history in stored sessions are JSON; any id in them counts as kept.
    await tx.execute(sql`
      create temp table session_ids on commit drop as
      select distinct match[1]::uuid as id from playback_sessions s,
        regexp_matches(s.state::text, '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'g') as match`)

    const recordings = await ids(tx, sql`
      delete from recordings r
      where r.created_at < ${cutoff} and r.merged_into_id is null
        and not exists (select 1 from release_tracks rt where rt.recording_id = r.id)
        and not exists (select 1 from media_files f where f.recording_id = r.id)
        and ${unreferenced('recording', 'recordings', 'r')}
      returning r.id`)
    const albums = await ids(tx, sql`
      delete from albums a
      where a.created_at < ${cutoff} and a.detail_level = 0 and a.merged_into_id is null
        and not exists (select 1 from releases rl where rl.album_id = a.id and rl.mbid is not null)
        and not exists (select 1 from media_files f where f.album_id = a.id or f.release_id in (select id from releases where album_id = a.id))
        and not exists (select 1 from recordings hinted where hinted.album_hint_id = a.id)
        and ${unreferenced('album', 'albums', 'a')}
      returning a.id`)
    const artists = await ids(tx, sql`
      delete from artists ar
      where ar.created_at < ${cutoff} and ar.detail_level = 0 and ar.merged_into_id is null
        and not exists (select 1 from album_artists aa where aa.artist_id = ar.id)
        and not exists (select 1 from recording_artists ra where ra.artist_id = ar.id)
        and not exists (select 1 from albums a where a.primary_artist_id = ar.id)
        and not exists (select 1 from recordings r where r.primary_artist_id = ar.id)
        and ${unreferenced('artist', 'artists', 'ar')}
      returning ar.id`)

    for (const [type, deleted] of [['recording', recordings], ['album', albums], ['artist', artists]] as const) {
      if (deleted.length > 0) await tx.execute(sql`delete from external_ids where entity_type = ${type} and entity_id = any(${uuidArray(deleted)})`)
    }
    return { recordings: recordings.length, albums: albums.length, artists: artists.length }
  })
  // An artist page can list a stub album and a stub has its own page; nothing a user kept
  // shows one, so the whole of each kind is refetched rather than naming thousands of ids.
  // Runs in the worker: the API process drops its cached reads when the NOTIFY arrives.
  const keys = [
    ...deleted.recordings > 0 ? [['track']] : [],
    ...deleted.albums > 0 ? [['album']] : [],
    ...deleted.artists > 0 ? [['artist']] : [],
  ]
  if (keys.length > 0) await invalidate('all', keys)
  return deleted
}
