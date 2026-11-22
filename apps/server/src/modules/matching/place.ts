/**
 * Links files to an album and recordings they are already known to be, without scoring
 * candidates. The acquisition module calls it for files it delivered for a request: the
 * request names the recording and the album, which the files' tags alone cannot do (one
 * track of a thirteen-track album never reaches the auto-accept score, and tags may name
 * another edition).
 *
 * Each file takes the album's own track for its recording: on the canonical release first,
 * then on any release fetched from a source, then on a track list built from files. An
 * album with no track for the recording gets one on its file-built release (made when the
 * album has no release at all) at the file's own track number; an album whose releases all
 * come from a source and do not list the recording keeps the file as an extra, with no
 * track. Placed files are `matched` with source `request`, so ingest only relinks their
 * group and the matcher leaves them alone.
 *
 * The rows ingest built from the files' tags are then cleaned up: such an album left without
 * files is removed, or merged into the album (leaving a redirect) when user data points at
 * it or the caller asks for a redirect; its edition, tracks and the artists only it credited
 * go with it. An album that is more than its files' tags (a MusicBrainz id, an id at another
 * source, a track list from a source) is never removed or merged here. The group's review
 * is resolved once every file in the group is identified.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Transaction } from '../../database/client.js'
import { albumArtists, albums, mediaFiles, recordingArtists, recordings, releases, releaseTracks } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { removeOrphans } from '../library/cleanup.js'
import { lockUpserts } from './apply.js'
import { closeReview } from './match.js'
import { mergeAlbum, resolveMerged } from './merge.js'

export type Placement = { fileId: string; recordingId: string }

export type PlaceInput = {
  albumId: string
  files: Placement[]
  /**
   * Other files of the same groups that are not any of the album's tracks. They are attached
   * to the album with no track, as a match attaches a group's extra files, so a later ingest
   * of the group does not link them to a track by their number.
   */
  extraFileIds?: string[]
  /**
   * Leave a redirect from every album row the files leave empty. For rows that were
   * visible for a while: ids of them may sit in clients' caches and stored queues.
   */
  redirect?: boolean
}

export type PlaceResult = {
  albumId: string
  /** Files whose links or match state changed. */
  changedFileIds: string[]
  /** Albums that changed: the album itself and the rows files left. */
  albumIds: string[]
  artistIds: string[]
}

type FileRow = typeof mediaFiles.$inferSelect
type Seat = { releaseId: string | null; releaseTrackId: string | null }

/** A release whose track list was built from files: not from MusicBrainz, not fetched from any source. */
const fileBuilt = sql`${releases.mbid} is null and ${releases.fetchedAt} is null`

/**
 * The album's release whose track list stands for it: its canonical release, else the one
 * with the most tracks. The same rule as `canonicalRelease` in the catalog.
 */
async function standingRelease(tx: Transaction, albumId: string, canonicalReleaseId: string | null): Promise<string | null> {
  if (canonicalReleaseId) return canonicalReleaseId
  const [row] = await tx.select({ id: releases.id }).from(releases).where(eq(releases.albumId, albumId)).orderBy(sql`${releases.trackCount} desc`, asc(releases.id)).limit(1)
  return row?.id ?? null
}

/** Where a file for `recordingId` sits on the album, making a track on a file-built release when the album lists none. */
async function seatFor(tx: Transaction, album: typeof albums.$inferSelect, recordingId: string, file: FileRow): Promise<Seat> {
  const standing = await standingRelease(tx, album.id, album.canonicalReleaseId)
  const [listed] = await tx.select({ id: releaseTracks.id, releaseId: releaseTracks.releaseId }).from(releaseTracks)
    .innerJoin(releases, eq(releases.id, releaseTracks.releaseId))
    .where(and(eq(releases.albumId, album.id), eq(releaseTracks.recordingId, recordingId)))
    .orderBy(
      sql`${releases.id} = ${standing} desc nulls last`, sql`(${fileBuilt}) asc`, sql`${releaseTracks.id} = ${file.releaseTrackId} desc nulls last`,
      asc(releases.id), asc(releaseTracks.disc), asc(releaseTracks.position),
    ).limit(1)
  if (listed) return { releaseId: listed.releaseId, releaseTrackId: listed.id }

  let [built] = await tx.select({ id: releases.id }).from(releases).where(and(eq(releases.albumId, album.id), fileBuilt))
    .orderBy(sql`${releases.id} = ${standing} desc nulls last`, asc(releases.id)).limit(1)
  if (!built) {
    // Every release comes from a source and none lists the recording: an extra of the album.
    if (standing) return { releaseId: standing, releaseTrackId: null }
    ;[built] = await tx.insert(releases).values({ id: newId(), albumId: album.id, title: album.title, releaseDate: album.releaseDate, detailLevel: 1 }).returning({ id: releases.id })
    await tx.update(albums).set({ canonicalReleaseId: built!.id, updatedAt: new Date() }).where(and(eq(albums.id, album.id), isNull(albums.canonicalReleaseId)))
  }
  const releaseId = built!.id

  // The number ingest gave the file (its tag, or the next free one in its group), else its tag.
  const [current] = file.releaseTrackId ? await tx.select({ disc: releaseTracks.disc, position: releaseTracks.position }).from(releaseTracks).where(eq(releaseTracks.id, file.releaseTrackId)) : []
  const disc = current?.disc ?? file.tags.disc ?? 1
  const taken = new Set((await tx.select({ position: releaseTracks.position }).from(releaseTracks)
    .where(and(eq(releaseTracks.releaseId, releaseId), eq(releaseTracks.disc, disc)))).map((row) => row.position))
  const wanted = current?.position ?? file.tags.track
  const position = wanted !== undefined && wanted <= 32_000 && !taken.has(wanted) ? wanted : Math.max(0, ...taken) + 1
  const [recording] = await tx.select({ title: recordings.title, artistCredit: recordings.artistCredit, durationMs: recordings.durationMs }).from(recordings).where(eq(recordings.id, recordingId))
  const [track] = await tx.insert(releaseTracks).values({
    id: newId(), releaseId, disc, position, recordingId, title: recording!.title, artistCredit: recording!.artistCredit, durationMs: file.durationMs || recording!.durationMs,
  }).returning({ id: releaseTracks.id })
  await tx.execute(sql`
    update releases set track_count = (select count(*) from release_tracks where release_id = ${releaseId}),
      disc_count = greatest(disc_count, ${disc}), updated_at = now()
    where id = ${releaseId}`)
  return { releaseId, releaseTrackId: track!.id }
}

/**
 * Removes or merges the local-only albums the files left, with their editions, and the
 * credits of rows that are now only redirects. Returns the ids of the albums it merged.
 */
async function cleanUp(tx: Transaction, albumId: string, before: FileRow[], redirect: boolean): Promise<void> {
  const left = [...new Set(before.flatMap((file) => (file.albumId && file.albumId !== albumId ? [file.albumId] : [])))]
  // Only rows ingest built from the files' tags are cleaned up. An album with a MusicBrainz
  // id, an id at another source or a track list from a source is a catalog album that just
  // lost a file, and stays as it is.
  const formerAlbums = left.length === 0 ? [] : (await tx.execute<{ id: string }>(sql`
    select a.id from albums a
    where a.id in ${left} and a.mbid is null and a.detail_level > 0
      and not exists (select 1 from external_ids e where e.entity_type = 'album' and e.entity_id = a.id)
      and not exists (select 1 from releases r where r.album_id = a.id and (r.mbid is not null or r.fetched_at is not null))`)).map((row) => row.id)
  const formerReleases = [...new Set(before.flatMap((file) => (file.releaseId ? [file.releaseId] : [])))]
  const formerRecordings = [...new Set(before.flatMap((file) => (file.recordingId ? [file.recordingId] : [])))]
  const freedArtists: string[] = []

  const [album] = await tx.select({ canonicalReleaseId: albums.canonicalReleaseId }).from(albums).where(eq(albums.id, albumId))
  const local = formerAlbums.length === 0 ? [] : await tx.execute<{ id: string; kept: boolean }>(sql`
    select a.id,
      (exists (select 1 from likes where entity_type = 'album' and entity_id = a.id)
        or exists (select 1 from ratings where entity_type = 'album' and entity_id = a.id)
        or exists (select 1 from wants where entity_type = 'album' and entity_id = a.id)
        or exists (select 1 from playlist_items where album_id = a.id)
        or exists (select 1 from plays where album_id = a.id)) as kept
    from albums a
    where a.id in ${formerAlbums} and a.mbid is null and a.merged_into_id is null and a.detail_level > 0
      and not exists (select 1 from media_files f where f.album_id = a.id)`)
  for (const former of local) {
    // The cover the files brought is better than none.
    await tx.execute(sql`
      update albums a set artwork_asset_id = f.artwork_asset_id, updated_at = now()
      from albums f where a.id = ${albumId} and f.id = ${former.id} and a.artwork_asset_id is null and f.artwork_asset_id is not null`)
    if (!redirect && !former.kept) continue
    await mergeAlbum(former.id, albumId, tx)
    // A redirect needs no credits, and artists only it credited should not outlive it.
    const credited = await tx.delete(albumArtists).where(eq(albumArtists.albumId, former.id)).returning({ artistId: albumArtists.artistId })
    const [row] = await tx.select({ primaryArtistId: albums.primaryArtistId }).from(albums).where(eq(albums.id, former.id))
    await tx.update(albums).set({ primaryArtistId: null }).where(eq(albums.id, former.id))
    freedArtists.push(...credited.map((credit) => credit.artistId), ...(row?.primaryArtistId ? [row.primaryArtistId] : []))
  }

  // Recordings built from the files' tags that were merged into the catalog's are redirects too.
  const redirected = formerRecordings.length === 0 ? [] : (await tx.select({ id: recordings.id, primaryArtistId: recordings.primaryArtistId }).from(recordings)
    .where(and(inArray(recordings.id, formerRecordings), isNull(recordings.mbid), sql`${recordings.mergedIntoId} is not null`)))
  for (const row of redirected) {
    const credited = await tx.delete(recordingArtists).where(eq(recordingArtists.recordingId, row.id)).returning({ artistId: recordingArtists.artistId })
    await tx.update(recordings).set({ primaryArtistId: null }).where(eq(recordings.id, row.id))
    freedArtists.push(...credited.map((credit) => credit.artistId), ...(row.primaryArtistId ? [row.primaryArtistId] : []))
  }

  // Releases of catalog albums the files left are not this cleanup's to remove.
  const releasesOfOthers = left.filter((id) => !formerAlbums.includes(id))
  const ownReleases = releasesOfOthers.length === 0 ? formerReleases : formerReleases.length === 0 ? [] : (await tx.execute<{ id: string }>(sql`
    select id from releases where id in ${formerReleases} and album_id not in ${releasesOfOthers}`)).map((row) => row.id)
  await removeOrphans(tx, { albumIds: formerAlbums, releaseIds: ownReleases, recordingIds: formerRecordings, artistIds: freedArtists })
  // A merge hands an album without a canonical release the loser's, which is gone now.
  await tx.execute(sql`
    update albums set canonical_release_id = ${album?.canonicalReleaseId ?? null}
    where id = ${albumId} and canonical_release_id is distinct from ${album?.canonicalReleaseId ?? null}
      and (${album?.canonicalReleaseId ?? null}::uuid is null or exists (select 1 from releases where id = ${album?.canonicalReleaseId ?? null}))`)
}

/**
 * Places `input.files` on the album, in the caller's transaction and under the catalog
 * lock (`lockCatalog`), which the caller takes first. Files that are missing or locked by
 * "Fix match" are left alone. Running it again changes nothing. Returns null when the
 * album does not exist.
 */
export async function placeFiles(tx: Transaction, input: PlaceInput): Promise<PlaceResult | null> {
  await lockUpserts(tx)
  const albumId = await resolveMerged(tx, albums, input.albumId)
  const [album] = await tx.select().from(albums).where(eq(albums.id, albumId))
  if (!album) return null

  const wanted = new Map(input.files.map((file) => [file.fileId, file.recordingId]))
  const extras = (input.extraFileIds ?? []).filter((id) => !wanted.has(id))
  const ids = [...wanted.keys(), ...extras]
  const rows = ids.length === 0 ? [] : await tx.select().from(mediaFiles)
    .where(and(inArray(mediaFiles.id, ids), isNull(mediaFiles.missingSince), eq(mediaFiles.matchLocked, false))).orderBy(asc(mediaFiles.relPath)).for('update')
  const now = new Date()
  const changed: FileRow[] = []
  const seats: Seat[] = []

  for (const file of rows.filter((row) => wanted.has(row.id))) {
    const recordingId = await resolveMerged(tx, recordings, wanted.get(file.id)!)
    const [recording] = await tx.select({ id: recordings.id }).from(recordings).where(eq(recordings.id, recordingId))
    if (!recording) continue
    // Read again each time: placing one file may give the album its first release.
    const [current] = await tx.select().from(albums).where(eq(albums.id, albumId))
    const seat = await seatFor(tx, current!, recordingId, file)
    seats.push(seat)
    const same = file.albumId === albumId && file.recordingId === recordingId && file.releaseId === seat.releaseId && file.releaseTrackId === seat.releaseTrackId
      && file.matchStatus === 'matched' && file.matchSource === 'request'
    if (same) continue
    await tx.update(mediaFiles).set({
      recordingId, ...seat, albumId, matchStatus: 'matched', matchSource: 'request', matchConfidence: 1, updatedAt: now,
    }).where(eq(mediaFiles.id, file.id))
    changed.push(file)
  }

  // Extras go on the release most of the placed files are on, where ingest leaves them be.
  const counts = new Map<string, number>()
  for (const seat of seats) if (seat.releaseId) counts.set(seat.releaseId, (counts.get(seat.releaseId) ?? 0) + 1)
  const releaseId = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (releaseId) {
    for (const file of rows.filter((row) => extras.includes(row.id))) {
      if (file.albumId === albumId && file.releaseId === releaseId && file.releaseTrackId === null) continue
      await tx.update(mediaFiles).set({
        releaseTrackId: null, releaseId, albumId, matchStatus: 'unmatched', matchSource: 'request', matchConfidence: null, updatedAt: now,
      }).where(eq(mediaFiles.id, file.id))
      changed.push(file)
    }
  }

  if (changed.length > 0) {
    await cleanUp(tx, albumId, changed, input.redirect ?? false)
    const groups = new Map(changed.flatMap((file) => (file.groupKey ? [[`${file.rootId}\n${file.groupKey}`, file] as const] : [])))
    // A group's review is settled once every file in it is identified; one that still holds
    // a file nobody recognized stays open for an admin to look at.
    for (const file of groups.values()) {
      const [waiting] = await tx.select({ id: mediaFiles.id }).from(mediaFiles).where(and(
        eq(mediaFiles.rootId, file.rootId), eq(mediaFiles.groupKey, file.groupKey!), sql`${mediaFiles.matchStatus} <> 'matched'`, isNull(mediaFiles.missingSince),
      )).limit(1)
      if (!waiting) await closeReview(tx, file.rootId, file.groupKey!, 'resolved', null)
    }
    // Owned by the enrichment module: a stored cover and lyrics for an album that now has files.
    await enqueue('enrichment.album', { albumId }, { singletonKey: albumId, tx })
  }

  const credited = await tx.select({ artistId: albumArtists.artistId }).from(albumArtists).where(eq(albumArtists.albumId, albumId))
  return {
    albumId,
    changedFileIds: changed.map((file) => file.id),
    albumIds: [...new Set([albumId, ...changed.flatMap((file) => (file.albumId ? [file.albumId] : []))])],
    artistIds: [...new Set([...credited.map((row) => row.artistId), ...(album.primaryArtistId ? [album.primaryArtistId] : [])])],
  }
}
