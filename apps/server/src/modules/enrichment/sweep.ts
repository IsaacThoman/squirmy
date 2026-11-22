import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { enqueueMany } from '../../jobs/index.js'
import { getServerSettings } from '../../lib/settings.js'
import { bridgeNamesakes } from './namesakes.js'

/** Jobs queued per kind per sweep; the next sweep picks up the rest. */
const batch = 200
/** Background enrichment yields to tag reading and matching. */
const priority = -5

/**
 * Queues enrichment for owned music that never got it: albums with a present file and no
 * `enriched_at`; artists credited on them below `detail_level` 2 that have an id to look
 * up and were not tried in the last day; and, while LRCLIB is on, owned recordings with no
 * lyrics row (or a `none` marker older than 30 days). Keyed jobs, so a sweep that
 * finds work already queued adds nothing. Then, while MusicBrainz is on, it bridges a few
 * Deezer-only artists that share a name with another row (namesakes.ts).
 */
export async function sweep(): Promise<void> {
  const [albums, artists, recordings] = await Promise.all([
    db.execute<{ id: string }>(sql`
      select a.id from albums a
      where a.enriched_at is null and a.merged_into_id is null
        and exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null)
      order by a.id limit ${batch}`),
    db.execute<{ id: string }>(sql`
      select ar.id from artists ar
      where ar.detail_level < 2 and ar.merged_into_id is null
        and (ar.fetched_at is null or ar.fetched_at < now() - interval '1 day')
        and (ar.mbid is not null or exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = ar.id))
        and exists (select 1 from album_artists aa join media_files f on f.album_id = aa.album_id and f.missing_since is null where aa.artist_id = ar.id)
      order by ar.id limit ${batch}`),
    db.execute<{ id: string }>(sql`
      select distinct f.recording_id as id from media_files f
      left join lyrics l on l.recording_id = f.recording_id
      where f.missing_since is null and f.recording_id is not null
        and (l.recording_id is null or (l.source = 'none' and l.fetched_at < now() - interval '30 days'))
      order by f.recording_id limit ${batch}`),
  ])
  await enqueueMany('enrichment.album', albums.map((row) => ({ data: { albumId: row.id }, singletonKey: row.id, priority })))
  await enqueueMany('enrichment.artist', artists.map((row) => ({ data: { artistId: row.id }, singletonKey: row.id, priority })))
  const settings = await getServerSettings()
  if (settings.lrclibEnabled) {
    await enqueueMany('enrichment.lyrics', recordings.map((row) => ({ data: { recordingId: row.id }, singletonKey: row.id, priority })))
  }
  if (settings.musicBrainzEnabled) await bridgeNamesakes()
}
