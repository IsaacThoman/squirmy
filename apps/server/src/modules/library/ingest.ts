import path from 'node:path'
import { queryKeys } from '@squirmy/contracts'
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
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
 * - Rows the group's files already link to are reused, unless they belong to another
 *   group: one with more files on them, or as many and an older file. Otherwise new rows
 *   are made. Rows with a MusicBrainz id in the tags are found by that id, or created
 *   with it.
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
    const writer = new GroupWriter(tx, rootId, groupKey, files, await requestedArtists(tx, files))
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
  // Owned by the matching module, which keys the job by `<rootId>:<groupKey>`.
  await enqueue('matching.match-album', { rootId, groupKey }, { singletonKey: `${rootId}:${groupKey}` })
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

type ResolvedCredit = { artistId: string; creditedName: string; joinPhrase: string }

/**
 * The artists a provider delivery was requested under: by name, and as whole credits keyed
 * by their credit text. A delivered file's tags name the artists as the store does ("Grimes,
 * VADAKIN" as one artist), and building rows from them put a second "Mira Vale" beside the
 * catalog artist the track was asked for, or an artist named after a whole credit, which
 * outlived the placement of the file on the requested rows. Tags only fill gaps.
 */
type RequestedArtists = {
  byName: Map<string, string>
  byCredit: Map<string, ResolvedCredit[]>
  /**
   * For a delivery of one requested recording (a played or prefetched track): its credits,
   * and the requested album's (else the recording's), which every file of the group takes
   * whatever its tags say.
   */
  sole: { track: ResolvedCredit[]; album: ResolvedCredit[] } | null
}

/** The requested recordings' and album's credits of the acquisition jobs that delivered these files, or null for files from elsewhere. */
async function requestedArtists(tx: Transaction, files: readonly File[]): Promise<RequestedArtists | null> {
  const importIds = [...new Set(files.flatMap((file) => (file.importId ? [file.importId] : [])))]
  if (importIds.length === 0) return null
  // Owned by the acquisition module: the job's requested recordings and album, after merges.
  const rows = await tx.execute<{ owner: string; credit: string; position: number; artistId: string; creditedName: string; joinPhrase: string; nameKey: string }>(sql`
    with jobs as (
      select j.id, j.recording_ids, j.album_id from acquisition_jobs j
      where j.import_id in (${sql.join(importIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ), owners as (
      select 'recording:' || r.id as owner, r.artist_credit as credit, r.id as id, 'recording' as kind
      from jobs join recordings requested on requested.id = any(jobs.recording_ids)
      join recordings r on r.id = coalesce(requested.merged_into_id, requested.id)
      union
      select 'album:' || a.id, a.artist_credit, a.id, 'album'
      from jobs join albums requested on requested.id = jobs.album_id
      join albums a on a.id = coalesce(requested.merged_into_id, requested.id)
    )
    select o.owner, o.credit, c.position, c.artist_id as "artistId", c.credited_name as "creditedName", c.join_phrase as "joinPhrase", ar.name_key as "nameKey"
    from owners o
    join lateral (
      select ra.position, ra.artist_id, ra.credited_name, ra.join_phrase from recording_artists ra where o.kind = 'recording' and ra.recording_id = o.id
      union all
      select aa.position, aa.artist_id, aa.credited_name, aa.join_phrase from album_artists aa where o.kind = 'album' and aa.album_id = o.id
    ) c on true
    join artists ar on ar.id = c.artist_id
    order by o.owner, c.position`)
  if (rows.length === 0) return null
  const byName = new Map<string, string>()
  const owners = new Map<string, { credit: string; credits: ResolvedCredit[] }>()
  for (const row of rows) {
    for (const key of [row.nameKey, matchKey(row.creditedName)]) if (key && !byName.has(key)) byName.set(key, row.artistId)
    const owner = owners.get(row.owner) ?? { credit: row.credit, credits: [] }
    owner.credits.push({ artistId: row.artistId, creditedName: row.creditedName, joinPhrase: row.joinPhrase })
    owners.set(row.owner, owner)
  }
  const byCredit = new Map<string, ResolvedCredit[]>()
  for (const owner of owners.values()) {
    const key = matchKey(owner.credit)
    if (key && !byCredit.has(key)) byCredit.set(key, owner.credits)
  }
  // One job asking for one recording: everything delivered is that recording.
  const [job] = await tx.execute<{ jobs: number; recordings: number }>(sql`
    select count(*)::int as jobs, coalesce(max(cardinality(j.recording_ids)), 0)::int as recordings from acquisition_jobs j
    where j.import_id in (${sql.join(importIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
  const recordingOwners = [...owners].filter(([key]) => key.startsWith('recording:'))
  const albumOwner = [...owners].find(([key]) => key.startsWith('album:'))
  const sole = job?.jobs === 1 && job.recordings === 1 && recordingOwners.length === 1
    ? { track: recordingOwners[0]![1].credits, album: albumOwner?.[1].credits ?? recordingOwners[0]![1].credits }
    : null
  return { byName, byCredit, sole }
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
    private readonly requested: RequestedArtists | null = null,
  ) {
    this.filesById = new Map(files.map((file) => [file.id, file]))
  }

  /**
   * Ids among `ids` that belong to another group. A row linked from several groups belongs
   * to the one with the most files on it, ties going to the group with the oldest file
   * (ids are time-ordered). The rule depends only on the links, never on which group is
   * ingested first: when a file leaves a group, the two groups are ingested in either
   * order, and a non-owner moving its files off a row never changes who owns it.
   */
  private async sharedOutside(column: LinkColumn, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const ours = sql`coalesce(${mediaFiles.rootId} = ${this.rootId} and ${mediaFiles.groupKey} = ${this.groupKey}, false)`
    const rows = await this.tx.execute<{ id: string }>(sql`
      select id from (
        select ${column} as id, ${ours} as ours,
          row_number() over (partition by ${column} order by count(*) desc, min(${mediaFiles.id}::text)) as rank
        from ${mediaFiles}
        where ${inArray(column, ids)}
        group by ${column}, ${mediaFiles.rootId}, ${mediaFiles.groupKey}
      ) owners
      where rank = 1 and not ours`)
    return new Set(rows.map((row) => row.id))
  }

  /**
   * Rows the group's files link to that no other group uses, oldest first (ids are
   * time-ordered). The oldest wins rather than the most linked: it carries the identity
   * (likes, plays), and while a moved album's files are reconnected one by one the group
   * briefly holds both the old album's files and new duplicates.
   */
  private async reusable(column: LinkColumn, pick: (file: File) => string | null): Promise<string[]> {
    const candidates = [...new Set(this.files.map(pick).filter((id): id is string => Boolean(id)))]
    const shared = await this.sharedOutside(column, candidates)
    return candidates.filter((id) => !shared.has(id)).sort()
  }

  /** Finds or creates the artist for one credit: by MusicBrainz id, else by name (preferring rows with an id). */
  private async artist(credit: Credit): Promise<string> {
    const nameKey = matchKey(credit.name)
    const requested = this.requested?.byName.get(nameKey)
    if (requested) {
      this.touchedArtists.add(requested)
      return requested
    }
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

  private async credits(credits: Credit[], role: 'album' | 'track' = 'track') {
    const sole = this.requested?.sole?.[role]
    if (sole?.length) {
      for (const credit of sole) this.touchedArtists.add(credit.artistId)
      return sole.map((credit, position) => ({ position, ...credit }))
    }
    // A delivery tagged with the whole credit of what was requested ("Grimes, VADAKIN") is
    // credited as the request is.
    const whole = this.requested?.byCredit.get(matchKey(creditText(credits)))
    if (whole) {
      for (const credit of whole) this.touchedArtists.add(credit.artistId)
      return whole.map((credit, position) => ({ position, ...credit }))
    }
    // Or with the requested artists joined another way ("Grimes, VADAKIN" for "Grimes &
    // VADAKIN"): split only when every part is one of them, so "Earth, Wind & Fire" stays whole.
    if (this.requested && credits.length === 1) {
      const parts = credits[0]!.name.split(/\s*,\s*|\s+(?:&|and|x|with|feat\.?|ft\.?|featuring)\s+/i).map((part) => part.trim()).filter(Boolean)
      const ids = parts.map((part) => this.requested!.byName.get(matchKey(part)))
      if (parts.length > 1 && ids.every(Boolean)) {
        for (const id of ids) this.touchedArtists.add(id!)
        return parts.map((name, position) => ({ position, artistId: ids[position]!, creditedName: name, joinPhrase: position < parts.length - 1 ? ', ' : '' }))
      }
    }
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
      typeGuessed: plan.album.typeGuessed,
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
      const albumCredits = await this.credits(plan.album.credits, 'album')
      const values = { mbid: plan.album.mbReleaseGroupId, ...this.albumValues(plan, albumCredits[0]!.artistId) }
      const [linked] = await tx.select({ id: albums.id }).from(albums)
        .where(and(inArray(albums.id, await this.reusable(mediaFiles.albumId, (file) => file.albumId)), isNull(albums.mbid)))
        .orderBy(asc(albums.id)).limit(1)
      if (linked) [album] = await tx.update(albums).set(values).where(eq(albums.id, linked.id)).returning()
      if (!album) [album] = await tx.insert(albums).values({ id: newId(), detailLevel: 1, ...values }).returning()
      const former = await tx.delete(albumArtists).where(eq(albumArtists.albumId, album!.id)).returning({ artistId: albumArtists.artistId })
      this.formerArtists.push(...former.map((row) => row.artistId))
      await tx.insert(albumArtists).values(albumCredits.map((credit) => ({ albumId: album!.id, ...credit })))
    }

    if (!release) {
      ;[release] = await tx.select().from(releases)
        .where(and(inArray(releases.id, await this.reusable(mediaFiles.releaseId, (file) => file.releaseId)), eq(releases.albumId, album!.id), isNull(releases.mbid)))
        .orderBy(asc(releases.id)).limit(1)
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
