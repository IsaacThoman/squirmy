/**
 * Deciding whether a delivery is what was asked for.
 *
 * A requested recording is satisfied when, after the import:
 * 1. it (after following merges) has a present file, which is the case when the pipeline
 *    linked a delivered file to it, or the library already had it; or
 * 2. a delivered file is plainly the same recording: its recording shares an ISRC with the
 *    requested one (from the catalog or the file's tags), or has the same title (edition
 *    suffixes such as "(Remastered 2009)" aside) and artist with a duration within
 *    {@link DURATION_TOLERANCE_MS}; with an AcoustID key set and a
 *    requested MusicBrainz id, AcoustID must not name other recordings for the file. Two
 *    rows with different MusicBrainz ids are never the same.
 *
 * In case 2 the two recordings are merged, so the id sessions and playlists hold plays:
 * - a row with a MusicBrainz id beats one without (a search stub is merged into the
 *   identified row the pipeline matched the file to; a local-only row from the file's tags
 *   is merged into an identified requested row);
 * - otherwise the requested row wins, because it is the one users already refer to.
 * The loser keeps a redirect, and ids that point at it keep resolving.
 */
import path from 'node:path'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { getServerSettings } from '../../lib/settings.js'
import { db } from '../../database/client.js'
import { libraryRoots, mediaFiles, recordings } from '../../database/schema.js'
import { resolveMerged } from '../catalog/redirects.js'
import { mergeRecording } from '../matching/merge.js'
import { editionFreeKey } from '../search/keys.js'
import { acoustid } from '../metadata/index.js'
import { ownedRecordings } from './catalog.js'
import type { JobRow } from './jobs.js'

/** How far a delivered file's length may be from the requested recording's. */
export const DURATION_TOLERANCE_MS = 5000

type Recording = typeof recordings.$inferSelect
type DeliveredFile = { id: string; recordingId: string; durationMs: number; isrcs: string[]; fingerprint: string | null; absolutePath: string }

const artistOf = (matchKey: string) => matchKey.split('|')[0] ?? ''
/** One credit is the other with more names after it ("artist" and "artist feat other"). */
const sameArtist = (a: string, b: string) => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)

function report(error: unknown) {
  if (getConfig().LOG_LEVEL !== 'silent') console.error('[acquisition]', error)
}

/** True when AcoustID knows the file and names recordings other than `mbid` only. */
async function acoustIdDisagrees(file: DeliveredFile, mbid: string): Promise<boolean> {
  if (!(await getServerSettings()).acoustIdKeySet) return false
  try {
    const print = file.fingerprint
      ? { fingerprint: file.fingerprint, durationSec: Math.round(file.durationMs / 1000) }
      : await acoustid.fingerprint(file.absolutePath)
    if (!print) return false
    const matches = await acoustid.lookup(print.fingerprint, print.durationSec)
    return matches.length > 0 && !matches.some((match) => match.recordingMbid === mbid)
  } catch (error) {
    // No verdict from AcoustID leaves the decision to the tags.
    report(error)
    return false
  }
}

/** Whether `delivered` (the recording a delivered file is linked to) is plainly `requested`. */
export async function sameRecording(requested: Recording, delivered: Recording, file: DeliveredFile): Promise<boolean> {
  if (requested.mbid && delivered.mbid && requested.mbid !== delivered.mbid) return false
  const isrcs = new Set([...delivered.isrcs, ...file.isrcs].map((isrc) => isrc.toUpperCase()))
  if (requested.isrcs.some((isrc) => isrcs.has(isrc.toUpperCase()))) return true
  if (editionFreeKey(requested.title) !== editionFreeKey(delivered.title) || !sameArtist(artistOf(requested.matchKey), artistOf(delivered.matchKey))) return false
  if (requested.durationMs === null || Math.abs(requested.durationMs - file.durationMs) > DURATION_TOLERANCE_MS) return false
  return !(requested.mbid && await acoustIdDisagrees(file, requested.mbid))
}

/** Merges the two rows the way the module comment describes; returns nothing. */
export async function mergeDelivered(requested: Recording, delivered: Recording) {
  if (delivered.mbid && !requested.mbid) await mergeRecording(requested.id, delivered.id)
  else await mergeRecording(delivered.id, requested.id)
}

/**
 * Checks a finished import against the job's recordings, merging where a delivered file is
 * plainly a requested recording. Returns the requested ids (as the job holds them) that
 * now play.
 */
export async function verifyDelivery(job: JobRow): Promise<string[]> {
  const satisfied = new Set(await ownedRecordings(job.recordingIds))
  const open = job.recordingIds.filter((id) => !satisfied.has(id))
  if (open.length === 0 || !job.importId) return [...satisfied]

  const files = await db.select({
    id: mediaFiles.id, recordingId: mediaFiles.recordingId, durationMs: mediaFiles.durationMs, tags: mediaFiles.tags,
    fingerprint: mediaFiles.fingerprint, relPath: mediaFiles.relPath, rootPath: libraryRoots.path,
  }).from(mediaFiles).innerJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
    .where(and(eq(mediaFiles.importId, job.importId), isNull(mediaFiles.missingSince), isNotNull(mediaFiles.recordingId)))
    .orderBy(mediaFiles.relPath)
  const resolved = await resolveMerged('recordings', [...open, ...files.map((file) => file.recordingId!)])
  const rows = new Map<string, Recording>()
  const load = async (id: string) => {
    if (!rows.has(id)) {
      const [row] = await db.select().from(recordings).where(eq(recordings.id, id))
      if (row) rows.set(id, row)
    }
    return rows.get(id)
  }

  const used = new Set<string>()
  for (const requestedId of open) {
    const requested = await load(resolved.get(requestedId) ?? requestedId)
    if (!requested) continue
    for (const file of files) {
      if (used.has(file.id)) continue
      const delivered = await load(resolved.get(file.recordingId!) ?? file.recordingId!)
      if (!delivered || delivered.id === requested.id) continue
      const candidate: DeliveredFile = {
        id: file.id, recordingId: delivered.id, durationMs: file.durationMs, isrcs: file.tags.isrcs ?? [],
        fingerprint: file.fingerprint, absolutePath: path.join(file.rootPath, file.relPath),
      }
      if (!await sameRecording(requested, delivered, candidate)) continue
      await mergeDelivered(requested, delivered)
      used.add(file.id)
      satisfied.add(requestedId)
      break
    }
  }
  return job.recordingIds.filter((id) => satisfied.has(id))
}
