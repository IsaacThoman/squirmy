/** The new-release feed: recent albums by each user's own artists that their library lacks. */
import { queryKeys } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { uuidArray } from '../catalog/sql.js'
import { musicbrainz } from '../metadata/index.js'
import { upsertDiscography } from './artist.js'
import { attempt, changed } from './rows.js'

/** Albums released within this many days count as new. */
const windowDays = 120

/** MusicBrainz's placeholders (Various Artists on every compilation) are no one's new music, and their discographies are huge. */
const notPlaceholder = (artist: string) =>
  sql`(${sql.raw(artist)}.mbid is null or not (${sql.raw(artist)}.mbid = any(${uuidArray([...musicbrainz.specialPurposeArtists])})))`

/**
 * Releases that are another act's take on an artist's songs: karaoke and backing tracks,
 * tributes, "in the style of", string-quartet and lullaby renditions, "… performs …" covers.
 * They are filed under the covered artist's name often enough to fill the feed (live: nine
 * karaoke volumes and a string quartet for one user) and are nobody's new release.
 */
const COVER_ACT = String.raw`karaoke|backing track|tribute|in the style of|made famous by|originally performed|string quartet|lullaby|performs |piano versions|8-bit|cover versions`

/**
 * Artists whose discographies the feed keeps current, across every user: those credited on a
 * collection album or on an album someone saved, and those someone saved (hearted) themselves.
 * Music fetched for playing is cache and adds none, nor does a Various Artists placeholder.
 */
const everyonesArtists = sql`
  select aa.artist_id from album_artists aa join artists ar on ar.id = aa.artist_id
  where ${notPlaceholder('ar')} and (
    exists (select 1 from media_files f where f.album_id = aa.album_id and f.missing_since is null and not f.cached)
    or exists (select 1 from likes l where l.entity_type = 'album' and l.entity_id = aa.album_id))
  union
  select l.entity_id from likes l join artists ar on ar.id = l.entity_id where l.entity_type = 'artist' and ${notPlaceholder('ar')}`

/**
 * One user's artists (product decision 31): credited on an album in their library (the
 * collection, or one they saved) or saved by them.
 */
const usersArtists = (userId: string) => sql`
  select aa.artist_id from album_artists aa join artists ar on ar.id = aa.artist_id
  where ${notPlaceholder('ar')} and (
    exists (select 1 from media_files f where f.album_id = aa.album_id and f.missing_since is null and not f.cached)
    or exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'album' and l.entity_id = aa.album_id))
  union
  select l.entity_id from likes l join artists ar on ar.id = l.entity_id
  where l.user_id = ${userId} and l.entity_type = 'artist' and ${notPlaceholder('ar')}`

/**
 * Browses the (cached) discography of every artist in someone's library with an MBID and
 * upserts albums MusicBrainz lists that the catalog lacks. Returns how many were added.
 */
export async function refreshNewReleases(): Promise<number> {
  const rows = await db.execute<{ mbid: string }>(sql`
    select a.mbid from artists a where a.mbid is not null and a.merged_into_id is null and a.id in (${everyonesArtists}) order by a.id`)
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
 * The user's new releases: albums whose main artist is one of the user's artists, released in
 * the last 120 days (up to today, with at least a month in the date), newest first. Left out:
 * albums the user already has (a present file, or saved) and cover acts' releases
 * (`COVER_ACT`, by album title or artist name).
 */
export async function newReleaseAlbumIds(userId: string, limit: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select a.id from albums a join artists main on main.id = a.primary_artist_id
    where a.merged_into_id is null
      and length(a.release_date) >= 7
      and a.release_date >= to_char(current_date - ${windowDays}::int, 'YYYY-MM-DD')
      and a.release_date <= to_char(current_date, 'YYYY-MM-DD')
      and a.primary_artist_id in (${usersArtists(userId)})
      and a.title !~* ${COVER_ACT} and main.name !~* ${COVER_ACT}
      and not exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null)
      and not exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'album' and l.entity_id = a.id)
    order by a.release_date desc, a.id
    limit ${limit}`)
  return rows.map((row) => row.id)
}
