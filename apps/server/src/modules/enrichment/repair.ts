/**
 * The release repair: brings rows written before releases were reconciled in line with
 * what the writers do now. Idempotent, so it runs at worker start and daily.
 *
 * 1. Every artist's duplicate album rows are merged (`reconcileAllArtists`).
 * 2. Popular tracks stored from Deezer without their album (so without artwork) get it by
 *    running the artist's top tracks again, a bounded number of artists per run.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { getServerSettings } from '../../lib/settings.js'
import { refreshTopTracks } from './artist.js'
import { reconcileAllArtists, reconcileArtistAlbums } from './reconcile.js'

/** Artists whose top tracks are fetched again per run: one or two Deezer requests each. */
const topTrackBatch = 50

export async function repairReleases(): Promise<{ merged: number; topTrackArtists: number }> {
  const merged = await reconcileAllArtists()
  if (!(await getServerSettings()).deezerEnabled) return { merged, topTrackArtists: 0 }
  // Popular Deezer tracks on no release and without an album: the artist page showed them with no artwork.
  const artists = await db.execute<{ id: string }>(sql`
    select r.primary_artist_id as id from recordings r
    where r.popularity is not null and r.merged_into_id is null and r.album_hint_id is null and r.primary_artist_id is not null
      and not exists (select 1 from release_tracks rt where rt.recording_id = r.id)
      and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'recording' and e.entity_id = r.id)
      and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = r.primary_artist_id)
    group by r.primary_artist_id
    -- A track that left an artist's top list keeps its row without an album; a daily
    -- order keeps such artists from holding the batch every day.
    order by md5(r.primary_artist_id::text || current_date::text) limit ${topTrackBatch}`)
  for (const artist of artists) {
    if (await refreshTopTracks(artist.id)) await reconcileArtistAlbums(artist.id)
  }
  return { merged, topTrackArtists: artists.length }
}
