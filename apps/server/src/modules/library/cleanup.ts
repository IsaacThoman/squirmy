import { sql, type SQL } from 'drizzle-orm'
import type { Executor } from '../../database/client.js'

/**
 * Serializes the jobs that create, relink and delete local catalog rows (ingest, move
 * detection, purge, root removal), so two of them never create the same artist twice or
 * delete a row the other is linking. Held until the transaction ends.
 */
export async function lockCatalog(tx: Executor) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('squirmy:library-catalog'))`)
}

export type OrphanCandidates = {
  albumIds?: readonly (string | null)[]
  releaseIds?: readonly (string | null)[]
  recordingIds?: readonly (string | null)[]
  artistIds?: readonly (string | null)[]
}

const ids = (values: readonly (string | null)[] | undefined) => [...new Set((values ?? []).filter((value): value is string => Boolean(value)))]

/** `true` for a full sweep, otherwise membership in the candidate ids. */
function within(column: SQL, values: string[] | undefined): SQL {
  if (values === undefined) return sql`true`
  if (values.length === 0) return sql`false`
  return sql`${column} in ${values}`
}

const noUserData = (type: 'album' | 'recording' | 'artist', column: SQL) => sql`
  not exists (select 1 from likes where entity_type = ${type} and entity_id = ${column})
  and not exists (select 1 from ratings where entity_type = ${type} and entity_id = ${column})
  ${type === 'artist' ? sql`` : sql`and not exists (select 1 from wants where entity_type = ${type} and entity_id = ${column})
  and not exists (select 1 from playlist_items where ${sql.raw(`${type}_id`)} = ${column})
  and not exists (select 1 from plays where ${sql.raw(`${type}_id`)} = ${column})`}`

async function column(tx: Executor, query: SQL): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(query)
  return rows.map((row) => row.id)
}

/**
 * Deletes local-only catalog rows (no MusicBrainz id, not a merge redirect) that no file
 * links and no user data (likes, ratings, wants, playlist items, plays) points at. Stubs
 * from catalog searches (albums and artists at `detail_level` 0, recordings with an
 * external id) are left to the search module's own cleanup:
 *
 * - release tracks of file-built releases that still have files, when no file is on them;
 * - albums, with their releases and tracks;
 * - releases without files when their album has another release;
 * - recordings on no release track;
 * - artists credited nowhere.
 *
 * With `scope`, only those rows (and rows their deletion frees) are considered; without
 * it the whole catalog is swept. Run it inside the transaction that unlinked the files.
 */
export async function removeOrphans(tx: Executor, scope?: OrphanCandidates) {
  const sweep = scope === undefined
  const albumIds = sweep ? undefined : ids(scope.albumIds)
  const releaseIds = sweep ? undefined : ids(scope.releaseIds)
  const recordingIds = sweep ? undefined : ids(scope.recordingIds)
  const artistIds = sweep ? undefined : ids(scope.artistIds)
  const freedRecordings: string[] = []
  const freedArtists: string[] = []

  freedRecordings.push(...await column(tx, sql`
    delete from release_tracks rt using releases r
    where rt.release_id = r.id and r.fetched_at is null and ${within(sql`r.id`, releaseIds)}
      and not exists (select 1 from media_files f where f.release_track_id = rt.id)
      and exists (select 1 from media_files f where f.release_id = r.id)
    returning rt.recording_id as id`))

  const albums = await column(tx, sql`
    select a.id from albums a
    where a.mbid is null and a.merged_into_id is null and a.detail_level > 0 and ${within(sql`a.id`, albumIds)}
      and not exists (select 1 from media_files f where f.album_id = a.id)
      and ${noUserData('album', sql`a.id`)}`)
  if (albums.length > 0) {
    freedRecordings.push(...await column(tx, sql`
      select rt.recording_id as id from release_tracks rt join releases r on r.id = rt.release_id where r.album_id in ${albums}`))
    freedArtists.push(...await column(tx, sql`
      select artist_id as id from album_artists where album_id in ${albums}
      union select primary_artist_id from albums where id in ${albums} and primary_artist_id is not null`))
    await tx.execute(sql`delete from albums where id in ${albums}`)
  }

  const releases = await column(tx, sql`
    select r.id from releases r
    where r.mbid is null and ${within(sql`r.id`, releaseIds)}
      and not exists (select 1 from media_files f where f.release_id = r.id)
      and exists (select 1 from releases other where other.album_id = r.album_id and other.id <> r.id)`)
  if (releases.length > 0) {
    freedRecordings.push(...await column(tx, sql`select recording_id as id from release_tracks where release_id in ${releases}`))
    await tx.execute(sql`delete from releases where id in ${releases}`)
    await tx.execute(sql`
      update albums a set canonical_release_id = (select r.id from releases r where r.album_id = a.id order by r.created_at limit 1)
      where a.canonical_release_id in ${releases}`)
  }

  const recordings = await column(tx, sql`
    select rec.id from recordings rec
    where rec.mbid is null and rec.merged_into_id is null
      and ${sweep ? sql`true` : within(sql`rec.id`, ids([...recordingIds!, ...freedRecordings]))}
      and not exists (select 1 from media_files f where f.recording_id = rec.id)
      and not exists (select 1 from release_tracks rt where rt.recording_id = rec.id)
      and not exists (select 1 from external_ids e where e.entity_type = 'recording' and e.entity_id = rec.id)
      and ${noUserData('recording', sql`rec.id`)}`)
  if (recordings.length > 0) {
    freedArtists.push(...await column(tx, sql`
      select artist_id as id from recording_artists where recording_id in ${recordings}
      union select primary_artist_id from recordings where id in ${recordings} and primary_artist_id is not null`))
    await tx.execute(sql`delete from recordings where id in ${recordings}`)
  }

  await tx.execute(sql`
    delete from artists ar
    where ar.mbid is null and ar.merged_into_id is null and ar.detail_level > 0
      and ${sweep ? sql`true` : within(sql`ar.id`, ids([...artistIds!, ...freedArtists]))}
      and not exists (select 1 from album_artists aa where aa.artist_id = ar.id)
      and not exists (select 1 from recording_artists ra where ra.artist_id = ar.id)
      and not exists (select 1 from albums a where a.primary_artist_id = ar.id)
      and not exists (select 1 from recordings rec where rec.primary_artist_id = ar.id)
      and ${noUserData('artist', sql`ar.id`)}`)
}
