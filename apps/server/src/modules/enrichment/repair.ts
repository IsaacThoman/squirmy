/**
 * The release repair: brings rows written before releases were reconciled in line with
 * what the writers do now. Idempotent, so it runs at worker start and daily.
 *
 * 1. Every artist's duplicate album rows are merged (`reconcileAllArtists`).
 * 2. Popular tracks stored from Deezer without their album (so without artwork) get it by
 *    running the artist's top tracks again, a bounded number of artists per run.
 * 3. Artists fetched before their popular tracks were stored as a ranked list get one the
 *    same way, so the page lists their hits rather than the tracks played here.
 * 4. Artist pictures chosen before pages were told apart from namesakes, or kept through
 *    a merge, are chosen again from the MusicBrainz profile, a bounded number per run.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { getServerSettings } from '../../lib/settings.js'
import { refreshTopTracks, repickArtistImage } from './artist.js'
import { reconcileAllArtists, reconcileArtistAlbums } from './reconcile.js'

/** Artists whose top tracks are fetched again per run: one or two Deezer requests each. */
const topTrackBatch = 50

/** Artists whose picture is chosen again per run: a MusicBrainz request (a second) and a Deezer one or two each. */
const imageBatch = 100

export async function repairReleases(): Promise<{ merged: number; topTrackArtists: number; rankedArtists: number; imageArtists: number }> {
  const merged = await reconcileAllArtists()
  const settings = await getServerSettings()
  const imageArtists = settings.musicBrainzEnabled ? await repairImages() : 0
  if (!settings.deezerEnabled) return { merged, topTrackArtists: 0, rankedArtists: 0, imageArtists }
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
  // Fetched artists with a Deezer page and no ranked list yet.
  const unranked = await db.execute<{ id: string }>(sql`
    select a.id from artists a
    where a.merged_into_id is null and a.detail_level >= 1
      and not exists (select 1 from artist_top_tracks t where t.artist_id = a.id)
      and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = a.id)
    order by md5(a.id::text || current_date::text) limit ${topTrackBatch}`)
  for (const artist of unranked) await refreshTopTracks(artist.id)
  return { merged, topTrackArtists: artists.length, rankedArtists: unranked.length, imageArtists }
}

/** Step 4: pictures not chosen from the artist's MusicBrainz profile. */
async function repairImages(): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    select a.id from artists a left join assets s on s.id = a.image_asset_id
    where a.merged_into_id is null and a.mbid is not null and a.detail_level >= 1 and a.image_picked_at is null
      -- A picture from the user's folders stays whatever MusicBrainz says.
      and (a.image_asset_id is null or s.source ~* '^https?://')
    order by md5(a.id::text || current_date::text) limit ${imageBatch}`)
  for (const row of rows) await repickArtistImage(row.id)
  return rows.length
}
