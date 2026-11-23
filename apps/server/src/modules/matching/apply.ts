/**
 * Turns a chosen MusicBrainz release into catalog rows and links a group's files to them.
 * `upsertRelease` is the one writer of MusicBrainz releases; enrichment uses it too.
 *
 * Adopt, don't duplicate: when no row carries a MusicBrainz id yet, the local-only row the
 * files were linked to is updated in place, so ids that likes, playlists and sessions
 * already point at keep working. When a row with the id exists, the local-only row is
 * merged into it.
 */
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { Transaction } from '../../database/client.js'
import {
  albumArtists, albums, artists, mediaFiles, recordingArtists, recordings, releases, releaseTracks, type MatchSource,
} from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { enqueue } from '../../jobs/index.js'
import type { MbArtistCredit, MbRelease } from '../metadata/musicbrainz.js'
import { deleteOrphanLocalReleases } from './local.js'
import { mergeAlbum, mergeArtist, mergeRecording, resolveMerged } from './merge.js'
import { formatSummary, type Evaluation } from './score.js'

export type ApplyInput = {
  release: MbRelease
  /** The files being matched; `evaluation` assigns some of them to tracks. */
  fileIds: string[]
  evaluation: Evaluation
  source: MatchSource
  /** Lock the files against automatic rematching (manual matches). */
  locked: boolean
  /**
   * Attach files that fit no track to the album and release (bonus tracks of an album).
   * Off for loose tracks, which only happen to share a group.
   */
  attachExtras: boolean
}

export type ApplyResult = {
  albumId: string
  releaseId: string
  /** Albums that changed, including local-only ones merged away. */
  albumIds: string[]
  artistIds: string[]
}

function allCredits(release: MbRelease): MbArtistCredit[] {
  return [
    ...release.releaseGroup.artistCredit,
    ...release.artistCredit,
    ...release.mediums.flatMap((medium) => medium.tracks.flatMap((track) => [...track.artistCredit, ...track.recording.artistCredit])),
  ]
}

async function byMbid(tx: Transaction, table: typeof artists | typeof albums | typeof recordings, mbid: string): Promise<string | null> {
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.mbid, mbid))
  return row ? resolveMerged(tx, table, row.id) : null
}

/**
 * Serializes writes of MusicBrainz-backed rows until the transaction ends: concurrent
 * upserts share artists and adopt rows by MBID.
 */
export async function lockUpserts(tx: Transaction) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('squirmy:matching:apply'))`)
}

/**
 * Artists by MBID for every credit: existing rows, else a local-only row among
 * `localArtistIds` with the same name (which takes the MBID), else a new row. Returns
 * MBID → row id. Call it under `lockUpserts`.
 */
export async function upsertArtists(tx: Transaction, credits: readonly MbArtistCredit[], localArtistIds: readonly string[] = []): Promise<Map<string, string>> {
  const locals = localArtistIds.length === 0 ? [] : await tx.select({ id: artists.id, nameKey: artists.nameKey }).from(artists)
    .where(and(inArray(artists.id, [...localArtistIds]), isNull(artists.mbid), isNull(artists.mergedIntoId)))
  const ids = new Map<string, string>()
  for (const credit of credits) {
    if (ids.has(credit.mbid)) continue
    const nameKey = matchKey(credit.name)
    const localIndex = locals.findIndex((local) => local.nameKey === nameKey)
    const local = localIndex >= 0 ? locals.splice(localIndex, 1)[0] : undefined
    let id = await byMbid(tx, artists, credit.mbid)
    if (id && local) await mergeArtist(local.id, id, tx)
    else if (!id && local) {
      await tx.update(artists).set({ mbid: credit.mbid, name: credit.name, nameKey, updatedAt: new Date() }).where(eq(artists.id, local.id))
      id = local.id
    } else if (!id) {
      await tx.insert(artists).values({ id: newId(), mbid: credit.mbid, name: credit.name, sortName: credit.name, nameKey }).onConflictDoNothing()
      id = (await byMbid(tx, artists, credit.mbid))!
    }
    ids.set(credit.mbid, id)
  }
  return ids
}

/** Replaces an album's or recording's credit rows. Every credit's MBID must be in `artistIds`. */
export async function replaceCredits(tx: Transaction, table: typeof albumArtists | typeof recordingArtists, ownerId: string, credits: readonly MbArtistCredit[], artistIds: Map<string, string>) {
  if (table === albumArtists) {
    await tx.delete(albumArtists).where(eq(albumArtists.albumId, ownerId))
    if (credits.length > 0) {
      await tx.insert(albumArtists).values(credits.map((credit, position) => ({
        albumId: ownerId, position, artistId: artistIds.get(credit.mbid)!, creditedName: credit.name, joinPhrase: credit.joinPhrase,
      })))
    }
    return
  }
  await tx.delete(recordingArtists).where(eq(recordingArtists.recordingId, ownerId))
  if (credits.length > 0) {
    await tx.insert(recordingArtists).values(credits.map((credit, position) => ({
      recordingId: ownerId, position, artistId: artistIds.get(credit.mbid)!, creditedName: credit.name, joinPhrase: credit.joinPhrase,
    })))
  }
}

/** Rows `upsertRelease` may take over instead of creating new ones. Ids that carry an MBID are ignored. */
export type Adoption = {
  /** Local-only artists credited on the rows being replaced; one with a credit's name takes its MBID. */
  artistIds?: readonly string[]
  /**
   * Album rows that stand for this release group. When no row has the group's MBID the
   * first one takes it; every other one is merged into the album that does.
   */
  albumIds?: readonly string[]
  /** Local-only editions that may become this release (their tracks are replaced) when no row has its MBID. */
  releaseIds?: readonly string[]
  /** Local-only recordings to take each track's MBID, keyed `disc:position` of that track. */
  recordings?: ReadonlyMap<string, { id: string; isrcs: string[] }>
}

export type UpsertOptions = {
  /**
   * `always` makes the release the album's canonical one. `unless-owned` leaves an album
   * that has present files with the canonical release it has.
   */
  canonical: 'always' | 'unless-owned'
  /**
   * Writes the release under this album row instead of the release group's row: an
   * edition row (`albums.edition_of_id`) that shows one release of the group. The row
   * keeps its title and has no MBID; it takes the group's type, date and credits.
   */
  editionAlbumId?: string
}

export type UpsertedRelease = {
  albumId: string
  releaseId: string
  /** Albums merged into `albumId`. */
  mergedAlbumIds: string[]
  /** MBID → artist row id for everyone credited. */
  artistIds: Map<string, string>
  /** `disc:position` → the rows written for that track. */
  tracks: Map<string, { recordingId: string; releaseTrackId: string }>
}

/**
 * Writes a MusicBrainz release as catalog rows in the caller's transaction: its artists,
 * album (the release group, at least `detail_level` 1), the release with every medium's
 * tracks, recordings with their ISRCs, and all credits. Rows are found by MBID, else
 * adopted from `adoption`, else created; running it twice changes nothing.
 */
export async function upsertRelease(tx: Transaction, release: MbRelease, adoption: Adoption = {}, options: UpsertOptions = { canonical: 'always' }): Promise<UpsertedRelease> {
  await lockUpserts(tx)
  const group = release.releaseGroup
  const now = new Date()
  const artistIds = await upsertArtists(tx, allCredits(release), adoption.artistIds)
  const primaryArtist = (credits: MbArtistCredit[]) => (credits[0] ? artistIds.get(credits[0].mbid)! : null)

  // The album is the release group.
  const albumValues = {
    mbid: group.mbid,
    title: group.title,
    artistCredit: group.artistName,
    primaryArtistId: primaryArtist(group.artistCredit),
    type: group.type,
    typeGuessed: false,
    secondaryTypes: group.secondaryTypes,
    releaseDate: group.date,
    year: group.year,
    titleKey: matchKey(group.title),
    matchKey: creditKey(group.artistName, group.title),
    detailLevel: sql`greatest(${albums.detailLevel}, 1)`,
    fetchedAt: now,
    updatedAt: now,
  }
  const candidates = adoption.albumIds?.length ? (await tx.select({ id: albums.id }).from(albums)
    .where(and(inArray(albums.id, [...adoption.albumIds]), isNull(albums.mbid), isNull(albums.mergedIntoId)))).map((row) => row.id) : []
  const localAlbums = options.editionAlbumId ? [] : (adoption.albumIds ?? []).filter((id) => candidates.includes(id))
  const mergedAlbumIds: string[] = []
  let albumId: string
  const existingAlbumId = options.editionAlbumId ? undefined : await byMbid(tx, albums, group.mbid) ?? localAlbums[0]
  if (options.editionAlbumId) {
    // The edition keeps its own name ("SOS Deluxe: LANA") and has no MBID of its own.
    const { mbid: _mbid, title: _title, titleKey: _titleKey, matchKey: _matchKey, artistCredit: _artistCredit, ...editionValues } = albumValues
    albumId = options.editionAlbumId
    await tx.update(albums).set(editionValues).where(eq(albums.id, albumId))
  } else if (existingAlbumId) {
    albumId = existingAlbumId
    await tx.update(albums).set(albumValues).where(eq(albums.id, albumId))
  } else {
    albumId = newId()
    await tx.insert(albums).values({ id: albumId, ...albumValues, detailLevel: 1 })
  }
  for (const local of localAlbums) {
    if (local === albumId) continue
    await mergeAlbum(local, albumId, tx)
    mergedAlbumIds.push(local)
  }
  await replaceCredits(tx, albumArtists, albumId, group.artistCredit, artistIds)

  // The release: the existing row, else an adoptable local edition, else a new row.
  const releaseValues = {
    mbid: release.mbid,
    albumId,
    title: release.title,
    releaseDate: release.date,
    country: release.country,
    label: release.labels[0]?.name ?? null,
    catalogNumber: release.labels[0]?.catalogNumber ?? null,
    barcode: release.barcode,
    format: formatSummary(release),
    status: release.status,
    trackCount: release.mediums.reduce((sum, medium) => sum + medium.tracks.length, 0),
    discCount: Math.max(1, release.mediums.length),
    detailLevel: 2,
    fetchedAt: now,
    updatedAt: now,
  }
  const [existingRelease] = await tx.select({ id: releases.id }).from(releases).where(eq(releases.mbid, release.mbid))
  const adoptable = existingRelease || !adoption.releaseIds?.length ? [] : await tx.select({ id: releases.id }).from(releases)
    .where(and(inArray(releases.id, [...adoption.releaseIds]), isNull(releases.mbid)))
  let releaseId = existingRelease?.id ?? adoptable[0]?.id
  if (releaseId) {
    if (!existingRelease) await tx.delete(releaseTracks).where(eq(releaseTracks.releaseId, releaseId))
    await tx.update(releases).set(releaseValues).where(eq(releases.id, releaseId))
  } else {
    releaseId = newId()
    await tx.insert(releases).values({ id: releaseId, ...releaseValues })
  }
  const owned = sql`exists (select 1 from ${mediaFiles} f where f.album_id = ${albums.id} and f.missing_since is null)`
  await tx.update(albums).set({ canonicalReleaseId: releaseId })
    .where(and(eq(albums.id, albumId), options.canonical === 'unless-owned' ? sql`not ${owned}` : undefined))

  // Recordings and tracks.
  const localRecordingIds = [...(adoption.recordings?.values() ?? [])].map((recording) => recording.id)
  const adoptableRecordings = new Set(localRecordingIds.length === 0 ? [] : (await tx.select({ id: recordings.id }).from(recordings)
    .where(and(inArray(recordings.id, localRecordingIds), isNull(recordings.mbid), isNull(recordings.mergedIntoId)))).map((row) => row.id))
  const tracks = new Map<string, { recordingId: string; releaseTrackId: string }>()
  for (const medium of release.mediums) {
    for (const track of medium.tracks) {
      const mb = track.recording
      const key = `${medium.position}:${track.position}`
      const candidate = adoption.recordings?.get(key)
      const local = candidate && adoptableRecordings.delete(candidate.id) ? candidate : undefined
      const values = {
        mbid: mb.mbid,
        title: mb.title,
        artistCredit: mb.artistName,
        primaryArtistId: primaryArtist(mb.artistCredit),
        durationMs: mb.durationMs ?? track.durationMs,
        titleKey: matchKey(mb.title),
        matchKey: creditKey(mb.artistName, mb.title),
        updatedAt: now,
      }
      let recordingId = await byMbid(tx, recordings, mb.mbid)
      // The row with this MBID may have been merged into another recording of the same song
      // (a track with no file of its own into the copy another release holds). That row keeps
      // its own MBID and title; it only learns this recording's ISRCs.
      const [own] = recordingId ? await tx.select({ id: recordings.id }).from(recordings).where(eq(recordings.mbid, mb.mbid)) : []
      const redirected = Boolean(recordingId && own && own.id !== recordingId)
      if (recordingId) {
        if (local) await mergeRecording(local.id, recordingId, tx)
        const [existing] = await tx.select({ isrcs: recordings.isrcs }).from(recordings).where(eq(recordings.id, recordingId))
        const isrcs = [...new Set([...existing!.isrcs, ...mb.isrcs])]
        await tx.update(recordings).set(redirected ? { isrcs, updatedAt: now } : { ...values, isrcs }).where(eq(recordings.id, recordingId))
      } else if (local) {
        recordingId = local.id
        await tx.update(recordings).set({ ...values, isrcs: [...new Set([...local.isrcs, ...mb.isrcs])] }).where(eq(recordings.id, recordingId))
      } else {
        await tx.insert(recordings).values({ id: newId(), ...values, isrcs: mb.isrcs }).onConflictDoNothing()
        recordingId = (await byMbid(tx, recordings, mb.mbid))!
      }
      if (!redirected) await replaceCredits(tx, recordingArtists, recordingId, mb.artistCredit, artistIds)

      const trackValues = {
        mbid: track.mbid,
        recordingId,
        title: track.title,
        artistCredit: track.artistName,
        durationMs: track.durationMs ?? mb.durationMs,
        discTitle: medium.title || null,
      }
      const [row] = await tx.insert(releaseTracks).values({ id: newId(), releaseId, disc: medium.position, position: track.position, ...trackValues })
        .onConflictDoUpdate({ target: [releaseTracks.releaseId, releaseTracks.disc, releaseTracks.position], set: trackValues })
        .returning({ id: releaseTracks.id })
      tracks.set(key, { recordingId, releaseTrackId: row!.id })
    }
  }
  // A track MusicBrainz no longer lists on this release.
  const kept = [...tracks.values()].map((track) => track.releaseTrackId)
  await tx.delete(releaseTracks).where(and(eq(releaseTracks.releaseId, releaseId), kept.length > 0 ? notInArray(releaseTracks.id, kept) : undefined))
  return { albumId, releaseId, mergedAlbumIds, artistIds, tracks }
}

/**
 * Applies `input.release` to the files in the caller's transaction: upserts its artists,
 * album (release group), release, recordings and every medium's tracks, links assigned
 * files as `matched`, and attaches extras (when asked) as `unmatched` with no track.
 * Queues enrichment for the album and artists with the transaction.
 */
export async function applyMatch(tx: Transaction, input: ApplyInput): Promise<ApplyResult> {
  await lockUpserts(tx)
  const { release, evaluation } = input
  const now = new Date()

  const files = await tx.select({ id: mediaFiles.id, recordingId: mediaFiles.recordingId, releaseId: mediaFiles.releaseId, albumId: mediaFiles.albumId })
    .from(mediaFiles).where(inArray(mediaFiles.id, input.fileIds))
  const fileIds = new Set(files.map((file) => file.id))
  const linkedAlbumIds = [...new Set(files.flatMap((file) => (file.albumId ? [file.albumId] : [])))]
  const linkedRecordingIds = [...new Set(files.flatMap((file) => (file.recordingId ? [file.recordingId] : [])))]
  const linkedReleaseIds = [...new Set(files.flatMap((file) => (file.releaseId ? [file.releaseId] : [])))]

  const localAlbums = linkedAlbumIds.length === 0 ? [] : await tx.select({ id: albums.id, primaryArtistId: albums.primaryArtistId }).from(albums)
    .where(and(inArray(albums.id, linkedAlbumIds), isNull(albums.mbid), isNull(albums.mergedIntoId)))
  const localRecordings = linkedRecordingIds.length === 0 ? [] : await tx.select({ id: recordings.id, isrcs: recordings.isrcs }).from(recordings)
    .where(and(inArray(recordings.id, linkedRecordingIds), isNull(recordings.mbid), isNull(recordings.mergedIntoId)))
  const localReleaseIds = linkedReleaseIds.length === 0 ? [] : (await tx.select({ id: releases.id }).from(releases)
    .where(and(inArray(releases.id, linkedReleaseIds), isNull(releases.mbid)))).map((row) => row.id)
  // Adopting an edition replaces its tracks, so only one no other file (a locked one) uses.
  const sharedReleaseIds = new Set(localReleaseIds.length === 0 ? [] : (await tx.selectDistinct({ id: mediaFiles.releaseId }).from(mediaFiles)
    .where(and(inArray(mediaFiles.releaseId, localReleaseIds), notInArray(mediaFiles.id, input.fileIds)))).map((row) => row.id))

  // Artists credited on the local rows are the ones that may be adopted.
  const localArtistIds = new Set(localAlbums.flatMap((album) => (album.primaryArtistId ? [album.primaryArtistId] : [])))
  if (localAlbums.length > 0) {
    for (const row of await tx.select({ id: albumArtists.artistId }).from(albumArtists).where(inArray(albumArtists.albumId, localAlbums.map((album) => album.id)))) localArtistIds.add(row.id)
  }
  if (localRecordings.length > 0) {
    for (const row of await tx.select({ id: recordingArtists.artistId }).from(recordingArtists).where(inArray(recordingArtists.recordingId, localRecordings.map((recording) => recording.id)))) localArtistIds.add(row.id)
  }

  // The album most of the files sit on is the one user data most likely points at.
  const counts = new Map<string, number>()
  for (const file of files) if (file.albumId) counts.set(file.albumId, (counts.get(file.albumId) ?? 0) + 1)
  const albumOrder = localAlbums.map((album) => album.id).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))

  // Each track adopts the local recording of the file assigned to it.
  const pairs = new Map(evaluation.pairs.filter((pair) => fileIds.has(pair.fileId)).map((pair) => [`${pair.disc}:${pair.position}`, pair]))
  const recordingOf = new Map(files.map((file) => [file.id, file.recordingId]))
  const local = new Map(localRecordings.map((recording) => [recording.id, recording]))
  const adoptRecordings = new Map<string, { id: string; isrcs: string[] }>()
  for (const [key, pair] of pairs) {
    const recording = local.get(recordingOf.get(pair.fileId) ?? '')
    if (recording) adoptRecordings.set(key, recording)
  }

  const upserted = await upsertRelease(tx, release, {
    artistIds: [...localArtistIds],
    albumIds: albumOrder,
    releaseIds: localReleaseIds.filter((id) => !sharedReleaseIds.has(id)),
    recordings: adoptRecordings,
  })
  const { albumId, releaseId } = upserted
  const links = new Map([...pairs].flatMap(([key, pair]) => {
    const track = upserted.tracks.get(key)
    return track ? [[pair.fileId, track] as const] : []
  }))

  for (const file of files) {
    const link = links.get(file.id)
    const common = { matchLocked: input.locked, matchSource: input.source, updatedAt: now }
    if (link) {
      await tx.update(mediaFiles).set({ ...common, ...link, releaseId, albumId, matchStatus: 'matched', matchConfidence: evaluation.score })
        .where(eq(mediaFiles.id, file.id))
    } else if (input.attachExtras) {
      await tx.update(mediaFiles).set({ ...common, releaseTrackId: null, releaseId, albumId, matchStatus: 'unmatched', matchConfidence: null })
        .where(eq(mediaFiles.id, file.id))
    } else {
      await tx.update(mediaFiles).set({ ...common, matchStatus: 'unmatched', matchConfidence: null }).where(eq(mediaFiles.id, file.id))
    }
  }
  await deleteOrphanLocalReleases(tx, localReleaseIds.filter((id) => id !== releaseId))

  const touchedArtists = [...new Set(upserted.artistIds.values())]
  await enqueue('enrichment.album', { albumId }, { singletonKey: albumId, tx })
  for (const artistId of touchedArtists) await enqueue('enrichment.artist', { artistId }, { singletonKey: artistId, tx })
  return { albumId, releaseId, albumIds: [albumId, ...upserted.mergedAlbumIds], artistIds: touchedArtists }
}
