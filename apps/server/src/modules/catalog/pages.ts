/** Artist, album and track pages. Ids from clients may be stale; each page follows merge redirects. */
import {
  ARTIST_SECTION_KEYS, ARTIST_SECTION_PREVIEW,
  type AlbumDetail, type AlbumDisc, type AlbumPage, type ArtistDetail, type ArtistReleasesQuery, type ArtistSection, type ArtistSectionKey, type Lyrics, type TrackSummary,
} from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'
import { queueAlbumResolve } from '../acquisition/coverage.js'
import { ensureAlbumDetail, ensureArtistDetail, ensureLyrics } from '../enrichment/detail.js'
import { specialPurposeArtists } from '../metadata/musicbrainz.js'
import { canStartArtistRadio, similarArtists } from '../radio/index.js'
import { editionFreeTitle, labelFreeKey, prefixEnd, printedTitleKey, releaseKey } from '../search/keys.js'
import { canonicalRelease, collectionCounts, collectionFile } from './availability.js'
import { cleanTrackList } from './explicit.js'
import { resolveOne } from './redirects.js'
import { alignedTrackSummaries, albumSummaries, artistSummaries, trackSummaries } from './summaries.js'

const TOP_TRACKS = 10
const SIMILAR = 10

type DiscographyRow = {
  id: string
  title: string
  type: string
  typeGuessed: boolean
  secondaryTypes: string[]
  hasMbid: boolean
  detailLevel: number
  year: number | null
  hasArtwork: boolean
  owned: boolean
  led: boolean
  /** No artist but the page's is credited on it. */
  soleCredit: boolean
  /** For an edition row (`albums.edition_of_id`), its release group's title: the two are one release. */
  releaseTitle?: string
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
  const keyOf = (row: DiscographyRow) => `${row.led}|${releaseKey(row.releaseTitle ?? row.title) || row.id}`
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

/** At most this many other versions on an album page. */
const VERSIONS = 20

type VersionRow = DiscographyRow & { sameGroup: boolean; trackCount: number }

/** Types two rows of one release can have: the same, or either a guess. */
const sameKind = (a: Pick<DiscographyRow, 'type' | 'typeGuessed'>, b: Pick<DiscographyRow, 'type' | 'typeGuessed'>) =>
  a.type === b.type || a.typeGuessed || b.typeGuessed

/**
 * Other versions of an album: the other editions of its release group (edition rows,
 * `albums.edition_of_id`: "SO CLOSE TO WHAT???" beside "So Close to What", and the group's
 * own row from one of them), and other rows of its lead artist that are the same release
 * by `releaseKey` and kind (a deluxe MusicBrainz lists as a group of its own, a store's
 * deluxe found by search). The artist page shows each release once (`standingRows`), so
 * clients cannot find these in the discography.
 *
 * Each edition once: of rows with the same name (`labelFreeKey`), kind and track count
 * (or no track list yet), the one that stands for it (`standsBefore`), and a row with no
 * track list yet gives way to an edition row titled as it is without edition words; the
 * album itself stands for its own. The group's own row first, then by date.
 */
export async function albumVersionIds(albumId: string): Promise<string[]> {
  const [self] = await db.execute<{ group: string; groupTitle: string; title: string; primaryArtistId: string | null }>(sql`
    select coalesce(g.id, a.id) as group, coalesce(g.title, a.title) as "groupTitle", a.title, a.primary_artist_id as "primaryArtistId"
    from albums a left join albums g on g.id = a.edition_of_id and g.merged_into_id is null where a.id = ${albumId}`)
  if (!self) return []
  const key = releaseKey(self.groupTitle)
  const byArtist = self.primaryArtistId && key
    ? sql`or (a.primary_artist_id = ${self.primaryArtistId} and a.title_key collate "C" >= ${key} and a.title_key collate "C" < ${prefixEnd(key)})`
    : sql``
  const rows = await db.execute<VersionRow>(sql`
    select a.id, a.title, g.title as "releaseTitle", a.type, a.type_guessed as "typeGuessed", a.secondary_types as "secondaryTypes",
      a.mbid is not null as "hasMbid", a.detail_level as "detailLevel", a.year, a.artwork_asset_id is not null as "hasArtwork",
      exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null) as owned, true as led, true as "soleCredit",
      coalesce(a.edition_of_id, a.id) = ${self.group} as "sameGroup",
      coalesce((select rl.track_count from releases rl where rl.id = ${canonicalRelease('a')}), 0) as "trackCount"
    from albums a left join albums g on g.id = a.edition_of_id
    where a.merged_into_id is null and (a.id = ${self.group} or a.edition_of_id = ${self.group} or a.id = ${albumId} ${byArtist})
    order by coalesce(a.release_date, a.year::text) nulls last, a.title_key, a.id
    limit 500`)
  const album = rows.find((row) => row.id === albumId)
  if (!album) return []
  const candidates = rows.filter((row) => row.id !== albumId
    && (row.sameGroup || (releaseKey(row.releaseTitle ?? row.title) === key && sameKind(row, album))))
  const kept: VersionRow[] = [album]
  // A row with no track list yet is the edition row of its title less edition words: a
  // store's "SO CLOSE TO WHAT??? (deluxe)" found by search is "SO CLOSE TO WHAT???".
  const editionTitle = (row: VersionRow) => printedTitleKey(editionFreeTitle(row.title))
  const sameEdition = (row: VersionRow, kept: VersionRow) => sameKind(row, kept) && (
    (labelFreeKey(row.title) === labelFreeKey(kept.title) && (row.trackCount === kept.trackCount || row.trackCount === 0 || kept.trackCount === 0))
    || (row.trackCount === 0 && kept.releaseTitle != null && editionTitle(row) === editionTitle(kept)))
  for (const row of [...candidates].sort(standsBefore)) {
    if (!kept.some((other) => sameEdition(row, other))) kept.push(row)
  }
  const shown = new Set(kept.slice(1).map((row) => row.id))
  return candidates.filter((row) => shown.has(row.id))
    .sort((a, b) => Number(b.id === self.group) - Number(a.id === self.group))
    .slice(0, VERSIONS)
    .map((row) => row.id)
}

/**
 * The album page: its summary plus the album's track list (`albumTrackList`) grouped by
 * disc, every track with its own availability, whether and why the album is in the
 * user's library, and its other versions (`albumVersionIds`). Fetches missing detail first.
 */
export async function albumDetail(userId: string, id: string): Promise<AlbumDetail> {
  const settled = await ensureAlbumDetail(await resolveOrThrow('albums', id, 'album'))
  // Completing a stub may merge it into the album's existing row.
  const albumId = await resolveOrThrow('albums', id, 'album')
  const [[summary], [extra], tracks, { wantlistEnabled }, versions] = await Promise.all([
    albumSummaries([albumId]),
    db.execute<{
      releaseDate: string | null; genres: string[]; description: string | null; label: string | null; liked: boolean; wanted: boolean
      library: 'collection' | 'saved' | null
    }>(sql`
      select coalesce(rl.release_date, a.release_date) as "releaseDate", a.genres, a.description, rl.label,
        exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'album' and l.entity_id = a.id) as liked,
        exists (select 1 from wants w where w.user_id = ${userId} and w.entity_type = 'album' and w.entity_id = a.id and w.fulfilled_at is null) as wanted,
        -- A collection album is in the library of everyone the collection counts for; the
        -- heart (liked) shows the viewer's own save.
        case
          when ${collectionCounts(userId)} and exists (select 1 from media_files f where f.album_id = a.id and ${collectionFile('f')}) then 'collection'
          when exists (select 1 from likes li where li.user_id = ${userId} and li.entity_type = 'album' and li.entity_id = a.id) then 'saved'
        end as library
      from albums a left join releases rl on rl.id = ${canonicalRelease('a')}
      where a.id = ${albumId}`),
    albumTrackList(albumId),
    getServerSettings(),
    albumVersionIds(albumId).then(albumSummaries),
  ])
  if (!summary || !extra) throw notFound('No such album', 'album_not_found')

  // Clean versions stand in for explicit songs for a user who has explicit content off.
  const summaries = await cleanTrackList(userId, await alignedTrackSummaries(userId, tracks.map((track) => ({ id: track.recordingId, albumId }))), albumId)
  await queueAlbumResolve(summaries.flatMap((track) => track?.availability === 'on_demand' ? [track.id] : []), albumId)
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
  return { ...summary, ...extra, wanted: wantlistEnabled && extra.wanted, durationMs, discs, versions, ...(settled ? {} : { detailPending: true as const }) }
}

/** Headings of the artist page's sections, for clients that do not know a key. */
const sectionTitles: Record<ArtistSectionKey, string> = {
  album: 'Albums', mixtape: 'Mixtapes', ep: 'EPs', single: 'Singles', live: 'Live albums', compilation: 'Compilations',
  soundtrack: 'Soundtracks', other: 'Other releases', appears_on: 'Appears on',
}

const hasSecondary = (row: DiscographyRow, type: string) => row.secondaryTypes.some((one) => one.toLowerCase() === type)

/**
 * A soundtrack that is a studio album of the artist alone: no secondary type but
 * Soundtrack (not a compilation, remix or live record of a film's music) and no other
 * artist credited (not The Lion King for Elton John, shared with Tim Rice and Hans Zimmer).
 */
const studioSoundtrack = (row: DiscographyRow) =>
  row.type === 'soundtrack' && row.soleCredit && row.secondaryTypes.every((one) => one.toLowerCase() === 'soundtrack')

/**
 * The section each release of the page is listed under: its type's, with these exceptions.
 * Releases of others are "Appears on". Mixtapes (MusicBrainz's "Mixtape/Street") are
 * albums by type but listed apart, as stores do. A studio soundtrack of the artist alone
 * (`studioSoundtrack`) is listed under Albums when the artist's albums outnumber such
 * soundtracks: The Beatles' Help! and Yellow Submarine are among their albums, Hans
 * Zimmer's scores are his soundtracks. Never for a placeholder artist (Various Artists): its
 * releases credit it alone only because MusicBrainz has no one to name, so its soundtracks
 * (GTA, Cyberpunk 2077, Sing) are soundtracks. Every other soundtrack is under Soundtracks. A
 * single or EP from a film is typed single or EP to begin with (`musicbrainz.albumType`).
 */
export function sectionOf(rows: readonly DiscographyRow[], { placeholder = false }: { placeholder?: boolean } = {}): (row: DiscographyRow) => ArtistSectionKey {
  const led = rows.filter((row) => row.led)
  const studio = led.filter(studioSoundtrack).length
  const albums = led.filter((row) => row.type === 'album').length
  const studioSoundtracksAreAlbums = !placeholder && studio > 0 && studio < albums
  return (row) => {
    if (!row.led) return 'appears_on'
    if (row.type === 'album' && hasSecondary(row, 'mixtape/street')) return 'mixtape'
    if (studioSoundtracksAreAlbums && studioSoundtrack(row)) return 'album'
    return (ARTIST_SECTION_KEYS as readonly string[]).includes(row.type) ? row.type as ArtistSectionKey : 'other'
  }
}

/**
 * An artist's discography as the page lists it: the releases the artist leads (primary
 * artist or first credit) and those of others that credit it, on the release or on a track
 * of one of its editions ("Appears on"), newest first, each release once (`standingRows`),
 * with the section of each.
 */
async function discography(artistId: string): Promise<{ rows: DiscographyRow[]; section: (row: DiscographyRow) => ArtistSectionKey }> {
  const [artist] = await db.execute<{ mbid: string | null }>(sql`select mbid from artists where id = ${artistId}`)
  const rows = await db.execute<DiscographyRow>(sql`
    select a.id, a.title, (select g.title from albums g where g.id = a.edition_of_id) as "releaseTitle",
      a.type, a.type_guessed as "typeGuessed", a.secondary_types as "secondaryTypes", a.mbid is not null as "hasMbid",
      a.detail_level as "detailLevel", a.year, a.artwork_asset_id is not null as "hasArtwork",
      exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null) as owned,
      a.primary_artist_id = ${artistId} or exists (
        select 1 from album_artists lead where lead.album_id = a.id and lead.position = 0 and lead.artist_id = ${artistId}) as led,
      not exists (select 1 from album_artists other where other.album_id = a.id and other.artist_id <> ${artistId}) as "soleCredit"
    from albums a
    where a.merged_into_id is null
      -- Credited, or led without credit rows (the summary then credits the primary artist),
      -- or featured on a track of one of its editions.
      and a.id in (
        select aa.album_id from album_artists aa where aa.artist_id = ${artistId}
        union select led.id from albums led where led.primary_artist_id = ${artistId}
        union select rl.album_id from recording_artists ra
          join release_tracks rt on rt.recording_id = ra.recording_id
          join releases rl on rl.id = rt.release_id
          where ra.artist_id = ${artistId}
      )
    -- Many rows know only a year (catalog stubs, tags with a year). A full date and a
    -- bare year compare as text, so '2020' still sorts above '2001-05-01'.
    order by coalesce(a.release_date, a.year::text) desc nulls last, a.year desc nulls last, a.title_key, a.id`)
  const standing = standingRows(rows, { fromMusicBrainz: Boolean(artist?.mbid) })
  return { rows: standing, section: sectionOf(standing, { placeholder: Boolean(artist?.mbid && specialPurposeArtists.has(artist.mbid)) }) }
}

/**
 * The artist page: profile, the release sections (the first `ARTIST_SECTION_PREVIEW` of
 * each, with counts; `artistReleases` pages the rest), top tracks, and similar artists
 * from the radio module, which also says whether an artist radio would start. Fetches
 * missing detail first.
 *
 * Top tracks are the artist's stored list (`artist_top_tracks`) in its order; an artist
 * without one (music only in the library) ranks its tracks by completed plays on this
 * server, then popularity. MusicBrainz's placeholders (Various Artists) have none, no
 * radio, no similar artists and no profile beyond the name: they stand for no one in particular.
 */
export async function artistDetail(userId: string, id: string): Promise<ArtistDetail> {
  const settled = await ensureArtistDetail(await resolveOrThrow('artists', id, 'artist'))
  const artistId = await resolveOrThrow('artists', id, 'artist')
  const [artist] = await db.execute<{ mbid: string | null }>(sql`select mbid::text as mbid from artists where id = ${artistId}`)
  const placeholder = Boolean(artist?.mbid && specialPurposeArtists.has(artist.mbid))
  const [[summary], [profile], { rows, section }, top, similar, radio, composed] = await Promise.all([
    artistSummaries([artistId], userId),
    db.execute<{ sortName: string | null; disambiguation: string | null; bio: string | null; bioUrl: string | null; genres: string[]; liked: boolean }>(sql`
      select a.sort_name as "sortName", a.disambiguation, a.bio, a.bio_url as "bioUrl", a.genres,
        exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'artist' and l.entity_id = a.id) as liked
      from artists a where a.id = ${artistId}`),
    discography(artistId),
    placeholder ? [] : topTrackIds(artistId),
    placeholder ? [] : similarArtists(artistId, { limit: SIMILAR }).then((found) => artistSummaries(found.map((row) => row.artistId), userId)),
    placeholder ? false : canStartArtistRadio(userId, artistId),
    placeholder ? [] : composedOrProducedIds(artistId),
  ])
  if (!summary || !profile) throw notFound('No such artist', 'artist_not_found')
  // Nor a bio, genres or disambiguation: MusicBrainz's is a note to its editors ("add
  // compilations to this artist") and Wikipedia's article is about compilation albums.
  if (placeholder) Object.assign(profile, { disambiguation: null, bio: null, bioUrl: null, genres: [] })

  const bySection = new Map<ArtistSectionKey, DiscographyRow[]>()
  for (const row of rows) {
    const key = section(row)
    const list = bySection.get(key)
    if (list) list.push(row)
    else bySection.set(key, [row])
  }
  const keys = ARTIST_SECTION_KEYS.filter((key) => bySection.has(key))
  const previewed = new Set(keys.flatMap((key) => bySection.get(key)!.slice(0, ARTIST_SECTION_PREVIEW).map((row) => row.id)))
  const shown = rows.filter((row) => previewed.has(row.id))
  const [summaries, topTracks, composedOrProduced] = await Promise.all([
    albumSummaries(shown.map((row) => row.id)),
    trackSummaries(userId, top.map((trackId) => ({ id: trackId }))),
    trackSummaries(userId, composed.map((id) => ({ id }))),
  ])
  const byId = new Map(summaries.map((album) => [album.id, album]))
  const sections: ArtistSection[] = keys.map((key) => ({
    key,
    title: sectionTitles[key],
    total: bySection.get(key)!.length,
    items: bySection.get(key)!.slice(0, ARTIST_SECTION_PREVIEW).flatMap((row) => byId.get(row.id) ?? []),
  }))
  const led = rows.filter((row) => row.led)
  // Older clients read `albums` and `appearsOn`: the same previews, newest first.
  const albums = shown.filter((row) => row.led).flatMap((row) => byId.get(row.id) ?? [])
  const appearsOn = shown.filter((row) => !row.led).flatMap((row) => byId.get(row.id) ?? [])
  return {
    ...summary,
    ...profile,
    topTracks,
    ...(composedOrProduced.length ? { composedOrProduced } : {}),
    albums,
    appearsOn,
    sections,
    releaseCount: led.length,
    ownedReleaseCount: led.filter((row) => row.owned).length,
    similar,
    radio,
    ...(settled ? {} : { detailPending: true as const }),
  }
}

async function composedOrProducedIds(artistId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    with contributions as (
      select rc.recording_id, rc.role from recording_credits rc
      where rc.artist_id = ${artistId} and rc.recording_id is not null
      union all
      select f.recording_id, rc.role from recording_credits rc
      join media_files f on f.id = rc.file_id
      where rc.artist_id = ${artistId} and f.recording_id is not null and f.missing_since is null
    )
    select r.id from recordings r
    join (
      select recording_id from contributions group by recording_id
      having bool_or(role in ('composer', 'producer')) and not bool_or(role in ('performer', 'ensemble'))
    ) c on c.recording_id = r.id
    where r.merged_into_id is null and r.primary_artist_id is distinct from ${artistId}
      and not exists (select 1 from recording_artists ra where ra.recording_id = r.id and ra.artist_id = ${artistId})
    order by exists (select 1 from media_files f where f.recording_id = r.id and f.missing_since is null) desc,
      r.title_key, r.id
    limit ${ARTIST_SECTION_PREVIEW}`)
  return rows.map(({ id }) => id)
}

/**
 * The artist's top tracks: its stored list in rank order (rows merged since followed to
 * the row they became, a title listed twice shown once), else its tracks ranked by
 * completed plays on this server, then popularity.
 */
async function topTrackIds(artistId: string): Promise<string[]> {
  const listed = await db.execute<{ id: string; titleKey: string }>(sql`
    select coalesce(r.merged_into_id, r.id) as id, r.title_key as "titleKey" from artist_top_tracks t
    join recordings r on r.id = t.recording_id
    -- A list stored under a row merged into this one counts until the artist is fetched again.
    where t.artist_id in (select ${artistId}::uuid union select id from artists where merged_into_id = ${artistId})
    order by t.artist_id = ${artistId} desc, t.position`)
  if (listed.length > 0) {
    const seen = new Set<string>()
    const ids: string[] = []
    for (const row of listed) {
      if (seen.has(row.id) || seen.has(`title:${row.titleKey}`)) continue
      seen.add(row.id)
      seen.add(`title:${row.titleKey}`)
      ids.push(row.id)
      if (ids.length === TOP_TRACKS) break
    }
    return ids
  }
  const rows = await db.execute<{ id: string }>(sql`
    select r.id from recordings r
    where r.merged_into_id is null
      and r.id in (
        select ra.recording_id from recording_artists ra where ra.artist_id = ${artistId}
        union select led.id from recordings led where led.primary_artist_id = ${artistId}
      )
    order by (select count(*) from plays p where p.recording_id = r.id and p.completed) desc,
      r.popularity desc nulls last, r.title_key, r.id
    limit ${TOP_TRACKS}`)
  return rows.map((row) => row.id)
}

/** A cursor into one section of an artist page: the id of the last release listed. */
const ReleasesCursor = z.object({ s: z.string(), id: z.uuid() })

function invalidCursor() {
  return badRequest('The cursor is not valid for this list', 'invalid_cursor')
}

/**
 * One section of an artist page, paged ("See all"): `limit` releases newest first, in the
 * page's order. The cursor names the last release listed, so a page continues after it
 * however many releases the discography gained meanwhile; one merged away since is
 * followed to the row it became. Does not fetch detail: the artist page did.
 */
export async function artistReleases(id: string, query: ArtistReleasesQuery): Promise<AlbumPage> {
  const artistId = await resolveOrThrow('artists', id, 'artist')
  const { rows, section } = await discography(artistId)
  const listed = rows.filter((row) => section(row) === query.section)
  let start = 0
  if (query.cursor) {
    let cursor: z.infer<typeof ReleasesCursor>
    try {
      cursor = ReleasesCursor.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')))
    } catch {
      throw invalidCursor()
    }
    if (cursor.s !== query.section) throw invalidCursor()
    const last = await resolveOne('albums', cursor.id)
    const index = listed.findIndex((row) => row.id === last)
    // A release that left the section (retyped, merged elsewhere) ends the list rather than restarting it.
    start = index === -1 ? listed.length : index + 1
  }
  const slice = listed.slice(start, start + query.limit)
  const items = await albumSummaries(slice.map((row) => row.id))
  const more = start + query.limit < listed.length
  const nextCursor = more ? Buffer.from(JSON.stringify({ s: query.section, id: slice.at(-1)!.id })).toString('base64url') : null
  return { items, nextCursor }
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
