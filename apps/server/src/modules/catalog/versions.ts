/**
 * Editions and versions (docs/architecture.md, "Editions and versions").
 *
 * An album is a release group; its releases are editions. A file's edition is its release
 * when that release has a MusicBrainz id, else the album's display release (its canonical
 * release): a track list built from tags, a store or deliveries shows the album as it is
 * shown, and is not an edition of its own. A *version* is an edition and a quality tier the
 * server holds present files of. Users pick which version of an album, or of one song,
 * plays by default (`version_picks`); the file choice of every playback path reads the
 * picks through `filePreferences` or `pickedFirst`.
 */
import { queryKeys, type AlbumVersion, type AudioTier, type TrackVersion, type TrackVersions, type VersionPickType } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { notFound } from '../../lib/errors.js'
import { invalidate } from '../../realtime/index.js'
import { codecFamily } from '../streaming/profiles.js'
import { canonicalRelease, canonicalReleaseText } from './availability.js'
import { resolveOne } from './redirects.js'
import { uuidArray } from './sql.js'

const tierRank: Record<AudioTier, number> = { hi_res_lossless: 0, lossless: 1, lossy: 2 }

/**
 * SQL for the tier of a `media_files` row (alias given): the line client-core's quality
 * badge draws, lossless above 48 kHz or 16 bits being hi-res.
 */
export function tierOf(file: string): SQL {
  return sql.raw(`(case when ${file}.lossless and (coalesce(${file}.sample_rate, 0) > 48000 or coalesce(${file}.bit_depth, 0) > 16) then 'hi_res_lossless'
    when ${file}.lossless then 'lossless' else 'lossy' end)`)
}

/**
 * SQL for the edition of a `media_files` row (alias given): its release when that has a
 * MusicBrainz id and is of the file's album, else the album's display release. Null for a
 * file on no album.
 */
export function editionOf(file: string): SQL {
  return sql.raw(`(case when exists (select 1 from releases own where own.id = ${file}.release_id and own.mbid is not null and own.album_id = ${file}.album_id)
    then ${file}.release_id
    else (select ${canonicalReleaseText('shown')} from albums shown where shown.id = ${file}.album_id) end)`)
}

export const versionId = (releaseId: string, tier: AudioTier) => `${releaseId}:${tier}`

export function parseVersionId(id: string): { releaseId: string; tier: AudioTier } {
  const [releaseId, tier] = id.split(':') as [string, AudioTier]
  return { releaseId, tier }
}

/**
 * SQL: whether a file (alias) is in the version the user picked for `kind`'s entity: the
 * song (`recording`, entity `entity`) or the file's own album (`album`).
 */
export function pickedBy(userId: string, kind: 'album' | 'recording', file: string, entity?: SQL): SQL {
  const entityId = kind === 'album' ? sql.raw(`${file}.album_id`) : entity!
  return sql`exists (select 1 from version_picks pick
    where pick.user_id = ${userId} and pick.entity_type = ${kind} and pick.entity_id = ${entityId}
      and pick.release_id = ${editionOf(file)} and pick.tier = ${tierOf(file)})`
}

type HeldFile = {
  id: string
  recordingId: string | null
  albumId: string | null
  releaseId: string | null
  edition: string | null
  tier: AudioTier
  codec: string
  container: string
  relPath: string
  sampleRate: number | null
  bitDepth: number | null
  bitrate: number | null
}

type EditionRow = {
  id: string
  mbid: string | null
  title: string
  disambiguation: string | null
  releaseDate: string | null
  country: string | null
  label: string | null
  catalogNumber: string | null
  format: string | null
  trackCount: number
}

async function editionRows(ids: readonly string[]): Promise<Map<string, EditionRow & { recordings: Set<string> }>> {
  if (ids.length === 0) return new Map()
  const [rows, tracks] = await Promise.all([
    db.execute<EditionRow>(sql`
      select id, mbid, title, disambiguation, release_date as "releaseDate", country, label, catalog_number as "catalogNumber", format,
        track_count as "trackCount"
      from releases where id = any(${uuidArray(ids)})`),
    db.execute<{ releaseId: string; recordingId: string }>(sql`
      select release_id as "releaseId", recording_id as "recordingId" from release_tracks where release_id = any(${uuidArray(ids)})`),
  ])
  const byRelease = new Map(rows.map((row) => [row.id, { ...row, recordings: new Set<string>() }]))
  for (const track of tracks) byRelease.get(track.releaseId)?.recordings.add(track.recordingId)
  return byRelease
}

/** The most common value, the first seen on a tie. */
function mode<T>(values: readonly T[]): T {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0]
}

function quality(tier: AudioTier, files: readonly HeldFile[]) {
  const rates = files.flatMap((file) => (file.bitrate ? [file.bitrate] : []))
  return {
    tier,
    codec: mode(files.map((file) => codecFamily(file))),
    sampleRate: mode(files.map((file) => file.sampleRate)),
    bitDepth: mode(files.map((file) => file.bitDepth)),
    bitrate: rates.length > 0 ? Math.round(rates.reduce((sum, rate) => sum + rate, 0) / rates.length) : null,
  }
}

function facts(edition: EditionRow, files: readonly HeldFile[], tier: AudioTier) {
  return {
    id: versionId(edition.id, tier),
    title: edition.title,
    disambiguation: edition.disambiguation || null,
    releaseDate: edition.releaseDate,
    country: edition.country,
    label: edition.label,
    catalogNumber: edition.catalogNumber,
    format: edition.format,
    identified: edition.mbid !== null && files.some((file) => file.releaseId === edition.id),
    quality: quality(tier, files),
  }
}

const heldFileColumns = sql.raw(`f.id, f.recording_id as "recordingId", f.album_id as "albumId", f.release_id as "releaseId",
  f.codec, f.container, f.rel_path as "relPath", f.sample_rate as "sampleRate", f.bit_depth as "bitDepth", f.bitrate`)

export type AlbumVersions = {
  /** Oldest edition first, best tier first within one. */
  versions: AlbumVersion[]
  /** The album's display release (canonical, else the release with the most tracks), or null. */
  displayReleaseId: string | null
}

/** The versions of an album the server holds files of. The id must already be redirect-resolved. */
export async function albumVersions(albumId: string): Promise<AlbumVersions> {
  const [[album], files] = await Promise.all([
    db.execute<{ displayReleaseId: string | null }>(sql`select ${canonicalRelease('a')} as "displayReleaseId" from albums a where a.id = ${albumId}`),
    db.execute<HeldFile>(sql`
      select ${heldFileColumns}, ${editionOf('f')} as edition, ${tierOf('f')} as tier
      from media_files f where f.album_id = ${albumId} and f.missing_since is null
      order by f.rel_path collate "C"`),
  ])
  const groups = new Map<string, { edition: string; tier: AudioTier; files: HeldFile[] }>()
  for (const file of files) {
    if (!file.edition) continue
    const key = versionId(file.edition, file.tier)
    const group = groups.get(key) ?? { edition: file.edition, tier: file.tier, files: [] }
    group.files.push(file)
    groups.set(key, group)
  }
  const editions = await editionRows([...new Set([...groups.values()].map((group) => group.edition))])
  const versions = [...groups.values()].flatMap(({ edition, tier, files: held }) => {
    const row = editions.get(edition)
    if (!row) return []
    const owned = new Set(held.flatMap((file) => (file.recordingId && row.recordings.has(file.recordingId) ? [file.recordingId] : [])))
    return [{ ...facts(row, held, tier), trackCount: row.trackCount, ownedTrackCount: owned.size, date: row.releaseDate }]
  })
  versions.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999')
    || parseVersionId(a.id).releaseId.localeCompare(parseVersionId(b.id).releaseId)
    || tierRank[a.quality.tier] - tierRank[b.quality.tier])
  return { versions: versions.map(({ date: _date, ...version }) => version), displayReleaseId: album?.displayReleaseId ?? null }
}

/** Which of two versions is the better copy: complete, then tier, then more songs, then bitrate. */
function betterVersion(a: AlbumVersion, b: AlbumVersion): number {
  const complete = (version: AlbumVersion) => (version.trackCount > 0 && version.ownedTrackCount >= version.trackCount ? 0 : 1)
  return complete(a) - complete(b)
    || tierRank[a.quality.tier] - tierRank[b.quality.tier]
    || b.ownedTrackCount - a.ownedTrackCount
    || (b.quality.bitrate ?? 0) - (a.quality.bitrate ?? 0)
    || a.id.localeCompare(b.id)
}

async function pickOf(userId: string, kind: 'album' | 'recording', entityId: string): Promise<string | null> {
  const [row] = await db.execute<{ releaseId: string; tier: AudioTier }>(sql`
    select release_id as "releaseId", tier from version_picks where user_id = ${userId} and entity_type = ${kind} and entity_id = ${entityId}`)
  return row ? versionId(row.releaseId, row.tier) : null
}

export type ShownVersion = AlbumVersions & {
  /** The viewer's pick, when it names a version the server holds. */
  pickedId: string | null
  /** The edition whose track list the page lists, or null for the display release with nothing held. */
  editionId: string | null
}

/**
 * The album's versions and the edition its page lists for `userId`: the edition of their
 * pick, else the display release, else (no file is of the display release, but files of
 * other editions are) the best version's edition.
 */
export async function shownVersion(userId: string, albumId: string): Promise<ShownVersion> {
  const [held, picked] = await Promise.all([albumVersions(albumId), pickOf(userId, 'album', albumId)])
  const pick = held.versions.find((version) => version.id === picked)
  if (pick) return { ...held, pickedId: pick.id, editionId: parseVersionId(pick.id).releaseId }
  const displayHeld = held.versions.some((version) => parseVersionId(version.id).releaseId === held.displayReleaseId)
  const best = displayHeld || held.versions.length === 0 ? null : [...held.versions].sort(betterVersion)[0]!
  return { ...held, pickedId: null, editionId: best ? parseVersionId(best.id).releaseId : held.displayReleaseId }
}

/**
 * The versions of one song the server holds: an edition of an album it is on, in a tier,
 * described by the best file of it. The requested album's first, then best tier, then
 * higher bitrate. The id must already be redirect-resolved.
 */
export async function trackVersions(userId: string, recordingId: string, albumId?: string): Promise<TrackVersions> {
  const files = await db.execute<HeldFile & { albumTitle: string }>(sql`
    select ${heldFileColumns}, ${editionOf('f')} as edition, ${tierOf('f')} as tier, a.title as "albumTitle"
    from media_files f join albums a on a.id = f.album_id
    where f.recording_id = ${recordingId} and f.missing_since is null
    order by (f.album_id = ${albumId ?? null}::uuid) is true desc, f.lossless desc, f.bitrate desc nulls last, f.added_at desc, f.id`)
  const groups = new Map<string, HeldFile & { albumTitle: string }>()
  for (const file of files) {
    if (!file.edition) continue
    const key = versionId(file.edition, file.tier)
    if (!groups.has(key)) groups.set(key, file)
  }
  const editions = await editionRows([...new Set([...groups.values()].map((file) => file.edition!))])
  const versions: TrackVersion[] = [...groups.values()].flatMap((file) => {
    const row = editions.get(file.edition!)
    return row ? [{ ...facts(row, [file], file.tier), albumId: file.albumId!, albumTitle: file.albumTitle }] : []
  })
  versions.sort((a, b) => Number(b.albumId === albumId) - Number(a.albumId === albumId) || tierRank[a.quality.tier] - tierRank[b.quality.tier])
  const [songPick, albumPick] = await Promise.all([
    pickOf(userId, 'recording', recordingId),
    albumId ? pickOf(userId, 'album', albumId) : null,
  ])
  const held = new Set(versions.map((version) => version.id))
  return {
    trackId: recordingId,
    versions,
    versionId: songPick && held.has(songPick) ? songPick : null,
    albumVersionId: albumPick && versions.some((version) => version.id === albumPick && version.albumId === albumId) ? albumPick : null,
  }
}

const entityOf = { album: { table: 'albums', kind: 'album', what: 'album' }, track: { table: 'recordings', kind: 'recording', what: 'track' } } as const

/**
 * Makes `id` the version of an album or song that plays by default for the user, or goes
 * back to Automatic with null. Follows merges; 404 for an unknown album or song, and
 * `version_not_found` for a version the server does not hold of it.
 */
export async function setVersionPick(userId: string, type: VersionPickType, id: string, version: string | null): Promise<void> {
  const entity = entityOf[type]
  const entityId = await resolveOne(entity.table, id)
  if (!entityId) throw notFound(`No such ${entity.what}`, `${entity.what}_not_found`)
  if (version === null) {
    await db.execute(sql`delete from version_picks where user_id = ${userId} and entity_type = ${entity.kind} and entity_id = ${entityId}`)
  } else {
    const held = type === 'album'
      ? (await albumVersions(entityId)).versions.some((one) => one.id === version)
      : (await trackVersions(userId, entityId)).versions.some((one) => one.id === version)
    if (!held) throw notFound('The server holds no such version', 'version_not_found')
    const { releaseId, tier } = parseVersionId(version)
    await db.execute(sql`
      insert into version_picks (user_id, entity_type, entity_id, release_id, tier) values (${userId}, ${entity.kind}, ${entityId}, ${releaseId}, ${tier})
      on conflict (user_id, entity_type, entity_id) do update set release_id = excluded.release_id, tier = excluded.tier, picked_at = now()`)
  }
  // The album page lists the picked edition; Track info marks the pick.
  await invalidate({ user: userId }, [type === 'album' ? queryKeys.album(entityId) : queryKeys.track(entityId)])
}

export type FilePreference = { songPick: boolean; albumPick: boolean; versionId: string | null }

/**
 * For each of a recording's files: whether it is in the user's pick for the song or for
 * the file's album, and its version id. One query; none for a single file without a user.
 */
export async function filePreferences(userId: string | undefined, recordingId: string, fileIds: readonly string[]): Promise<Map<string, FilePreference>> {
  if (fileIds.length === 0 || (!userId && fileIds.length === 1)) return new Map()
  const picks = userId
    ? sql`${pickedBy(userId, 'recording', 'f', sql`${recordingId}::uuid`)} as "songPick", ${pickedBy(userId, 'album', 'f')} as "albumPick"`
    : sql`false as "songPick", false as "albumPick"`
  const rows = await db.execute<{ id: string; edition: string | null; tier: AudioTier; songPick: boolean; albumPick: boolean }>(sql`
    select f.id, ${editionOf('f')} as edition, ${tierOf('f')} as tier, ${picks}
    from media_files f where f.id = any(${uuidArray(fileIds)})`)
  return new Map(rows.map((row) => [row.id, {
    songPick: row.songPick,
    albumPick: row.albumPick,
    versionId: row.edition ? versionId(row.edition, row.tier) : null,
  }]))
}
