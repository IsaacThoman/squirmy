/**
 * Identification a settings change makes possible. `PATCH /admin/settings` calls
 * `queueNewlyPossibleMatching` with the settings before and after:
 * - MusicBrainz switched on: groups left `pending` while it was off are swept at once,
 *   instead of at the next ten-minute sweep.
 * - An AcoustID key added: files that went `unmatched` because their tags give nothing to
 *   search for (loose tracks, albums without an artist or title) are set back to
 *   `pending`, since only fingerprints were missing. Albums that were searched by their
 *   tags and found nothing are left alone: matching never fingerprints those, so the key
 *   could not change their answer. Locked files ("keep as it is") are never touched.
 * Either way the work goes through `sweep` and `matching.match-album`, so batch sizes and
 * rate limits are those of every other match.
 */
import type { ServerSettings } from '@squirmy/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { groupEvidence, groupFiles, sweep } from './match.js'

/** Queues the matching that switching MusicBrainz on or adding an AcoustID key allows. */
export async function queueNewlyPossibleMatching(before: ServerSettings, after: ServerSettings): Promise<void> {
  // Keyless, so a sweep that started before the change cannot swallow this one.
  if (!before.musicBrainzEnabled && after.musicBrainzEnabled) await enqueue('matching.sweep', {})
  if (!before.acoustIdKeySet && after.acoustIdKeySet) await enqueue('matching.retry-fingerprints', {}, { singletonKey: 'retry-fingerprints' })
}

/** An empty or missing text tag. */
const blank = (field: string) => sql`coalesce(btrim(${mediaFiles.tags} ->> ${field}), '') = ''`

/**
 * Sets unlocked `unmatched` files back to `pending` in every group that matching would
 * fingerprint (no album artist and title to search by), then sweeps. Files with a known
 * AcoustID were fingerprinted and looked up already. Returns how many files it reset.
 */
export async function retryWithFingerprints(): Promise<number> {
  const groups = await db.selectDistinct({ rootId: mediaFiles.rootId, groupKey: mediaFiles.groupKey }).from(mediaFiles).where(and(
    eq(mediaFiles.matchStatus, 'unmatched'),
    eq(mediaFiles.matchLocked, false),
    sql`${mediaFiles.missingSince} is null and ${mediaFiles.probeStage} >= 1 and ${mediaFiles.acoustid} is null`,
    sql`${mediaFiles.groupKey} is not null and ${mediaFiles.recordingId} is not null`,
    // Narrows the groups in SQL; `groupEvidence` decides.
    sql`(${blank('album')} or (${blank('albumArtist')} and ${blank('artist')}))`,
  ))
  let reset = 0
  for (const { rootId, groupKey } of groups) {
    const files = await groupFiles(db, rootId, groupKey!, true)
    const evidence = groupEvidence(files)
    if (evidence.mode === 'album' && evidence.artist && evidence.album) continue
    const ids = files.filter((file) => file.matchStatus === 'unmatched' && !file.acoustid).map((file) => file.id)
    if (ids.length === 0) continue
    const updated = await db.update(mediaFiles).set({ matchStatus: 'pending', updatedAt: new Date() })
      .where(and(inArray(mediaFiles.id, ids), eq(mediaFiles.matchStatus, 'unmatched'), eq(mediaFiles.matchLocked, false)))
      .returning({ id: mediaFiles.id })
    reset += updated.length
  }
  if (reset > 0) await sweep()
  return reset
}
