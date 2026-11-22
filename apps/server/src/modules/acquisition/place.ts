/**
 * Putting a delivery where it was asked for. This is the one place that links delivered
 * files to a request: verify.ts decides which recording a file is, and this decides the
 * album and has the matching module link the file to it (`placeFiles`).
 *
 * Without it a delivered file stays on the album its tags built. Each on-demand track is
 * its own import in its own `_Incoming/<importId>/` folder, so every fetched track became
 * an album of its own, one track of an album never scores as a confident match, and the
 * file was left for review in `_Incoming`.
 *
 * A delivered file that is a requested recording goes on the first of these that lists
 * the recording, or a track that is plainly the same recording (see below):
 * 1. the album the request named;
 * 2. the album the file is on, when that is more than a row built from its tags;
 * 3. another album that lists the recording, then the album a search stub hints at;
 * 4. a row for the same album as 1 (same artist, same title once edition suffixes are
 *    dropped): a search stub and the MusicBrainz row of one album are often two rows.
 * When none lists it, the file goes on the requested album (else the hinted one) anyway,
 * on a track list built from the files, in their own track numbers. A request that names
 * no album for a recording with no hint (a popular track from an artist page) takes the
 * album the file's own album tag names among its artists' albums as the hint; when that
 * album lists no track for it (a regional edition's bonus track), the file gets a track list
 * of its own edition there. With no album known at all the file stays on the album its tags
 * built.
 *
 * When the requested album lists the recording only on a track list built from files (a
 * search stub the file went on before its MusicBrainz row had a track list), a row for the
 * same album as in 4 that lists it from a source takes the file, and the stub is merged
 * into that row once it is empty.
 *
 * - **Album detail first.** An album with no track list from a source gets it fetched
 *   (`ensureAlbumDetail`) before anything is placed on it, because an album with files
 *   keeps the track list it has. While a source could still answer, a file younger than
 *   {@link timing.detailWaitMs} waits (it plays meanwhile) and the sweep tries again.
 * - **The same song under two rows.** When the album does not list the file's recording
 *   but one of its tracks is plainly the same recording as the file (`sameRecording`), the
 *   two rows are merged and the file takes that track. That is how a requested search stub
 *   ends up on the album's own recording instead of beside it.
 * - **The rest of the delivery.** Other delivered files that are plainly tracks of that
 *   album go on it too (an album fetched whole, a provider that sends more than it was
 *   asked for). What fits no track is attached to the album with no track once the import
 *   has decided its duplicates; a delivery of which nothing fits stays where it is.
 *
 * It runs from `acquisition.finish` when a single delivered file becomes usable, from the
 * import once it has decided its duplicates (delivery.ts), at the end of the job, and
 * from the repair (repair.ts). Every run re-checks under the catalog lock, and running it
 * again changes nothing.
 */
import { INCOMING_FOLDER } from '@squirmy/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { albums, imports, mediaFiles, recordingArtists, recordings } from '../../database/schema.js'
import { getServerSettings } from '../../lib/settings.js'
import { matchKey } from '../../lib/text.js'
import { canonicalRelease } from '../catalog/availability.js'
import { resolveMerged, resolveOne } from '../catalog/redirects.js'
import { ensureAlbumDetail } from '../enrichment/detail.js'
import { lockCatalog } from '../library/cleanup.js'
import { placeFiles, type Placement } from '../matching/index.js'
import { announce } from '../matching/match.js'
import { resolveMerged as resolveMergedIn } from '../matching/merge.js'
import { editionFreeKey, textArray } from '../search/keys.js'
import type { JobRow } from './jobs.js'
import { invalidateRecordings } from './resolve.js'
import { asDelivered, deliveredFiles, mergeDelivered, sameRecording, type Recording } from './verify.js'

const timing = {
  /** How long a file waits for an album's track list from a source before it is placed without one. */
  detailWaitMs: 10 * 60_000,
}

/** Overrides the placement timings in tests. */
export function configurePlacement(options: Partial<typeof timing>) {
  Object.assign(timing, options)
}

export type PlaceOptions = {
  /**
   * The check made while the import still identifies: only files usable now (see verify.ts),
   * and only a delivery of one file. Files of a larger delivery are placed together once the
   * import has decided its duplicates, so that ingest, which links the other files of a
   * group with an identified file by track number, never sees half of it identified.
   */
  early?: boolean
  /** Leave redirects from the album rows the files leave: for deliveries that sat on them for a while. */
  redirect?: boolean
  /** Also look again at files this placed before, which may have a better track to sit on by now. */
  again?: boolean
  /** Files already looked at in this run of the caller, not to be looked at again. */
  seen?: Set<string>
}

export type PlaceOutcome = {
  /** Files whose links changed. */
  placed: string[]
  /** Files waiting for their album's track list. */
  deferred: string[]
}

type Job = Pick<JobRow, 'recordingIds' | 'albumId' | 'importId'>
type Row = Awaited<ReturnType<typeof deliveredFiles>>[number]

function report(error: unknown) {
  if (getConfig().LOG_LEVEL !== 'silent') console.error('[acquisition]', error)
}

/** SQL condition: the album (alias `a`) has a track list that came from a source, not from files. */
const sourced = sql.raw('exists (select 1 from releases sourced where sourced.album_id = a.id and (sourced.mbid is not null or sourced.fetched_at is not null))')

/**
 * SQL condition: the album (alias `a`) is more than a row ingest built from a delivery's
 * tags. Such a row has no MusicBrainz id, is not a search stub, carries no external id, has
 * no track list from a source and holds no file that was not delivered by a provider. A
 * delivered file is known by its source, or by its import's folder until the import has
 * marked it.
 */
const real = sql.raw(`(a.mbid is not null or a.detail_level = 0
  or exists (select 1 from external_ids known where known.entity_type = 'album' and known.entity_id = a.id)
  or exists (select 1 from releases sourced where sourced.album_id = a.id and (sourced.mbid is not null or sourced.fetched_at is not null))
  or exists (select 1 from media_files own where own.album_id = a.id and own.missing_since is null and not starts_with(own.source, 'provider:')
    and not exists (select 1 from imports delivery where delivery.kind = 'acquisition' and delivery.target_root_id = own.root_id
      and starts_with(own.rel_path, '${INCOMING_FOLDER}/' || delivery.id::text || '/'))))`)

/** One run's lookups. Detail is asked for once per album, and recordings are read once until a merge. */
class Lookup {
  private readonly detailed = new Set<string>()
  private readonly rows = new Map<string, Recording>()

  async recording(id: string): Promise<Recording | undefined> {
    const current = (await resolveOne('recordings', id)) ?? id
    if (!this.rows.has(current)) {
      const [row] = await db.select().from(recordings).where(eq(recordings.id, current))
      if (row) this.rows.set(current, row)
    }
    return this.rows.get(current)
  }

  forget() {
    this.rows.clear()
  }

  /** The album's row after merges, with its track list fetched when it had none from a source. */
  async album(albumId: string): Promise<string | null> {
    const current = await resolveOne('albums', albumId)
    if (!current) return null
    if (this.detailed.has(current)) return current
    this.detailed.add(current)
    const [row] = await db.execute<{ sourced: boolean }>(sql`select ${sourced} as sourced from albums a where a.id = ${current}`)
    if (row?.sourced) return current
    // Never throws, and waits a few seconds at most.
    await ensureAlbumDetail(current)
    const after = await resolveOne('albums', current)
    if (after) this.detailed.add(after)
    return after
  }
}

/** Whether a source that is switched on could still give the album a track list. */
async function detailPending(albumId: string): Promise<boolean> {
  const { musicBrainzEnabled, deezerEnabled } = await getServerSettings()
  const [row] = await db.execute<{ pending: boolean }>(sql`
    select not ${sourced} and ((a.mbid is not null and ${musicBrainzEnabled}) or (${deezerEnabled}
      and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'album' and e.entity_id = a.id))) as pending
    from albums a where a.id = ${albumId}`)
  return Boolean(row?.pending)
}

/** Albums other than `except` that list the recording and are more than a tags-built row, the ones standing for it first. */
async function albumsListing(recordingId: string, except: readonly string[]): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select a.id from albums a
    where a.merged_into_id is null and ${real}
      and exists (select 1 from release_tracks rt join releases rel on rel.id = rt.release_id where rel.album_id = a.id and rt.recording_id = ${recordingId})
    order by exists (select 1 from release_tracks rt where rt.release_id = ${canonicalRelease('a')} and rt.recording_id = ${recordingId}) desc,
      exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null) desc, a.id
    limit 5`)
  return rows.map((row) => row.id).filter((id) => !except.includes(id))
}

/**
 * Other rows that stand for the same album: the same primary artist or artist credit and
 * the same title once edition suffixes are dropped, with a MusicBrainz id or a track list
 * from a source. Only a track that is plainly the delivered recording makes one of them
 * the place for a file, so a single of the same name does not qualify by its name alone.
 */
async function sameAlbumRows(albumId: string): Promise<string[]> {
  const [album] = await db.select({ title: albums.title, primaryArtistId: albums.primaryArtistId, matchKey: albums.matchKey, mbid: albums.mbid, type: albums.type })
    .from(albums).where(eq(albums.id, albumId))
  if (!album) return []
  const artistKey = album.matchKey.split('|')[0] ?? ''
  // Two MusicBrainz ids are two release groups, never one album; a row without one counts
  // only with the same type (an album and the single named after it are not the same).
  const rows = await db.execute<{ id: string; title: string }>(sql`
    select a.id, a.title from albums a
    where a.id <> ${albumId} and a.merged_into_id is null and (a.mbid is not null or ${sourced})
      and (a.primary_artist_id = ${album.primaryArtistId} or split_part(a.match_key, '|', 1) = ${artistKey})
      and a.type = ${album.type} and (${album.mbid}::uuid is null or a.mbid is null)
    order by a.mbid is null, a.id limit 200`)
  const key = editionFreeKey(album.title)
  return rows.filter((row) => editionFreeKey(row.title) === key).map((row) => row.id).slice(0, 3)
}

/**
 * The recording a file takes on the album: its own when the album lists it, else the
 * recording of a track of the album's standing release that is plainly the same (the two
 * rows are merged). Null when the album has no track for it.
 */
async function trackOn(lookup: Lookup, albumId: string, row: Row): Promise<string | null> {
  const recording = await lookup.recording(row.file.recordingId!)
  if (!recording) return null
  const tracks = await db.execute<{ recordingId: string; standing: boolean; built: boolean }>(sql`
    select rt.recording_id as "recordingId", rel.id = ${canonicalRelease('a')} as standing, (rel.mbid is null and rel.fetched_at is null) as built
    from albums a join releases rel on rel.album_id = a.id join release_tracks rt on rt.release_id = rel.id
    where a.id = ${albumId}
    order by rt.disc, rt.position, rt.id`)
  const listed = tracks.filter((track) => track.recordingId === recording.id)
  if (listed.some((track) => track.standing || !track.built)) return recording.id

  // Two catalog rows become one only on clear evidence: exactly one track of the album is
  // plainly the file's recording. Two candidates (a song and its live take of the same
  // length) leave both rows alone.
  const twins: Recording[] = []
  for (const track of tracks) {
    if (!track.standing || track.recordingId === recording.id) continue
    const other = await lookup.recording(track.recordingId)
    if (!other || other.id === recording.id || twins.some((twin) => twin.id === other.id)) continue
    if (await sameRecording(other, recording, asDelivered(row, recording.id), { catalog: true })) twins.push(other)
  }
  if (twins.length === 1 && await mergeDelivered(twins[0]!, recording, row.file.id)) {
    lookup.forget()
    return (await resolveOne('recordings', recording.id)) ?? recording.id
  }
  return listed.length > 0 ? recording.id : null
}

/** Whether the album lists the recording on a track list from a source, not only on one built from files. */
async function listsFromSource(albumId: string, recordingId: string): Promise<boolean> {
  const [row] = await db.execute<{ listed: boolean }>(sql`
    select exists (select 1 from releases rel join release_tracks rt on rt.release_id = rel.id
      where rel.album_id = ${albumId} and rt.recording_id = ${recordingId} and (rel.mbid is not null or rel.fetched_at is not null)) as listed`)
  return Boolean(row?.listed)
}

/**
 * The album a delivered file's own album tag names, for a request that named no album and a
 * recording with no album hint: a popular track played from an artist page, which Deezer's
 * top tracks give without an album row. It is an album of one of the recording's artists
 * with the same title once edition suffixes are dropped, and more than a row built from tags:
 * one that lists the recording, else the only one with a MusicBrainz id, else the only one.
 * Several equally good rows name nothing. The artists are the recording's credits, also by
 * name: Deezer's credits of another artist's track can point at the page's own artist row.
 */
async function albumTagsName(row: Row, recording: Recording, except: string | null): Promise<string | null> {
  const key = row.file.tags.album ? editionFreeKey(row.file.tags.album) : ''
  if (!key) return null
  const credited = await db.select({ name: recordingArtists.creditedName }).from(recordingArtists).where(eq(recordingArtists.recordingId, recording.id))
  const names = [...new Set(credited.map((credit) => matchKey(credit.name)).filter(Boolean))]
  const rows = await db.execute<{ id: string; title: string; mbid: string | null; lists: boolean }>(sql`
    select a.id, a.title, a.mbid,
      exists (select 1 from releases rel join release_tracks rt on rt.release_id = rel.id where rel.album_id = a.id and rt.recording_id = ${recording.id}) as lists
    from albums a
    where a.merged_into_id is null and a.id is distinct from ${except}::uuid and ${real}
      and (a.primary_artist_id = ${recording.primaryArtistId}::uuid
        or a.primary_artist_id in (select ra.artist_id from recording_artists ra where ra.recording_id = ${recording.id})
        or a.primary_artist_id in (select ar.id from artists ar where ar.merged_into_id is null and ar.name_key = any(${textArray(names)})))
    order by a.id limit 1000`)
  const named = rows.filter((one) => editionFreeKey(one.title) === key)
  const only = (list: typeof named) => (list.length === 1 ? list[0]!.id : null)
  const listing = named.filter((one) => one.lists)
  if (listing.length > 0) return only(listing)
  return only(named.filter((one) => one.mbid)) ?? only(named)
}

type Seat = {
  albumId: string
  recordingId: string
  /** The requested album row this seat stands in for: another row of the same album, merged into it once empty. */
  replaces?: string
  /** The file's tags named the album, which lists no track for it: it gets one on a track list built from files. */
  ownEdition?: boolean
}

/** Where a file that is a requested recording goes: see the module comment. */
async function seatRequested(lookup: Lookup, job: Job, row: Row): Promise<Seat | 'defer' | null> {
  const recording = await lookup.recording(row.file.recordingId!)
  if (!recording) return null
  const requested = job.albumId ? await resolveOne('albums', job.albumId) : null
  const [current] = row.file.albumId ? await db.execute<{ id: string; real: boolean }>(sql`
    select a.id, ${real} as real from albums a where a.id = ${row.file.albumId} and a.merged_into_id is null`) : []
  const hinted = recording.albumHintId ? await resolveOne('albums', recording.albumHintId) : null
  const tagged = !hinted && !requested && !current?.real ? await albumTagsName(row, recording, current?.id ?? null) : null
  const hint = hinted ?? tagged
  const young = row.file.addedAt.getTime() > Date.now() - timing.detailWaitMs
  // The album the request named is the answer when it can be: other albums that list the
  // recording (a single, a compilation) are only looked at for a request without one.
  const first = [requested, current?.real ? current.id : null].filter((id): id is string => Boolean(id))
  const fallback = requested ?? hint
  const tried = new Set<string>()
  const seat = async (candidates: readonly string[]): Promise<Seat | null> => {
    for (const candidate of candidates) {
      const albumId = await lookup.album(candidate)
      if (!albumId || tried.has(albumId)) continue
      tried.add(albumId)
      const recordingId = await trackOn(lookup, albumId, row)
      if (recordingId) return { albumId, recordingId }
    }
    return null
  }
  const found = await seat(first)
  // The requested row may list the recording only on a track list built from the files: a
  // search stub that had no track list when its file was placed. Another row of the same
  // album that lists the recording from a source is where the file belongs, and the stub,
  // once empty, is merged into it ("Baggy$$" showed up twice, one track on the stub).
  if (found && found.albumId === requested && !(await listsFromSource(found.albumId, found.recordingId))) {
    const better = await seat(await sameAlbumRows(found.albumId))
    if (better && await listsFromSource(better.albumId, better.recordingId)) return { ...better, replaces: found.albumId }
  }
  if (found) return found
  // The requested album's track list may still arrive and list it.
  if (requested && young && await detailPending(requested)) return 'defer'
  const others = await seat([
    ...(requested ? [] : [...await albumsListing(recording.id, first), ...(hint ? [hint] : [])]),
    ...(fallback ? await sameAlbumRows(fallback) : []),
  ])
  if (others) return others

  const albumId = fallback ? await lookup.album(fallback) : null
  // A file on an album of its own that is more than its tags stays there.
  if (!albumId || (current?.real && current.id !== albumId)) return null
  if (young && await detailPending(albumId)) return 'defer'
  // A file whose own tags named the album is of an edition its track lists do not show (a
  // regional bonus track): it gets a track of its own, so it is identified and filed. A
  // request's album that does not list the file keeps it as an extra (a live take beside the
  // album's studio recording).
  return { albumId, recordingId: recording.id, ownEdition: tagged !== null && albumId === await resolveOne('albums', tagged) }
}

/**
 * Places the job's delivered files as the module comment describes. Never throws for a
 * file it cannot place: that file stays as it is, playable, for the next run.
 */
export async function placeDelivery(job: Job, options: PlaceOptions = {}): Promise<PlaceOutcome> {
  const outcome: PlaceOutcome = { placed: [], deferred: [] }
  if (!job.importId) return outcome
  const [delivery] = await db.select({ stats: imports.stats }).from(imports).where(eq(imports.id, job.importId))
  if (options.early && (delivery?.stats?.audioFiles ?? 0) !== 1) return outcome
  const delivered = await deliveredFiles(job.importId, options.early ?? false)
  const open = delivered.filter(({ file }) => !file.matchLocked && !options.seen?.has(file.id)
    // The matcher's own confident answer stands, and so does a placement unless asked to look again.
    && (file.matchSource === 'request' ? options.again === true && file.matchStatus === 'matched' : file.matchStatus !== 'matched'))
  if (open.length === 0) return outcome
  for (const { file } of open) options.seen?.add(file.id)

  const lookup = new Lookup()
  const wanted = new Set((await resolveMerged('recordings', job.recordingIds)).values())
  const seats = new Map<string, Seat>()
  const rest: Row[] = []
  for (const row of open) {
    const recording = await lookup.recording(row.file.recordingId!)
    if (!recording || !wanted.has(recording.id)) {
      rest.push(row)
      continue
    }
    const seat = await seatRequested(lookup, job, row)
    if (seat === 'defer') outcome.deferred.push(row.file.id)
    else if (seat) seats.set(row.file.id, seat)
  }

  // The rest of the delivery goes where the requested files went, where it is a track of that album.
  const settled = delivered.find(({ file }) => file.matchSource === 'request' && file.matchStatus === 'matched' && file.albumId)?.file.albumId
  const home = [...seats.values()][0]?.albumId ?? settled
    ?? (outcome.deferred.length === 0 && job.albumId ? await lookup.album(job.albumId) : null)
  const extras: string[] = []
  if (home) {
    const seatedGroups = () => new Set(delivered.filter(({ file }) => seats.has(file.id) || (file.matchSource === 'request' && file.matchStatus === 'matched'))
      .map(({ file }) => `${file.rootId}\n${file.groupKey}`))
    for (const row of rest) {
      const recordingId = await trackOn(lookup, home, row)
      if (recordingId) seats.set(row.file.id, { albumId: home, recordingId })
    }
    // A file that fits no track is attached to the album only when it shares a group with
    // files that did fit, so a later ingest of that group cannot give it one of their
    // tracks by its number. Anything else the provider sent stays where its tags put it.
    // Only once nothing is still arriving.
    const groups = seatedGroups()
    for (const row of rest) {
      if (seats.has(row.file.id) || options.early || row.file.matchSource === 'request') continue
      if (groups.has(`${row.file.rootId}\n${row.file.groupKey}`)) extras.push(row.file.id)
    }
  }
  if (seats.size === 0) return outcome

  const byAlbum = new Map<string, Placement[]>()
  const replaced = new Map<string, string[]>()
  for (const [fileId, seat] of seats) {
    byAlbum.set(seat.albumId, [...byAlbum.get(seat.albumId) ?? [], { fileId, recordingId: seat.recordingId, ownEdition: seat.ownEdition }])
    if (seat.replaces) replaced.set(seat.albumId, [...replaced.get(seat.albumId) ?? [], seat.replaces])
  }
  const albumIds: string[] = []
  const artistIds: string[] = []
  const recordingIds: string[] = []
  for (const [albumId, files] of byAlbum) {
    try {
      const result = await db.transaction(async (tx) => {
        await lockCatalog(tx)
        // Ingest and matching relink files while an import runs: only what still holds is placed.
        const now = await tx.select({ id: mediaFiles.id, recordingId: mediaFiles.recordingId, matchStatus: mediaFiles.matchStatus, matchSource: mediaFiles.matchSource })
          .from(mediaFiles).where(and(inArray(mediaFiles.id, [...files.map((file) => file.fileId), ...extras]), isNull(mediaFiles.missingSince), eq(mediaFiles.matchLocked, false)))
        const mine = (row: (typeof now)[number]) => row.matchStatus !== 'matched' || row.matchSource === 'request'
        const holding: Placement[] = []
        for (const file of files) {
          const row = now.find((candidate) => candidate.id === file.fileId)
          if (!row?.recordingId || !mine(row)) continue
          if (await resolveMergedIn(tx, recordings, row.recordingId) === await resolveMergedIn(tx, recordings, file.recordingId)) holding.push(file)
        }
        if (holding.length === 0) return null
        const extraFileIds = albumId === home ? extras.filter((id) => now.some((row) => row.id === id && mine(row) && row.matchSource !== 'request')) : []
        return placeFiles(tx, { albumId, files: holding, extraFileIds, redirect: options.redirect, sameAlbumIds: replaced.get(albumId) })
      })
      if (!result) continue
      outcome.placed.push(...result.changedFileIds)
      if (result.changedFileIds.length === 0) continue
      albumIds.push(...result.albumIds)
      artistIds.push(...result.artistIds)
      recordingIds.push(...files.map((file) => file.recordingId))
    } catch (error) {
      report(error)
    }
  }
  if (albumIds.length > 0) {
    await announce(albumIds, artistIds)
    await invalidateRecordings(recordingIds)
  }
  return outcome
}
