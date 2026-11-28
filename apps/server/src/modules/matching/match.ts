/**
 * The album matcher behind `matching.match-album`: gathers candidate releases in tiers
 * (MusicBrainz ids, barcodes and ISRCs from tags, a release search, AcoustID fingerprints), scores them
 * and applies the best, opens a review, or leaves the files local-only.
 */
import path from 'node:path'
import { INCOMING_FOLDER, queryKeys, type MatchCandidate, type MatchGroupSummary, type ServerSettings } from '@squirmy/contracts'
import { and, count, eq, gte, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { imports, libraryRoots, matchReviews, mediaFiles, type MatchSource } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { getServerSettings } from '../../lib/settings.js'
import { invalidate, publish, publishChanges } from '../../realtime/index.js'
import { holdsCollection, saversOf } from '../catalog/availability.js'
import { lockCatalog } from '../library/cleanup.js'
import { acoustid, musicbrainz } from '../metadata/index.js'
import type { MbRelease, MbReleaseSummary } from '../metadata/musicbrainz.js'
import { applyMatch, type ApplyResult } from './apply.js'
import { majority, taggedAlbumArtist } from './local.js'
import { dateOrder, evaluate, preferredFormat, rank, textSimilarity, toCandidate, type Evaluation, type FileEvidence, type GroupEvidence } from './score.js'

export type GroupFile = typeof mediaFiles.$inferSelect

/** A release scored against some files, and the tier that found it. */
export type Found = { release: MbRelease; evaluation: Evaluation; source: MatchSource }

/** Below this, a candidate is not worth an admin's time and the files stay local-only. */
const reviewFloor = 0.5
/** Releases fetched per search; each costs a MusicBrainz request (one a second). */
const fetchLimit = 3
/** Candidates kept on a review. */
const reviewCandidates = 5
/** Maximum recording lookups to select releases from ISRCs or fingerprints. */
const voters = 5
/** AcoustID matches below this are ignored. */
const minFingerprintScore = 0.5

/**
 * True for a file an import has not finished deciding about: one in `_Incoming/<importId>/`
 * of the import's root while the import is processing and has not yet removed its
 * duplicates. Automatic matching leaves such files alone, so no provider is asked about
 * copies that are about to be deleted, or about part of an album still arriving. Once the
 * import has decided, it queues matching for its groups itself. See `decideDuplicates`
 * and `queueMatches` in `imports/process.ts`.
 */
const heldByImport = sql`starts_with(${mediaFiles.relPath}, ${`${INCOMING_FOLDER}/`}) and exists (
  select 1 from ${imports} where ${imports.status} = 'processing' and ${imports.duplicatesDecidedAt} is null
    and ${imports.targetRootId} = ${mediaFiles.rootId} and starts_with(${mediaFiles.relPath}, ${`${INCOMING_FOLDER}/`} || ${imports.id} || '/'))`

/** The singleton key of a group's match job; the library module uses the same one. */
export function matchJobKey(rootId: string, groupKey: string): string {
  return `${rootId}:${groupKey}`
}

function tagYear(tags: GroupFile['tags']): number | null {
  return tags.year ?? (Number(/^(\d{4})/.exec(tags.date ?? '')?.[1]) || null)
}

/** What one file says about itself. */
function fileEvidence(file: GroupFile): FileEvidence {
  const { tags } = file
  return {
    id: file.id,
    title: tags.title?.trim() || null,
    artist: tags.artist?.trim() || null,
    disc: tags.disc ?? null,
    track: tags.track ?? null,
    durationMs: file.durationMs || null,
    recordingMbids: tags.mbRecordingId ? [tags.mbRecordingId.toLowerCase()] : [],
  }
}

/**
 * What a group says. Files with an album tag are an album; files without one are loose
 * tracks, each matched on its own.
 */
export function groupEvidence(files: GroupFile[], fallback: { artist?: string; album?: string } = {}): GroupEvidence {
  const tags = files.map((file) => file.tags)
  const album = majority(tags.map((tag) => tag.album?.trim())) ?? fallback.album ?? null
  return {
    mode: album ? 'album' : 'track',
    artist: taggedAlbumArtist(tags) ?? fallback.artist ?? null,
    album,
    year: majority(tags.map(tagYear)),
    files: files.map(fileEvidence),
  }
}

/** The group as a review shows it. */
function groupSummary(files: GroupFile[]): MatchGroupSummary {
  const evidence = groupEvidence(files)
  const folders = files.map((file) => path.posix.dirname(file.relPath).split('/'))
  const common: string[] = []
  for (let index = 0; folders.every((parts) => parts[index] !== undefined && parts[index] === folders[0]![index]); index++) common.push(folders[0]![index]!)
  return { artist: evidence.artist, album: evidence.album, year: evidence.year, trackCount: files.length, folder: common.join('/') || '.' }
}

/**
 * Orders release summaries by how likely their track list fits, before any is fetched,
 * and keeps the first `limit` with distinct shapes: pressings of one edition share a
 * track list, so fetching more than one of them only costs time.
 */
function preselect(summaries: MbReleaseSummary[], evidence: GroupEvidence, limit = fetchLimit, votes?: Map<string, number>): string[] {
  const fileCount = evidence.files.length
  const discs = new Set(evidence.files.map((file) => file.disc ?? 1)).size
  const priority = (release: MbReleaseSummary) => {
    const group = release.releaseGroup
    let value = (votes?.get(release.mbid) ?? 0) * 10 + (release.score ?? 0) / 500
    if (evidence.mode === 'album') {
      if (discs > 1 && release.media.length === discs) value += 0.3
      if (release.trackCount > 0) value += release.trackCount === fileCount ? 1 : Math.min(release.trackCount, fileCount) / Math.max(release.trackCount, fileCount) * 0.6
      if (evidence.album) value += textSimilarity(evidence.album, release.title) * 0.3
      if (evidence.year && release.year === evidence.year) value += 0.15
    } else if (group) {
      // A loose track most likely came from the studio album it first appeared on.
      if (group.primaryType === 'Album') value += 0.3
      if (group.secondaryTypes.length === 0) value += 0.3
    }
    if (release.status === 'official') value += 0.2
    if (release.status === 'pseudo-release') value -= 0.5
    // Files are far more often ripped from a CD or bought digitally than from vinyl or tape.
    if (release.media.length > 0 && release.media.every((medium) => preferredFormat.test(medium.format ?? ''))) value += 0.2
    return value
  }
  const ordered = summaries
    .map((release) => ({ release, value: priority(release) }))
    .sort((a, b) => b.value - a.value || dateOrder(a.release.date).localeCompare(dateOrder(b.release.date)))
  const chosen: string[] = []
  const shapes = new Set<string>()
  for (const { release } of ordered) {
    const shape = evidence.mode === 'album'
      ? `${release.releaseGroup?.mbid}:${release.trackCount}:${release.media.length}`
      : release.releaseGroup?.mbid ?? release.mbid
    if (shapes.has(shape) || chosen.includes(release.mbid)) continue
    shapes.add(shape)
    chosen.push(release.mbid)
    if (chosen.length >= limit) break
  }
  return chosen
}

/** Fetches releases not seen yet and scores them. */
async function fetchAndScore(evidence: GroupEvidence, mbids: string[], source: MatchSource, found: Map<string, Found>) {
  for (const mbid of mbids) {
    if (found.has(mbid)) continue
    const release = await musicbrainz.getRelease(mbid)
    if (release) found.set(release.mbid, { release, evaluation: evaluate(evidence, release), source })
  }
}

/**
 * Scores the releases a link or MBID names: a release, or the likeliest releases of a
 * release group. A bare MBID is tried as a release first. False when the text has no MBID.
 */
async function releasesFromIds(evidence: GroupEvidence, text: string, source: MatchSource, found: Map<string, Found>): Promise<boolean> {
  const mbid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text)?.[0]?.toLowerCase()
  if (!mbid) return false
  const groupLink = /release-group\//i.test(text)
  if (!groupLink) await fetchAndScore(evidence, [mbid], source, found)
  if (groupLink || (!/release\//i.test(text) && !found.has(mbid))) {
    const group = await musicbrainz.getReleaseGroup(mbid)
    if (group) await fetchAndScore(evidence, preselect(group.releases, evidence), source, found)
  }
  return true
}

/** Ignore an edition or group id that appears only on a minority of the files. */
function sharedId(files: GroupFile[], field: 'mbReleaseId' | 'mbReleaseGroupId') {
  const ids = files.map((file) => file.tags[field]?.toLowerCase())
  const id = majority(ids)
  return id && ids.filter((value) => value === id).length >= files.length / 2 ? id : null
}

async function fromTagRelease(evidence: GroupEvidence, files: GroupFile[], found: Map<string, Found>) {
  const id = sharedId(files, 'mbReleaseId')
  if (id) await fetchAndScore(evidence, [id], 'tags-mbid', found)
}

async function fromTagReleaseGroup(evidence: GroupEvidence, files: GroupFile[], found: Map<string, Found>) {
  const id = sharedId(files, 'mbReleaseGroupId')
  if (id) await releasesFromIds(evidence, `release-group/${id}`, 'tags-mbid', found)
}

async function fromBarcode(evidence: GroupEvidence, files: GroupFile[], found: Map<string, Found>) {
  const barcode = majority(files.map((file) => file.tags.barcode?.trim()))
  if (!barcode || !/^\d+$/.test(barcode) || !/[1-9]/.test(barcode)) return
  const releases = await musicbrainz.findReleasesByBarcode(barcode)
  await fetchAndScore(evidence, preselect(releases, evidence), 'tags-barcode', found)
}

/**
 * An ISRC identifies a recording. Use a few distinct codes to find editions that fit the group.
 * Runs after the search: it costs up to `voters` rate-limited requests, and the search
 * settles most albums in one.
 */
async function fromIsrcs(evidence: GroupEvidence, files: GroupFile[], found: Map<string, Found>) {
  const codes = new Set(files.flatMap((file) => file.tags.isrcs ?? []))
  if (codes.size === 0) return
  const recordingsByCode = new Map<string, string[]>()
  const votes = new Map<string, number>()
  const releases = new Map<string, MbReleaseSummary>()
  for (const code of [...codes].slice(0, voters)) {
    const recordings = await musicbrainz.findRecordingsByIsrc(code)
    recordingsByCode.set(code, recordings.map((recording) => recording.mbid))
    const editions = new Map(recordings.flatMap((recording) => recording.releases.map((release) => [release.mbid, release] as const)))
    for (const release of editions.values()) {
      if (evidence.mode === 'album' && release.trackCount !== files.length) continue
      votes.set(release.mbid, (votes.get(release.mbid) ?? 0) + 1)
      releases.set(release.mbid, release)
    }
  }
  for (const [index, file] of files.entries()) {
    const recordingMbids = file.tags.isrcs?.flatMap((code) => recordingsByCode.get(code) ?? []) ?? []
    evidence.files[index]!.recordingMbids.push(...recordingMbids)
  }
  for (const entry of found.values()) entry.evaluation = evaluate(evidence, entry.release)
  await fetchAndScore(evidence, preselect([...releases.values()], evidence, fetchLimit, votes), 'tags-isrc', found)
}

/** A release search on album artist, title and track count. */
async function searchAlbum(evidence: GroupEvidence, files: GroupFile[], found: Map<string, Found>, query?: { artist: string; release: string }) {
  const artist = query?.artist ?? evidence.artist
  const release = query?.release ?? evidence.album
  if (!artist || !release) return
  const barcode = query ? undefined : majority(files.map((file) => file.tags.barcode?.trim())) ?? undefined
  const catno = query ? undefined : majority(files.map((file) => file.tags.catalogNumber?.trim())) ?? undefined
  const results = await musicbrainz.searchReleases({
    artist,
    release,
    tracks: evidence.files.length,
    ...(barcode ? { barcode } : {}),
    ...(catno ? { catno } : {}),
  }, { limit: 10 })
  await fetchAndScore(evidence, preselect(results, evidence), 'search', found)
}

/**
 * Fingerprints the files, records the recordings AcoustID knows them as (strong
 * evidence for scoring), and votes for the releases a few of those recordings appear on.
 */
async function fromFingerprints(evidence: GroupEvidence, files: GroupFile[], found: Map<string, Found>) {
  const [root] = await db.select({ path: libraryRoots.path }).from(libraryRoots).where(eq(libraryRoots.id, files[0]!.rootId))
  if (!root) return
  const best: string[] = []
  for (const [index, file] of files.entries()) {
    let print = file.fingerprint ? { fingerprint: file.fingerprint, durationSec: Math.round(file.durationMs / 1000) } : null
    // A file fpcalc cannot decode simply has no fingerprint.
    print ??= await acoustid.fingerprint(path.join(root.path, file.relPath)).catch(() => null)
    if (!print) continue
    const matches = (await acoustid.lookup(print.fingerprint, print.durationSec)).filter((match) => match.score >= minFingerprintScore)
    evidence.files[index]!.recordingMbids.push(...matches.map((match) => match.recordingMbid))
    await db.update(mediaFiles).set({ fingerprint: print.fingerprint, acoustid: matches[0]?.acoustId ?? file.acoustid }).where(eq(mediaFiles.id, file.id))
    if (matches[0]) best.push(matches[0].recordingMbid)
  }
  const votes = new Map<string, number>()
  const releases = new Map<string, MbReleaseSummary>()
  for (const mbid of best.slice(0, voters)) {
    const recording = await musicbrainz.getRecording(mbid)
    for (const release of recording?.releases ?? []) {
      votes.set(release.mbid, (votes.get(release.mbid) ?? 0) + 1)
      releases.set(release.mbid, release)
    }
  }
  await fetchAndScore(evidence, preselect([...releases.values()], evidence, fetchLimit, votes), 'acoustid', found)
}

/** Every candidate for one album or loose track, best first. */
async function findCandidates(evidence: GroupEvidence, files: GroupFile[], settings: ServerSettings): Promise<Found[]> {
  const found = new Map<string, Found>()
  for (const tier of [fromTagRelease, fromTagReleaseGroup, fromBarcode, searchAlbum, fromIsrcs]) {
    await tier(evidence, files, found)
    const accepted = rank([...found.values()]).find(({ evaluation }) => isPlausible(evaluation) && evaluation.score >= settings.matchAutoAcceptScore)
    if (accepted) return [accepted]
  }
  if (settings.acoustIdKeySet) {
    await fromFingerprints(evidence, files, found)
    // Fingerprints are new evidence for releases found at any earlier tier.
    for (const entry of found.values()) entry.evaluation = evaluate(evidence, entry.release)
  }
  return rank([...found.values()])
}

function isPlausible(evaluation: Evaluation) {
  return evaluation.score >= reviewFloor && evaluation.pairs.length > 0
}

/**
 * Candidates for "Fix match": from a query (a release or release-group link or MBID,
 * "Artist - Album", or a title by the album's own artist), else from the tags' MusicBrainz
 * ids and a search. Never fingerprints, so it answers quickly.
 */
export async function albumCandidates(evidence: GroupEvidence, files: GroupFile[], query?: string): Promise<Found[]> {
  const found = new Map<string, Found>()
  if (!query) {
    if (sharedId(files, 'mbReleaseId')) await fromTagRelease(evidence, files, found)
    else await fromTagReleaseGroup(evidence, files, found)
    await searchAlbum(evidence, files, found)
  } else if (!(await releasesFromIds(evidence, query, 'manual', found))) {
    const [artist, ...rest] = query.split(/\s+[-–—]\s+/)
    const named = rest.length > 0 ? { artist: artist!, release: rest.join(' - ') } : { artist: evidence.artist ?? '', release: query }
    await searchAlbum(evidence, files, found, named)
  }
  return rank([...found.values()])
}

/** The present files of a group, optionally only those automatic matching may change. */
export async function groupFiles(executor: typeof db | Transaction, rootId: string, groupKey: string, unlockedOnly: boolean): Promise<GroupFile[]> {
  return executor.select().from(mediaFiles).where(and(
    eq(mediaFiles.rootId, rootId),
    eq(mediaFiles.groupKey, groupKey),
    isNull(mediaFiles.missingSince),
    gte(mediaFiles.probeStage, 1),
    unlockedOnly ? eq(mediaFiles.matchLocked, false) : undefined,
  )).orderBy(mediaFiles.relPath)
}

/** Opens (or reopens) the group's review with fresh candidates. */
async function upsertReview(tx: Transaction, rootId: string, groupKey: string, files: GroupFile[], candidates: MatchCandidate[]) {
  const values = { summary: groupSummary(files), candidates, status: 'open', resolvedBy: null, resolvedAt: null }
  await tx.insert(matchReviews).values({ id: newId(), rootId, groupKey, ...values })
    .onConflictDoUpdate({ target: [matchReviews.rootId, matchReviews.groupKey], set: values })
}

/** Closes the group's open review, if any. */
export async function closeReview(tx: Transaction, rootId: string, groupKey: string, status: 'resolved' | 'dismissed', userId: string | null) {
  await tx.update(matchReviews).set({ status, resolvedBy: userId, resolvedAt: new Date() })
    .where(and(eq(matchReviews.rootId, rootId), eq(matchReviews.groupKey, groupKey), eq(matchReviews.status, 'open')))
}

/**
 * Tells open screens which albums and artists changed, and admins that reviews may have.
 * The pages of those albums and artists are refetched where they are open. Library lists
 * and Home move for everyone only when the albums hold collection files; music a provider
 * delivered is in no library but the libraries of users who saved it. Searches are never
 * run again for it: what they list changes availability, which comes as a patch.
 */
export async function announce(albumIds: string[], artistIds: string[], recordingIds: string[] = []) {
  if (albumIds.length + artistIds.length > 0) {
    await publishChanges('all', [
      { kind: 'updated', entity: 'album', ids: [...new Set(albumIds)] },
      { kind: 'updated', entity: 'artist', ids: [...new Set(artistIds)] },
    ])
    if (await holdsCollection(albumIds)) {
      await invalidate('all', [queryKeys.library(), queryKeys.home()])
    } else {
      for (const user of await saversOf(albumIds, recordingIds)) await invalidate({ user }, [queryKeys.libraryTracks()])
    }
  }
  await invalidate('admins', [queryKeys.adminReviews()])
}

async function publishProgress(rootId: string) {
  const rows = await db.select({ pending: sql<number>`count(*) filter (where ${mediaFiles.matchStatus} = 'pending')::int`, total: count() })
    .from(mediaFiles).where(and(eq(mediaFiles.rootId, rootId), isNull(mediaFiles.missingSince), gte(mediaFiles.probeStage, 1)))
  const { pending = 0, total = 0 } = rows[0] ?? {}
  await publish('admins', { type: 'scan.progress', rootId, phase: 'matching', processed: total - pending, total })
}

/** Rounds of `matchGroup` for files that keep arriving while it runs; the sweep catches anything later. */
const MATCH_ROUNDS = 3

/**
 * Runs automatic matching for one album group. Does nothing unless an unlocked file of the
 * group is `pending`, so running it again is a no-op; leaves files `pending` while
 * MusicBrainz is switched off or an import holds them (see `heldByImport`). Provider
 * failures throw so the job retries.
 *
 * A file of the group ingested while a match runs queues a job with this one's singleton
 * key, which pg-boss drops while this job is active. So the group is matched again when such
 * a file arrived, rather than leaving it pending until the next sweep.
 */
export async function matchGroup(rootId: string, groupKey: string): Promise<void> {
  for (let round = 0; round < MATCH_ROUNDS; round++) {
    const matched = await matchRound(rootId, groupKey)
    if (!matched) return
    const [late] = await db.select({ id: mediaFiles.id }).from(mediaFiles).where(and(
      eq(mediaFiles.rootId, rootId), eq(mediaFiles.groupKey, groupKey), eq(mediaFiles.matchStatus, 'pending'), eq(mediaFiles.matchLocked, false),
      isNull(mediaFiles.missingSince), gte(mediaFiles.probeStage, 1), notInArray(mediaFiles.id, matched),
    )).limit(1)
    if (!late) return
  }
}

/** One matching pass over the group as it is now. Returns the ids of the files it looked at, or null when it did nothing. */
async function matchRound(rootId: string, groupKey: string): Promise<string[] | null> {
  const settings = await getServerSettings()
  if (!settings.musicBrainzEnabled) return null
  const files = await groupFiles(db, rootId, groupKey, true)
  if (!files.some((file) => file.matchStatus === 'pending')) return null
  const [held] = await db.select({ id: mediaFiles.id }).from(mediaFiles)
    .where(and(inArray(mediaFiles.id, files.map((file) => file.id)), heldByImport)).limit(1)
  if (held) return null

  const evidence = groupEvidence(files)
  // Loose tracks share a group only because they share a folder; each is matched alone.
  const units = evidence.mode === 'album'
    ? [{ evidence, files }]
    : files.map((file) => ({ evidence: { ...groupEvidence([file]), artist: file.tags.artist?.trim() || null }, files: [file] }))
  const decided: { files: GroupFile[]; best: Found | undefined; candidates: Found[]; attachExtras: boolean }[] = []
  for (const unit of units) {
    const candidates = await findCandidates(unit.evidence, unit.files, settings)
    decided.push({ files: unit.files, best: candidates[0], candidates, attachExtras: unit.evidence.mode === 'album' })
  }

  const applied: ApplyResult[] = []
  let reviewOpened = false
  await db.transaction(async (tx) => {
    // Applying merges and relinks catalog rows, as ingest does for the same group; without
    // the catalog lock, taken before any row lock, the two deadlock.
    await lockCatalog(tx)
    // Files locked while the network calls ran are no longer ours to change, and neither are
    // files identified meanwhile: an acquisition delivery is placed on the album it was
    // requested from as soon as it is checked (`place.ts`).
    const ids = files.map((file) => file.id)
    const before = new Map(files.map((file) => [file.id, file.matchStatus]))
    const open = new Set((await tx.select({ id: mediaFiles.id, matchStatus: mediaFiles.matchStatus }).from(mediaFiles)
      .where(and(inArray(mediaFiles.id, ids), eq(mediaFiles.matchLocked, false))).for('update'))
      .filter((row) => row.matchStatus !== 'matched' || before.get(row.id) === 'matched').map((row) => row.id))
    for (const unit of decided) {
      const fileIds = unit.files.map((file) => file.id).filter((id) => open.has(id))
      if (fileIds.length === 0) continue
      const score = unit.best?.evaluation.score ?? 0
      const plausible = unit.best && isPlausible(unit.best.evaluation)
      if (unit.best && plausible && score >= settings.matchAutoAcceptScore) {
        applied.push(await applyMatch(tx, { ...unit.best, fileIds, locked: false, attachExtras: unit.attachExtras }))
      } else if (plausible && units.length === 1 && !unit.files.every((file) => file.cached)) {
        // A review belongs to a whole group, so loose tracks sharing a folder get none. A
        // group of provider deliveries gets none either: acquisition places what was asked
        // for and deletes the rest, so no admin is ever needed for what listening fetched.
        await tx.update(mediaFiles).set({ matchStatus: 'review', matchConfidence: score, updatedAt: new Date() }).where(inArray(mediaFiles.id, fileIds))
        await upsertReview(tx, rootId, groupKey, files, unit.candidates.slice(0, reviewCandidates).map((found) => toCandidate(found.release, found.evaluation)))
        reviewOpened = true
      } else {
        await tx.update(mediaFiles).set({ matchStatus: 'unmatched', matchConfidence: null, updatedAt: new Date() }).where(inArray(mediaFiles.id, fileIds))
      }
    }
    if (!reviewOpened) await closeReview(tx, rootId, groupKey, 'resolved', null)
  })
  await announce(applied.flatMap((result) => result.albumIds), applied.flatMap((result) => result.artistIds))
  await publishProgress(rootId)
  return files.map((file) => file.id)
}

/**
 * Queues `matching.match-album` for up to `batch` groups that still have pending files no
 * import holds, oldest first. Groups already queued are skipped by their singleton key.
 * Returns how many jobs were queued.
 */
export async function sweep(batch = 100): Promise<number> {
  if (!(await getServerSettings()).musicBrainzEnabled) return 0
  const groups = await db.select({ rootId: mediaFiles.rootId, groupKey: mediaFiles.groupKey }).from(mediaFiles)
    .where(and(
      eq(mediaFiles.matchStatus, 'pending'),
      eq(mediaFiles.matchLocked, false),
      isNull(mediaFiles.missingSince),
      gte(mediaFiles.probeStage, 1),
      sql`${mediaFiles.groupKey} is not null and ${mediaFiles.recordingId} is not null`,
      sql`not (${heldByImport})`,
    ))
    .groupBy(mediaFiles.rootId, mediaFiles.groupKey)
    .orderBy(sql`min(${mediaFiles.addedAt})`)
    .limit(batch)
  let queued = 0
  for (const { rootId, groupKey } of groups) {
    if (await enqueue('matching.match-album', { rootId, groupKey: groupKey! }, { singletonKey: matchJobKey(rootId, groupKey!) })) queued++
  }
  return queued
}
