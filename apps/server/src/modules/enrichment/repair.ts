/**
 * The release repair: brings rows written by older code in line with what the writers do
 * now. Idempotent, so it runs at worker start and daily.
 *
 * 1. Store editions merged into their release group's row are split off again (`editions.ts`).
 * 2. Every artist's duplicate album rows are merged (`reconcileAllArtists`), and artist rows
 *    built from a delivery's tags that only merged rows still credit are folded into the
 *    catalog artist of their name, or removed (`foldTagBuiltArtists`).
 * 3. Names and titles stored with HTML entities ("Will Taylor &amp; Strings Attached") are
 *    decoded, and their keys recomputed.
 * 4. Albums with a date but no year get the year.
 * 5. Recordings MusicBrainz's track list replaced without Deezer's explicit flag get it,
 *    from the album's Deezer track list, a bounded number of albums per run.
 * 6. Popular tracks stored from Deezer without their album (so without artwork) get it by
 *    running the artist's top tracks again, a bounded number of artists per run.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { getServerSettings } from '../../lib/settings.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { deezer } from '../metadata/index.js'
import { decodeEntities } from '../metadata/deezer.js'
import { refreshTopTracks } from './artist.js'
import { linkDeezerAlbum } from './deezer-rows.js'
import { splitMergedEditions } from './editions.js'
import { foldTagBuiltArtists, reconcileAllArtists, reconcileArtistAlbums } from './reconcile.js'
import { attempt } from './rows.js'

/** Artists whose top tracks are fetched again per run: one or two Deezer requests each. */
const topTrackBatch = 200
/** Albums whose Deezer track list is read again per run for explicit flags: two Deezer requests each. */
const explicitBatch = 200

export type RepairReport = {
  editions: number; merged: number; tagArtists: number; decoded: number; years: number; explicitAlbums: number; topTrackArtists: number
}

export async function repairReleases(): Promise<RepairReport> {
  const deezerEnabled = (await getServerSettings()).deezerEnabled
  const editions = deezerEnabled ? await splitMergedEditions() : 0
  const merged = await reconcileAllArtists()
  const tagArtists = await foldTagBuiltArtists()
  const decoded = await decodeStoredEntities()
  const years = await backfillYears()
  if (!deezerEnabled) return { editions, merged, tagArtists, decoded, years, explicitAlbums: 0, topTrackArtists: 0 }
  const explicitAlbums = await backfillExplicit()
  // Popular Deezer tracks on no release and without an album: the artist page showed them with no artwork.
  const artists = await db.execute<{ id: string }>(sql`
    select r.primary_artist_id as id from recordings r
    where r.popularity is not null and r.merged_into_id is null and r.album_hint_id is null and r.primary_artist_id is not null
      and not exists (select 1 from release_tracks rt where rt.recording_id = r.id)
      and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'recording' and e.entity_id = r.id)
      and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = r.primary_artist_id)
    group by r.primary_artist_id
    -- A daily order keeps artists whose refresh does not help from holding the batch.
    order by md5(r.primary_artist_id::text || current_date::text) limit ${topTrackBatch}`)
  for (const artist of artists) {
    if (await refreshTopTracks(artist.id)) await reconcileArtistAlbums(artist.id)
  }
  return { editions, merged, tagArtists, decoded, years, explicitAlbums, topTrackArtists: artists.length }
}

const encoded = `'&(#x?[0-9a-f]+|amp|quot|lt|gt|apos|nbsp);'`

/** Decodes HTML entities Deezer's text came with, recomputing the keys built from it. Returns how many rows changed. */
export async function decodeStoredEntities(): Promise<number> {
  let changed = 0
  const like = sql.raw(encoded)
  const artistRows = await db.execute<{ id: string; name: string; sortName: string }>(sql`
    select id, name, sort_name as "sortName" from artists where name ~* ${like} or sort_name ~* ${like}`)
  for (const row of artistRows) {
    const name = decodeEntities(row.name)
    await db.execute(sql`update artists set name = ${name}, sort_name = ${decodeEntities(row.sortName)}, name_key = ${matchKey(name)}, updated_at = now() where id = ${row.id}`)
    changed++
  }
  for (const table of ['albums', 'recordings'] as const) {
    const rows = await db.execute<{ id: string; title: string; artistCredit: string }>(sql`
      select id, title, artist_credit as "artistCredit" from ${sql.identifier(table)} where title ~* ${like} or artist_credit ~* ${like}`)
    for (const row of rows) {
      const title = decodeEntities(row.title)
      const artistCredit = decodeEntities(row.artistCredit)
      await db.execute(sql`
        update ${sql.identifier(table)} set title = ${title}, artist_credit = ${artistCredit}, title_key = ${matchKey(title)},
          match_key = ${creditKey(artistCredit, title)}, updated_at = now()
        where id = ${row.id}`)
      changed++
    }
  }
  for (const [table, column] of [['album_artists', 'credited_name'], ['recording_artists', 'credited_name'], ['releases', 'title'], ['release_tracks', 'title'], ['release_tracks', 'artist_credit']] as const) {
    const rows = await db.execute<{ id: string; value: string }>(sql`
      select ctid::text as id, ${sql.identifier(column)} as value from ${sql.identifier(table)} where ${sql.identifier(column)} ~* ${like}`)
    for (const row of rows) {
      await db.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${decodeEntities(row.value)} where ctid = ${row.id}::tid`)
      changed++
    }
  }
  return changed
}

/** Gives albums with a known date (their own, or their track list's) the year. Returns how many. */
export async function backfillYears(): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    update albums a set year = substring(coalesce(a.release_date, rl.release_date) from 1 for 4)::int,
      release_date = coalesce(a.release_date, rl.release_date), updated_at = now()
    from albums self left join releases rl on rl.id = self.canonical_release_id
    where self.id = a.id and a.year is null and a.merged_into_id is null
      and coalesce(a.release_date, rl.release_date) ~ '^[0-9]{4}'
    returning a.id`)
  return rows.length
}

/**
 * Reads the Deezer track list again for albums whose MusicBrainz track list has recordings
 * with a Deezer id but no explicit flag, and copies the flag (by ISRC, `linkDeezerAlbum`).
 * Returns how many albums were read.
 */
export async function backfillExplicit(): Promise<number> {
  const rows = await db.execute<{ albumId: string; deezerId: string }>(sql`
    select a.id as "albumId", (select min(e.external_id) from external_ids e
      where e.provider = 'deezer' and e.entity_type = 'album' and e.entity_id = a.id) as "deezerId"
    from albums a join releases rl on rl.id = a.canonical_release_id and rl.mbid is not null
    where a.merged_into_id is null
      and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'album' and e.entity_id = a.id)
      and exists (select 1 from release_tracks rt join recordings r on r.id = rt.recording_id
        where rt.release_id = rl.id and r.explicit is null
          and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'recording' and e.entity_id = r.id))
    order by md5(a.id::text || current_date::text) limit ${explicitBatch}`)
  for (const row of rows) {
    await attempt('explicit flags', async () => {
      const album = await deezer.getAlbum(Number(row.deezerId))
      if (album) await linkDeezerAlbum(row.albumId, album)
    })
  }
  return rows.length
}
