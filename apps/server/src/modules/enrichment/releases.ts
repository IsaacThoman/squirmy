/** The new-release feed: recent albums by artists in the library that the library lacks. */
import { queryKeys } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { uuidArray } from '../catalog/sql.js'
import { musicbrainz } from '../metadata/index.js'
import { upsertDiscography } from './artist.js'
import { attempt, changed } from './rows.js'

/** Albums released within this many days count as new. */
const windowDays = 120

/**
 * Artists credited on an album with a present file. MusicBrainz's placeholders (Various
 * Artists on every compilation) are no one's new music, and their discographies are huge.
 */
const libraryArtists = sql`
  select aa.artist_id from album_artists aa join media_files f on f.album_id = aa.album_id and f.missing_since is null
  join artists ar on ar.id = aa.artist_id
  where ar.mbid is null or not (ar.mbid = any(${uuidArray([...musicbrainz.specialPurposeArtists])}))`

/**
 * Browses the (cached) discography of every library artist with an MBID and upserts
 * albums MusicBrainz lists that the catalog lacks. Returns how many were added.
 */
export async function refreshNewReleases(): Promise<number> {
  const rows = await db.execute<{ mbid: string }>(sql`
    select a.mbid from artists a where a.mbid is not null and a.merged_into_id is null and a.id in (${libraryArtists}) order by a.id`)
  let added = 0
  for (const row of rows) {
    await attempt('new releases', async () => {
      added += (await upsertDiscography(await musicbrainz.browseReleaseGroups(row.mbid, { officialOnly: true }))).length
    })
  }
  if (added > 0) await changed([queryKeys.home()])
  return added
}

/**
 * Albums by library artists released in the last 120 days (up to today, with at least a
 * month in the date), newest first, leaving out albums with a present file.
 */
export async function newReleaseAlbumIds(limit: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select a.id from albums a
    where a.merged_into_id is null
      and length(a.release_date) >= 7
      and a.release_date >= to_char(current_date - ${windowDays}::int, 'YYYY-MM-DD')
      and a.release_date <= to_char(current_date, 'YYYY-MM-DD')
      and exists (select 1 from album_artists aa where aa.album_id = a.id and aa.artist_id in (${libraryArtists}))
      and not exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null)
    order by a.release_date desc, a.id
    limit ${limit}`)
  return rows.map((row) => row.id)
}
