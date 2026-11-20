import path from 'node:path'
import { queryKeys } from '@squirmy/contracts'
import { and, asc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import {
  albumArtists, albums, artists, libraryRoots, mediaFiles, recordingArtists, recordings, releases, releaseTracks,
} from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { albumArtFromFiles, artistImageFromFolder } from '../artwork/index.js'
import { lockCatalog, removeOrphans } from './cleanup.js'
import { albumFolder, creditText, planGroup, type Credit, type GroupPlan, type TrackPlan } from './grouping.js'
import { readFileLyrics, storeLyrics } from './lyrics.js'
import { invalidateSoon } from './progress.js'

export type IngestJob = { rootId: string; groupKey: string }

type File = typeof mediaFiles.$inferSelect
type Album = typeof albums.$inferSelect
type Release = typeof releases.$inferSelect
type ReleaseTrack = typeof releaseTracks.$inferSelect
type LinkColumn = typeof mediaFiles.albumId | typeof mediaFiles.releaseId | typeof mediaFiles.recordingId
type Links = { recordingId: string | null; releaseTrackId: string | null; releaseId: string | null; albumId: string | null }

/**
 * Builds or refreshes the catalog rows of one album group from its files' tags and links
 * every file to them, in one transaction. Running it twice changes nothing.
 *
 * - Rows the group's files already link to are reused, as long as no file outside the
 *   group links to them too; otherwise new rows are made. Rows with a MusicBrainz id in
 *   the tags are found by that id, or created with it.
 * - Local rows (no MusicBrainz id) are rewritten from the tags. Rows with an id are never
 *   renamed: MusicBrainz describes them, and the matching module keeps them current.
 * - A group with an identified file (matched, or locked by "Fix match") is only relinked:
 *   new files join the release the identified files are on.
 * - Rows the files no longer use are removed when nothing else needs them.
 */
export async function ingestGroup({ rootId, groupKey }: IngestJob) {
  const [root] = await db.select({ path: libraryRoots.path }).from(libraryRoots).where(eq(libraryRoots.id, rootId))
  if (!root) return
  const outcome = await db.transaction(async (tx) => {
    await lockCatalog(tx)
    const files = await tx.select().from(mediaFiles)
      .where(and(eq(mediaFiles.rootId, rootId), eq(mediaFiles.groupKey, groupKey), isNull(mediaFiles.missingSince), gte(mediaFiles.probeStage, 1)))
      .orderBy(asc(mediaFiles.relPath))
    if (files.length === 0) return null
    const plan = planGroup(files)
    const identified = files.some((file) => file.matchLocked || file.matchStatus === 'matched')
    const writer = new GroupWriter(tx, rootId, groupKey, files)
    const result = identified ? await writer.relink(plan) : await writer.build(plan)

    const after = await tx.select({ id: mediaFiles.id, recordingId: mediaFiles.recordingId, releaseId: mediaFiles.releaseId })
      .from(mediaFiles).where(inArray(mediaFiles.id, files.map((file) => file.id)))
    await removeOrphans(tx, {
      albumIds: [...files.map((file) => file.albumId), result.albumId],
      releaseIds: [...files.map((file) => file.releaseId), ...after.map((file) => file.releaseId)],
      recordingIds: files.map((file) => file.recordingId),
      artistIds: writer.formerArtists,
    })
    for (const releaseId of new Set(after.map((file) => file.releaseId))) {
      if (releaseId) await tx.execute(sql`update releases set track_count = (select count(*) from release_tracks where release_id = ${releaseId}) where id = ${releaseId} and fetched_at is null`)
    }
    return { albumId: result.albumId, artistIds: [...writer.touchedArtists], files, recordings: new Map(after.map((file) => [file.id, file.recordingId])) }
  })
  if (!outcome) return

  await attachFileExtras(root.path, outcome.albumId, outcome.files, outcome.recordings)
  invalidateSoon([queryKeys.library(), queryKeys.home(), queryKeys.album(outcome.albumId), ...outcome.artistIds.map((id) => queryKeys.artist(id))])
  // Handled by the matching module; until it exists the job simply waits in its queue.
  await enqueue('matching.match-album', { rootId, groupKey }, { singletonKey: groupKey })
}

/** Album and artist art from the folder and the files, and lyrics for every track. */
async function attachFileExtras(rootPath: string, albumId: string, files: File[], recordingIds: Map<string, string | null>) {
  const folders = new Set<string>()
  for (const file of files) {
    folders.add(path.join(rootPath, path.posix.dirname(file.relPath)))
    folders.add(path.join(rootPath, albumFolder(file.relPath).dir))
  }
  const embedded = files.map((file) => file.embeddedArtAssetId).filter((id): id is string => Boolean(id))
  await albumArtFromFiles(albumId, [...folders], embedded)

  // An artist folder holds album folders; one directly in the root is not an artist's.
  const albumDir = albumFolder(files[0]!.relPath).dir
  const [album] = await db.select({ primaryArtistId: albums.primaryArtistId }).from(albums).where(eq(albums.id, albumId))
  if (album?.primaryArtistId && albumDir.includes('/')) {
    await artistImageFromFolder(album.primaryArtistId, path.join(rootPath, path.posix.dirname(albumDir)))
  }

  for (const file of files) {
    const recordingId = recordingIds.get(file.id)
    if (!recordingId) continue
    const found = await readFileLyrics(path.join(rootPath, file.relPath), Boolean(file.tags.hasLyrics))
    if (found) await storeLyrics(recordingId, found)
  }
}

/** Most frequent non-null value. */
function majority(values: readonly (string | null)[]): string | undefined {
  const counts = new Map<string, number>()
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

class GroupWriter {
  /** Artists whose credits this run replaced, for orphan cleanup. */
  readonly formerArtists: string[] = []
  /** Artists credited on what this run wrote, for invalidation. */
  readonly touchedArtists = new Set<string>()
  private readonly artistIds = new Map<string, string>()
  private readonly filesById: Map<string, File>

  constructor(
    private readonly tx: Transaction,
    private readonly rootId: string,
    private readonly groupKey: string,
    private readonly files: File[],
  ) {
    this.filesById = new Map(files.map((file) => [file.id, file]))
  }

  /** Ids among `ids` that a file outside this group links to through `column`. */
  private async sharedOutside(column: LinkColumn, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const rows = await this.tx.selectDistinct({ id: column }).from(mediaFiles)
      .where(and(inArray(column, ids), or(ne(mediaFiles.rootId, this.rootId), ne(mediaFiles.groupKey, this.groupKey), isNull(mediaFiles.groupKey))))
    return new Set(rows.map((row) => row.id!))
  }

  /** The row most of the group's files link to, if no other group uses it. */
  private async reusable(column: LinkColumn, pick: (file: File) => string | null): Promise<string | undefined> {
    const candidate = majority(this.files.map(pick))
    if (!candidate) return undefined
    return (await this.sharedOutside(column, [candidate])).has(candidate) ? undefined : candidate
  }

  /** Finds or creates the artist for one credit: by MusicBrainz id, else by name (preferring rows with an id). */
  private async artist(credit: Credit): Promise<string> {
    const nameKey = matchKey(credit.name)
    const cacheKey = credit.mbid ? `mbid:${credit.mbid}` : `name:${nameKey}`
    const cached = this.artistIds.get(cacheKey)
    if (cached) return cached
    let id: string | undefined
    if (credit.mbid) {
      ;[{ id } = { id: undefined }] = await this.tx.select({ id: artists.id }).from(artists).where(eq(artists.mbid, credit.mbid))
    } else {
      ;[{ id } = { id: undefined }] = await this.tx.select({ id: artists.id }).from(artists)
        .where(and(eq(artists.nameKey, nameKey), isNull(artists.mergedIntoId)))
        .orderBy(sql`${artists.mbid} is null`, asc(artists.createdAt)).limit(1)
    }
    if (!id) {
      id = newId()
      await this.tx.insert(artists).values({ id, mbid: credit.mbid, name: credit.name, nameKey, detailLevel: 1 })
    }
    this.artistIds.set(cacheKey, id)
    this.touchedArtists.add(id)
    return id
  }

  private async credits(credits: Credit[]) {
    const resolved = []
    for (const [position, credit] of credits.entries()) resolved.push({ position, artistId: await this.artist(credit), creditedName: credit.name, joinPhrase: credit.joinPhrase })
    return resolved
  }

  private albumValues(plan: GroupPlan, primaryArtistId: string) {
    const artistCredit = creditText(plan.album.credits)
    return {
      title: plan.album.title,
      artistCredit,
      primaryArtistId,
      type: plan.album.type,
      releaseDate: plan.album.date ?? null,
      year: plan.album.year ?? null,
      titleKey: matchKey(plan.album.title),
      matchKey: creditKey(artistCredit, plan.album.title),
      genres: plan.album.genres,
      updatedAt: new Date(),
    }
  }

  private releaseValues(plan: GroupPlan) {
    return {
      title: plan.release.title,
      releaseDate: plan.release.date ?? null,
      label: plan.release.label ?? null,
      catalogNumber: plan.release.catalogNumber ?? null,
      barcode: plan.release.barcode ?? null,
      discCount: plan.release.discCount,
      updatedAt: new Date(),
    }
  }

  /** Picks or creates the album and release, rewriting them when they are local. */
  private async albumAndRelease(plan: GroupPlan): Promise<{ album: Album; release: Release }> {
    const { tx } = this
    let release: Release | undefined
    if (plan.release.mbReleaseId) [release] = await tx.select().from(releases).where(eq(releases.mbid, plan.release.mbReleaseId))
    let album: Album | undefined
    if (release) {
      ;[album] = await tx.select().from(albums).where(eq(albums.id, release.albumId))
    } else if (plan.album.mbReleaseGroupId) {
      ;[album] = await tx.select().from(albums).where(eq(albums.mbid, plan.album.mbReleaseGroupId))
    }
    // Only local albums are written: one created now, or the files' own album when it has no id.
    if (!album) {
      const albumCredits = await this.credits(plan.album.credits)
      const values = { mbid: plan.album.mbReleaseGroupId, ...this.albumValues(plan, albumCredits[0]!.artistId) }
      const linked = await this.reusable(mediaFiles.albumId, (file) => file.albumId)
      if (linked) [album] = await tx.update(albums).set(values).where(and(eq(albums.id, linked), isNull(albums.mbid))).returning()
      if (!album) [album] = await tx.insert(albums).values({ id: newId(), detailLevel: 1, ...values }).returning()
      const former = await tx.delete(albumArtists).where(eq(albumArtists.albumId, album!.id)).returning({ artistId: albumArtists.artistId })
      this.formerArtists.push(...former.map((row) => row.artistId))
      await tx.insert(albumArtists).values(albumCredits.map((credit) => ({ albumId: album!.id, ...credit })))
    }

    if (!release) {
      const linked = await this.reusable(mediaFiles.releaseId, (file) => file.releaseId)
      if (linked) [release] = await tx.select().from(releases).where(and(eq(releases.id, linked), eq(releases.albumId, album!.id), isNull(releases.mbid)))
      if (release) {
        ;[release] = await tx.update(releases).set({ mbid: plan.release.mbReleaseId, ...this.releaseValues(plan) }).where(eq(releases.id, release.id)).returning()
      } else {
        ;[release] = await tx.insert(releases).values({ id: newId(), albumId: album!.id, mbid: plan.release.mbReleaseId, detailLevel: 1, ...this.releaseValues(plan) }).returning()
      }
    }
    if (!album!.canonicalReleaseId) {
      ;[album] = await tx.update(albums).set({ canonicalReleaseId: release!.id }).where(eq(albums.id, album!.id)).returning()
    }
    return { album: album!, release: release! }
  }

  private recordingValues(track: TrackPlan, primaryArtistId: string) {
    const artistCredit = creditText(track.credits)
    return {
      title: track.title,
      artistCredit,
      primaryArtistId,
      durationMs: track.durationMs || null,
      isrcs: track.isrcs,
      titleKey: matchKey(track.title),
      matchKey: creditKey(artistCredit, track.title),
      updatedAt: new Date(),
    }
  }

  /** Creates a recording, or rewrites a local one, with its credits. */
  private async writeRecording(track: TrackPlan, existingId?: string): Promise<string> {
    const credits = await this.credits(track.credits)
    const values = this.recordingValues(track, credits[0]!.artistId)
    const id = existingId ?? newId()
    if (existingId) {
      await this.tx.update(recordings).set(values).where(eq(recordings.id, id))
      const former = await this.tx.delete(recordingArtists).where(eq(recordingArtists.recordingId, id)).returning({ artistId: recordingArtists.artistId })
      this.formerArtists.push(...former.map((row) => row.artistId))
    } else {
      await this.tx.insert(recordings).values({ id, mbid: track.mbRecordingId, ...values })
    }
    await this.tx.insert(recordingArtists).values(credits.map((credit) => ({ recordingId: id, ...credit })))
    return id
  }

  private async recordingByMbid(track: TrackPlan): Promise<string> {
    const [found] = await this.tx.select({ id: recordings.id }).from(recordings).where(eq(recordings.mbid, track.mbRecordingId!))
    return found?.id ?? this.writeRecording(track)
  }

  private async link(file: File, links: Links) {
    await this.tx.update(mediaFiles).set({
      ...links,
      ...(file.matchSource === null && { matchStatus: 'pending' as const, matchSource: 'tags' as const }),
      updatedAt: new Date(),
    }).where(eq(mediaFiles.id, file.id))
  }

  /** The normal path: rows built from the tags. */
  async build(plan: GroupPlan): Promise<{ albumId: string }> {
    const { tx } = this
    const { album, release } = await this.albumAndRelease(plan)
    // Releases fetched from MusicBrainz keep their own track list; files are fitted to it.
    const managed = release.fetchedAt === null
    const tracks = await tx.select().from(releaseTracks).where(eq(releaseTracks.releaseId, release.id))
    const atPosition = new Map(tracks.map((track) => [`${track.disc}:${track.position}`, track]))

    const ownIds = [...new Set(this.files.map((file) => file.recordingId).filter((id): id is string => Boolean(id)))]
    const shared = await this.sharedOutside(mediaFiles.recordingId, ownIds)
    const local = new Set(ownIds.length === 0 ? [] : (await tx.select({ id: recordings.id }).from(recordings)
      .where(and(inArray(recordings.id, ownIds), isNull(recordings.mbid)))).map((row) => row.id))
    const assigned = new Map<string, string>()
    const used = new Set<string>()

    for (const track of plan.tracks) {
      const file = this.filesById.get(track.fileId)!
      const key = `${track.disc}:${track.position}`
      const existing: ReleaseTrack | undefined = atPosition.get(key)
      let recordingId = assigned.get(key)
      if (!recordingId) {
        if (!managed && existing) recordingId = existing.recordingId
        else if (track.mbRecordingId) recordingId = await this.recordingByMbid(track)
        else if (existing && matchKey(existing.title) === matchKey(track.title) && !used.has(existing.recordingId)) recordingId = existing.recordingId
        if (!recordingId) {
          const own = file.recordingId && local.has(file.recordingId) && !shared.has(file.recordingId) && !used.has(file.recordingId) ? file.recordingId : undefined
          recordingId = await this.writeRecording(track, own)
        }
        assigned.set(key, recordingId)
        used.add(recordingId)
      }

      let releaseTrackId: string | null = existing?.id ?? null
      if (managed) {
        const values = { recordingId, title: track.title, artistCredit: creditText(track.credits), durationMs: track.durationMs || null, mbid: track.mbTrackId ?? null }
        if (existing) {
          await tx.update(releaseTracks).set(values).where(eq(releaseTracks.id, existing.id))
        } else {
          releaseTrackId = newId()
          const inserted = { id: releaseTrackId, releaseId: release.id, disc: track.disc, position: track.position, discTitle: null, ...values }
          await tx.insert(releaseTracks).values(inserted)
          atPosition.set(key, inserted)
        }
      }
      await this.link(file, { recordingId, releaseTrackId, releaseId: release.id, albumId: album.id })
    }
    return { albumId: album.id }
  }

  /**
   * A group with identified files keeps every row as it is. Files that are neither matched
   * nor locked and not yet on the identified release join it at their disc and position,
   * or get a local recording so they still play.
   */
  async relink(plan: GroupPlan): Promise<{ albumId: string }> {
    const { tx } = this
    const anchors = this.files.filter((file) => file.matchLocked || file.matchStatus === 'matched')
    const albumId = majority(anchors.map((file) => file.albumId))
    const releaseId = majority(anchors.map((file) => file.releaseId))
    if (!albumId || !releaseId) return { albumId: albumId ?? anchors[0]!.albumId! }
    const tracks = await tx.select().from(releaseTracks).where(eq(releaseTracks.releaseId, releaseId))
    for (const track of plan.tracks) {
      const file = this.filesById.get(track.fileId)!
      if (file.matchLocked || file.matchStatus === 'matched' || (file.releaseId === releaseId && file.recordingId)) continue
      const existing = tracks.find((candidate) => (track.mbTrackId && candidate.mbid === track.mbTrackId) || (candidate.disc === track.disc && candidate.position === track.position))
      const recordingId = existing?.recordingId ?? await this.writeRecording(track)
      await this.link(file, { recordingId, releaseTrackId: existing?.id ?? null, releaseId, albumId })
    }
    return { albumId }
  }
}
