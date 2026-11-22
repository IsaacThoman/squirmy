/** Artist, album and track pages. Ids from clients may be stale; each page follows merge redirects. */
import type { AlbumDetail, AlbumDisc, ArtistDetail, Lyrics, TrackSummary } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { notFound } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'
import { ensureAlbumDetail, ensureArtistDetail, ensureLyrics } from '../enrichment/detail.js'
import { canStartArtistRadio, similarArtists } from '../radio/index.js'
import { releaseKey } from '../search/keys.js'
import { canonicalRelease, collectionFile } from './availability.js'
import { resolveOne } from './redirects.js'
import { alignedTrackSummaries, albumSummaries, artistSummaries, trackSummaries } from './summaries.js'

const TOP_TRACKS = 10
const SIMILAR = 10

type DiscographyRow = {
  id: string
  title: string
  type: string
  typeGuessed: boolean
  hasMbid: boolean
  detailLevel: number
  year: number | null
  hasArtwork: boolean
  owned: boolean
  led: boolean
}

/** Which of two rows of one release stands for it on the page: owned, MusicBrainz, a stated type, detail, a cover, the earlier year. */
function standsBefore(a: DiscographyRow, b: DiscographyRow): number {
  const score = (row: DiscographyRow) => [row.owned ? 0 : 1, row.hasMbid ? 0 : 1, row.typeGuessed ? 1 : 0, -row.detailLevel, row.hasArtwork ? 0 : 1, row.year ?? 9999]
  const left = score(a)
  const right = score(b)
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index]! - right[index]!
  return a.id < b.id ? -1 : 1
}

/**
 * An artist's discography with each release once, in the given order. Rows of one release
 * (the same `releaseKey` and type: two MusicBrainz groups of one title, a deluxe group
 * beside the standard one) show as the row that stands for it; a row whose type is only a
 * guess gives way to any row of its title. The enrichment module merges such rows where it
 * can (`enrichment/reconcile.ts`); this keeps the page right meanwhile, and where two
 * MusicBrainz groups stay two rows.
 *
 * With `fromMusicBrainz` (the artist has an MBID, so its discography is MusicBrainz's
 * official one) a row known only as a popular song's album, with a guessed type and no
 * files, is left out altogether: it is a release MusicBrainz does not list for the artist,
 * mostly another artist's compilation or soundtrack. Its songs still show it.
 */
export function standingRows(rows: readonly DiscographyRow[], { fromMusicBrainz = false } = {}): DiscographyRow[] {
  const best = new Map<string, DiscographyRow>()
  const stated = new Set<string>()
  const keyOf = (row: DiscographyRow) => `${row.led}|${releaseKey(row.title) || row.id}`
  for (const row of rows) {
    if (!row.typeGuessed) stated.add(keyOf(row))
    const key = `${keyOf(row)}|${row.typeGuessed ? '?' : row.type}`
    const current = best.get(key)
    if (!current || standsBefore(row, current) < 0) best.set(key, row)
  }
  const shown = new Set([...best.values()]
    .filter((row) => !row.typeGuessed || (!stated.has(keyOf(row)) && !(fromMusicBrainz && !row.hasMbid && !row.owned)))
    .map((row) => row.id))
  return rows.filter((row) => shown.has(row.id))
}

async function resolveOrThrow(table: 'artists' | 'albums' | 'recordings', id: string, what: 'artist' | 'album' | 'track') {
  const resolved = await resolveOne(table, id)
  if (!resolved) throw notFound(`No such ${what}`, `${what}_not_found`)
  return resolved
}

export type AlbumTrack = { recordingId: string; disc: number; position: number | null; discTitle: string | null }

/**
 * The album's track list, the one every view of an album uses: the canonical release's
 * tracks in disc and track order, then owned recordings filed under the album that are
 * not on that release (bonus tracks of another edition, files matching attached with no
 * track), in path order on the last disc. Those have no position: the release does not
 * number them, and a number from their tags could repeat one of its own.
 */
export async function albumTrackList(albumId: string): Promise<AlbumTrack[]> {
  return db.execute<AlbumTrack>(sql`
    with canonical as (
      select rt.recording_id, rt.disc, rt.position, rt.disc_title
      from albums a join release_tracks rt on rt.release_id = ${canonicalRelease('a')}
      where a.id = ${albumId}
    ),
    extras as (
      select f.recording_id, min(f.rel_path collate "C") as first_path from media_files f
      where f.album_id = ${albumId} and f.recording_id is not null and f.missing_since is null
        and f.recording_id not in (select recording_id from canonical)
      group by f.recording_id
    )
    select "recordingId", disc, position, "discTitle" from (
      select recording_id as "recordingId", disc, position, disc_title as "discTitle", 0 as part, null as first_path from canonical
      union all
      select recording_id, coalesce((select max(disc) from canonical), 1), null, null, 1, first_path from extras
    ) list
    order by part, disc, position, first_path, "recordingId"`)
}

/**
 * The album page: its summary plus the album's track list (`albumTrackList`) grouped by
 * disc, every track with its own availability, and whether and why the album is in the
 * user's library. Fetches missing detail first.
 */
export async function albumDetail(userId: string, id: string): Promise<AlbumDetail> {
  const settled = await ensureAlbumDetail(await resolveOrThrow('albums', id, 'album'))
  // Completing a stub may merge it into the album's existing row.
  const albumId = await resolveOrThrow('albums', id, 'album')
  const [[summary], [extra], tracks, { wantlistEnabled }] = await Promise.all([
    albumSummaries([albumId]),
    db.execute<{
      releaseDate: string | null; genres: string[]; description: string | null; label: string | null; liked: boolean; wanted: boolean
      library: 'collection' | 'saved' | null
    }>(sql`
      select coalesce(rl.release_date, a.release_date) as "releaseDate", a.genres, a.description, rl.label,
        exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'album' and l.entity_id = a.id) as liked,
        exists (select 1 from wants w where w.user_id = ${userId} and w.entity_type = 'album' and w.entity_id = a.id and w.fulfilled_at is null) as wanted,
        -- A collection album is everyone's; the heart (liked) shows the viewer's own save.
        case
          when exists (select 1 from media_files f where f.album_id = a.id and ${collectionFile('f')}) then 'collection'
          when exists (select 1 from likes li where li.user_id = ${userId} and li.entity_type = 'album' and li.entity_id = a.id) then 'saved'
        end as library
      from albums a left join releases rl on rl.id = ${canonicalRelease('a')}
      where a.id = ${albumId}`),
    albumTrackList(albumId),
    getServerSettings(),
  ])
  if (!summary || !extra) throw notFound('No such album', 'album_not_found')

  const summaries = await alignedTrackSummaries(userId, tracks.map((track) => ({ id: track.recordingId, albumId })))
  const discs: AlbumDisc[] = []
  for (const [index, track] of tracks.entries()) {
    const summary = summaries[index]
    if (!summary) continue
    let disc = discs.at(-1)
    if (disc?.disc !== track.disc) {
      disc = { disc: track.disc, title: null, tracks: [] }
      discs.push(disc)
    }
    disc.title ??= track.discTitle
    // A recording can appear twice on one release; each row keeps its own place.
    disc.tracks.push({ ...summary, disc: track.disc, position: track.position })
  }
  const durationMs = discs.reduce((total, disc) => total + disc.tracks.reduce((sum, track) => sum + track.durationMs, 0), 0)
  // A switched-off wantlist keeps its rows but marks nothing as wanted.
  return { ...summary, ...extra, wanted: wantlistEnabled && extra.wanted, durationMs, discs, ...(settled ? {} : { detailPending: true as const }) }
}

/**
 * The artist page: profile, the albums the artist leads and those of others that credit it
 * (newest first, each release once, `standingRows`), and
 * top tracks ranked by completed plays on this server, then popularity, and similar
 * artists from the radio module, which also says whether an artist radio would start.
 * Fetches missing detail first.
 */
export async function artistDetail(userId: string, id: string): Promise<ArtistDetail> {
  const settled = await ensureArtistDetail(await resolveOrThrow('artists', id, 'artist'))
  const artistId = await resolveOrThrow('artists', id, 'artist')
  const [artist] = await db.execute<{ hasMbid: boolean }>(sql`select mbid is not null as "hasMbid" from artists where id = ${artistId}`)
  const hasMbid = artist?.hasMbid ?? false
  const [[summary], [profile], albums, top, similar, radio] = await Promise.all([
    artistSummaries([artistId], userId),
    db.execute<{ sortName: string | null; disambiguation: string | null; bio: string | null; bioUrl: string | null; genres: string[]; liked: boolean }>(sql`
      select a.sort_name as "sortName", a.disambiguation, a.bio, a.bio_url as "bioUrl", a.genres,
        exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'artist' and l.entity_id = a.id) as liked
      from artists a where a.id = ${artistId}`),
    db.execute<DiscographyRow>(sql`
      select a.id, a.title, a.type, a.type_guessed as "typeGuessed", a.mbid is not null as "hasMbid", a.detail_level as "detailLevel",
        a.year, a.artwork_asset_id is not null as "hasArtwork",
        exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null) as owned,
        a.primary_artist_id = ${artistId} or exists (
          select 1 from album_artists lead where lead.album_id = a.id and lead.position = 0 and lead.artist_id = ${artistId}) as led
      from albums a
      where a.merged_into_id is null
        -- Credited, or led without credit rows (the summary then credits the primary artist).
        and a.id in (
          select aa.album_id from album_artists aa where aa.artist_id = ${artistId}
          union select led.id from albums led where led.primary_artist_id = ${artistId}
        )
      -- Many rows know only a year (catalog stubs, tags with a year). A full date and a
      -- bare year compare as text, so '2020' still sorts above '2001-05-01'.
      order by coalesce(a.release_date, a.year::text) desc nulls last, a.year desc nulls last, a.title_key, a.id`)
      .then((rows) => standingRows(rows, { fromMusicBrainz: hasMbid })),
    db.execute<{ id: string }>(sql`
      select r.id from recordings r
      where r.merged_into_id is null
        and r.id in (
          select ra.recording_id from recording_artists ra where ra.artist_id = ${artistId}
          union select led.id from recordings led where led.primary_artist_id = ${artistId}
        )
      order by (select count(*) from plays p where p.recording_id = r.id and p.completed) desc,
        r.popularity desc nulls last, r.title_key, r.id
      limit ${TOP_TRACKS}`),
    similarArtists(artistId, { limit: SIMILAR }).then((rows) => artistSummaries(rows.map((row) => row.artistId), userId)),
    canStartArtistRadio(userId, artistId),
  ])
  if (!summary || !profile) throw notFound('No such artist', 'artist_not_found')
  const [albumList, appearsOn, topTracks] = await Promise.all([
    albumSummaries(albums.filter((row) => row.led).map((row) => row.id)),
    albumSummaries(albums.filter((row) => !row.led).map((row) => row.id)),
    trackSummaries(userId, top.map((row) => ({ id: row.id }))),
  ])
  return { ...summary, ...profile, topTracks, albums: albumList, appearsOn, similar, radio, ...(settled ? {} : { detailPending: true as const }) }
}

/** One track, in the given album's context when there is one. */
export async function trackDetail(userId: string, id: string, albumId?: string): Promise<TrackSummary> {
  const [track] = await trackSummaries(userId, [{ id, albumId }])
  if (!track) throw notFound('No such track', 'track_not_found')
  return track
}

/** Stored lyrics, looked up first when the track has none yet. 404 `lyrics_not_found` when none are stored or the lookup found none. */
export async function trackLyrics(id: string): Promise<Lyrics> {
  const recordingId = await resolveOrThrow('recordings', id, 'track')
  await ensureLyrics(recordingId)
  const [row] = await db.execute<Lyrics>(sql`
    select recording_id as "trackId", synced, plain, instrumental, source from lyrics
    where recording_id = ${recordingId} and (synced is not null or plain is not null or instrumental)`)
  if (!row) throw notFound('No lyrics for this track', 'lyrics_not_found')
  return row
}
