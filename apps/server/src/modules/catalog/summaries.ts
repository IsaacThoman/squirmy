/**
 * Batch builders for the summaries every list and page is made of. Search, sessions,
 * Subsonic and userdata build their responses with these too.
 *
 * Each builder runs a fixed number of queries however many ids it gets, follows
 * `merged_into_id` redirects (so ids stored by clients keep working), silently drops ids
 * that do not exist, and returns summaries in the order of its input.
 */
import type { AlbumSummary, ArtistRef, ArtistSummary, Artwork, TrackSummary } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albumAvailability, recordingOwned, trackAvailability } from './availability.js'
import { resolveMerged } from './redirects.js'
import { uuidArray } from './sql.js'

/** A track to summarize, optionally in the context of one album. */
export type TrackRef = { id: string; albumId?: string | null }

type ArtworkColumns = { artworkId: string | null; artworkColor: string | null; artworkThumbhash: string | null }

function artwork(row: ArtworkColumns): Artwork | null {
  return row.artworkId ? { id: row.artworkId, color: row.artworkColor, thumbhash: row.artworkThumbhash } : null
}

/** Credited artists in credit order, keyed by the owning row's id. */
async function credits(table: 'recording_artists' | 'album_artists', ids: string[]): Promise<Map<string, ArtistRef[]>> {
  const owner = table === 'recording_artists' ? 'recording_id' : 'album_id'
  const rows = await db.execute<{ ownerId: string; id: string; name: string }>(sql`
    select ${sql.raw(owner)} as "ownerId", artist_id as id, credited_name as name
    from ${sql.raw(table)} where ${sql.raw(owner)} = any(${uuidArray(ids)})
    order by ${sql.raw(owner)}, position`)
  const result = new Map<string, ArtistRef[]>()
  for (const row of rows) {
    const list = result.get(row.ownerId) ?? []
    list.push({ id: row.id, name: row.name })
    result.set(row.ownerId, list)
  }
  return result
}

/** Rows without credit rows fall back to their primary artist under the display credit. */
function artistsOf(credited: Map<string, ArtistRef[]>, id: string, primaryArtistId: string | null, artistCredit: string): ArtistRef[] {
  return credited.get(id) ?? (primaryArtistId ? [{ id: primaryArtistId, name: artistCredit }] : [])
}

type TrackRow = ArtworkColumns & {
  id: string
  albumContext: string | null
  mbid: string | null
  title: string
  artistCredit: string
  primaryArtistId: string | null
  durationMs: number
  explicit: boolean | null
  hasLyrics: boolean
  albumId: string | null
  albumTitle: string | null
  disc: number | null
  position: number | null
}

/**
 * Summaries of tracks (recordings) as `userId` sees them, in input order, leaving out ids
 * that do not exist. Duplicates are kept, so this hydrates queues and playlists as they are.
 *
 * A track's `album` is the album passed with it; else the album of one of its present
 * files; else the album of its first release track. `disc` and `position` are its place
 * on that album, preferring the canonical release.
 */
export async function trackSummaries(userId: string, refs: readonly TrackRef[]): Promise<TrackSummary[]> {
  return (await alignedTrackSummaries(userId, refs)).filter((summary) => summary !== null)
}

/** `trackSummaries`, but with null in place of each id that does not exist, so results line up with `refs`. */
export async function alignedTrackSummaries(userId: string, refs: readonly TrackRef[]): Promise<(TrackSummary | null)[]> {
  if (refs.length === 0) return []
  const [recordingIds, albumIds] = await Promise.all([
    resolveMerged('recordings', refs.map((ref) => ref.id)),
    resolveMerged('albums', refs.flatMap((ref) => ref.albumId ? [ref.albumId] : [])),
  ])
  const resolved = refs.map((ref) => {
    const id = recordingIds.get(ref.id)
    return id ? { id, albumId: ref.albumId ? albumIds.get(ref.albumId) ?? null : null } : null
  })
  const known = resolved.filter((ref) => ref !== null)
  if (known.length === 0) return resolved.map(() => null)

  const pairs = [...new Map(known.map((ref) => [`${ref.id}|${ref.albumId ?? ''}`, ref])).values()]
  const ids = [...new Set(pairs.map((pair) => pair.id))]
  const [rows, artists, liked, availability] = await Promise.all([
    db.execute<TrackRow>(sql`
      select req.id, req.album_id as "albumContext", r.mbid, r.title, r.artist_credit as "artistCredit",
        r.primary_artist_id as "primaryArtistId", coalesce(r.duration_ms, place.duration_ms, 0) as "durationMs",
        r.explicit,
        exists (select 1 from lyrics l where l.recording_id = r.id and (l.synced is not null or l.plain is not null)) as "hasLyrics",
        al.id as "albumId", al.title as "albumTitle", place.disc, place.position,
        art.id as "artworkId", art.color as "artworkColor", art.thumbhash as "artworkThumbhash"
      from unnest(${uuidArray(pairs.map((pair) => pair.id))}, ${uuidArray(pairs.map((pair) => pair.albumId))}) as req(id, album_id)
      join recordings r on r.id = req.id
      left join lateral (
        select candidate.album_id from (
          select context.id as album_id, 0 as rank, null::uuid as tiebreak from albums context where context.id = req.album_id
          union all
          select f.album_id, 1, f.id from media_files f
          where f.recording_id = r.id and f.missing_since is null and f.album_id is not null
          union all
          select rl.album_id, 2, rt.id from release_tracks rt join releases rl on rl.id = rt.release_id
          where rt.recording_id = r.id
        ) candidate
        order by candidate.rank, candidate.tiebreak limit 1
      ) chosen on true
      left join albums al on al.id = chosen.album_id
      left join assets art on art.id = al.artwork_asset_id
      left join lateral (
        select rt.disc, rt.position, rt.duration_ms from release_tracks rt join releases rl on rl.id = rt.release_id
        where rt.recording_id = r.id and rl.album_id = al.id
        order by (rl.id = al.canonical_release_id) is true desc, rt.id limit 1
      ) place on true`),
    credits('recording_artists', ids),
    db.execute<{ id: string }>(sql`
      select entity_id as id from likes
      where user_id = ${userId} and entity_type = 'recording' and entity_id = any(${uuidArray(ids)})`),
    trackAvailability(ids),
  ])

  const likedIds = new Set(liked.map((row) => row.id))
  const byPair = new Map(rows.map((row) => [`${row.id}|${row.albumContext ?? ''}`, row]))
  return resolved.map((ref): TrackSummary | null => {
    const row = ref && byPair.get(`${ref.id}|${ref.albumId ?? ''}`)
    if (!row) return null
    return {
      id: row.id,
      mbid: row.mbid,
      title: row.title,
      artistCredit: row.artistCredit,
      artists: artistsOf(artists, row.id, row.primaryArtistId, row.artistCredit),
      durationMs: row.durationMs,
      album: row.albumId ? { id: row.albumId, title: row.albumTitle!, artwork: artwork(row) } : null,
      disc: row.disc,
      position: row.position,
      availability: availability.get(row.id) ?? 'none',
      liked: likedIds.has(row.id),
      explicit: row.explicit,
      hasLyrics: row.hasLyrics,
    }
  })
}

type AlbumRow = ArtworkColumns & {
  id: string
  mbid: string | null
  title: string
  artistCredit: string
  primaryArtistId: string | null
  year: number | null
  type: AlbumSummary['type']
}

const albumTypes = new Set<string>(['album', 'ep', 'single', 'compilation', 'live', 'soundtrack', 'other'])

/** Summaries of albums (release groups), in input order, with availability and track counts. */
export async function albumSummaries(albumIds: readonly string[]): Promise<AlbumSummary[]> {
  const resolved = await resolveMerged('albums', albumIds)
  const ids = [...new Set(resolved.values())]
  if (ids.length === 0) return []
  const [rows, artists, availability] = await Promise.all([
    db.execute<AlbumRow>(sql`
      select a.id, a.mbid, a.title, a.artist_credit as "artistCredit", a.primary_artist_id as "primaryArtistId",
        a.year, a.type, art.id as "artworkId", art.color as "artworkColor", art.thumbhash as "artworkThumbhash"
      from albums a left join assets art on art.id = a.artwork_asset_id
      where a.id = any(${uuidArray(ids)})`),
    credits('album_artists', ids),
    albumAvailability(ids),
  ])
  const byId = new Map(rows.map((row) => [row.id, row]))
  return albumIds.flatMap((input) => {
    const row = byId.get(resolved.get(input) ?? '')
    if (!row) return []
    const counts = availability.get(row.id) ?? { availability: 'none' as const, trackCount: 0, ownedTrackCount: 0 }
    return [{
      id: row.id,
      mbid: row.mbid,
      title: row.title,
      artistCredit: row.artistCredit,
      artists: artistsOf(artists, row.id, row.primaryArtistId, row.artistCredit),
      year: row.year,
      type: albumTypes.has(row.type) ? row.type : 'other',
      artwork: artwork(row),
      ...counts,
    }]
  })
}

/**
 * Summaries of artists, in input order. `inLibrary` is true when a present file's
 * recording credits the artist, or the artist is credited on an album with a present file.
 */
export async function artistSummaries(artistIds: readonly string[]): Promise<ArtistSummary[]> {
  const resolved = await resolveMerged('artists', artistIds)
  const ids = [...new Set(resolved.values())]
  if (ids.length === 0) return []
  const rows = await db.execute<ArtworkColumns & { id: string; mbid: string | null; name: string; inLibrary: boolean }>(sql`
    select a.id, a.mbid, a.name,
      art.id as "artworkId", art.color as "artworkColor", art.thumbhash as "artworkThumbhash",
      (exists (select 1 from recording_artists ra where ra.artist_id = a.id and ${recordingOwned('ra.recording_id')})
        or exists (
          select 1 from album_artists aa join media_files f on f.album_id = aa.album_id and f.missing_since is null
          where aa.artist_id = a.id
        )) as "inLibrary"
    from artists a left join assets art on art.id = a.image_asset_id
    where a.id = any(${uuidArray(ids)})`)
  const byId = new Map(rows.map((row) => [row.id, row]))
  return artistIds.flatMap((input) => {
    const row = byId.get(resolved.get(input) ?? '')
    return row ? [{ id: row.id, mbid: row.mbid, name: row.name, image: artwork(row), inLibrary: row.inLibrary }] : []
  })
}
