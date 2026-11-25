/**
 * Builds Subsonic artists (`ArtistID3`, and the folder-browsing `artist`) in batches.
 * An artist is in the library when it is credited on a library album or a library track
 * (sql.ts); `albumCount` counts the library albums it is an album artist of.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { sortKeys, isoTime, uuidArray } from '../catalog/sql.js'
import { sortKey } from '../../lib/text.js'
import { artistId, coverArtId } from './ids.js'
import type { Payload } from './protocol.js'
import { libraryAlbum, libraryAlbumIds, libraryRecording, servableArt, type Reach } from './sql.js'

export type ArtistRow = {
  id: string
  mbid: string | null
  name: string
  sortName: string | null
  imageId: string | null
  albumCount: number
  starred: string | null
  rating: number | null
}

/** A public, unauthenticated artwork URL (the native `GET /art` route), for fields that want a URL. */
export const artUrl = (baseUrl: string, assetId: string, size: 96 | 300 | 600 | 1200) => `${baseUrl}/api/v1/art/${assetId}/${size}`

/** ArtistID3 from a row. */
export function artistID3(row: ArtistRow, baseUrl: string): Payload {
  return {
    id: artistId(row.id),
    name: row.name,
    coverArt: row.imageId ? coverArtId(row.imageId) : undefined,
    artistImageUrl: row.imageId ? artUrl(baseUrl, row.imageId, 600) : undefined,
    albumCount: row.albumCount,
    starred: row.starred ?? undefined,
    musicBrainzId: row.mbid ?? undefined,
    sortName: row.sortName ?? undefined,
  }
}

/** The folder-browsing `artist` element (getIndexes, search2, getStarred). */
export function indexArtist(row: ArtistRow, baseUrl: string): Payload {
  return {
    id: artistId(row.id),
    name: row.name,
    artistImageUrl: row.imageId ? artUrl(baseUrl, row.imageId, 600) : undefined,
    starred: row.starred ?? undefined,
    userRating: row.rating ?? undefined,
  }
}

const userColumns = sql`${isoTime('lk.created_at')} as starred, rating.rating`
const userJoins = (userId: string) => sql`
  left join likes lk on lk.user_id = ${userId} and lk.entity_type = 'artist' and lk.entity_id = ar.id
  left join ratings rating on rating.user_id = ${userId} and rating.entity_type = 'artist' and rating.entity_id = ar.id`

/** Library artists among `ids`, in their order (with the `server` reach, also the server's own). */
export async function artistRows(userId: string, ids: readonly string[], rootId?: string | null, reach: Reach = 'library'): Promise<ArtistRow[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const rows = await db.execute<ArtistRow & { owned: boolean }>(sql`
    select ar.id, ar.mbid, ar.name, ar.sort_name as "sortName", ${servableArt('ar.image_asset_id')} as "imageId",
      (select count(distinct aa.album_id)::int from album_artists aa
        where aa.artist_id = ar.id and ${libraryAlbum('aa.album_id', userId, rootId, reach)}) as "albumCount",
      exists (select 1 from recording_artists ra where ra.artist_id = ar.id and ${libraryRecording('ra.recording_id', userId, rootId, reach)}) as owned,
      ${userColumns}
    from artists ar ${userJoins(userId)}
    where ar.id = any(${uuidArray(unique)})`)
  const byId = new Map(rows.filter((row) => row.albumCount > 0 || row.owned).map((row) => [row.id, row]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

/**
 * Every artist credited as album artist on a library album (of the music folder, when
 * given), by name ignoring a leading article. One query; the album set is read once.
 */
export async function allLibraryArtists(userId: string, rootId?: string | null): Promise<ArtistRow[]> {
  return db.execute<ArtistRow>(sql`
    with owned as (${libraryAlbumIds(userId, rootId)}),
    counted as (
      select aa.artist_id, count(distinct aa.album_id)::int as "albumCount"
      from owned join album_artists aa on aa.album_id = owned.album_id
      group by aa.artist_id
    )
    select ar.id, ar.mbid, ar.name, ar.sort_name as "sortName", ${servableArt('ar.image_asset_id')} as "imageId", counted."albumCount",
      ${userColumns}
    from counted join artists ar on ar.id = counted.artist_id ${userJoins(userId)}
    order by ${sortKeys.name('ar')}, ar.id`)
}

/** Ignored articles, as getIndexes and getArtists announce them. They match `sortKey`. */
export const IGNORED_ARTICLES = 'The A An'

/** Groups artists under the first letter of their sort key; digits and symbols go under `#`. */
export function indexByLetter<T>(rows: readonly ArtistRow[], render: (row: ArtistRow) => T): { name: string; artist: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const first = sortKey(row.name).charAt(0).toUpperCase()
    const letter = /^[A-Z]$/.test(first) ? first : '#'
    const group = groups.get(letter) ?? []
    group.push(render(row))
    groups.set(letter, group)
  }
  return [...groups].sort(([a], [b]) => a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)).map(([name, artist]) => ({ name, artist }))
}
