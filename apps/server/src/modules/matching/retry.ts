/**
 * Identification a settings change makes possible. `PATCH /admin/settings` calls
 * `queueNewlyPossibleMatching` with the settings before and after:
 * - MusicBrainz switched on: groups left `pending` while it was off are swept at once,
 *   instead of at the next ten-minute sweep.
 * - An AcoustID key added: unlocked files that went `unmatched` without a fingerprint
 *   match are set back to `pending`, since the new key enables another matching tier.
 * Either way the work goes through `sweep` and `matching.match-album`, so batch sizes and
 * rate limits are those of every other match.
 */
import type { ServerSettings } from '@squirmy/contracts'
import { and, eq, gte, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { sweep } from './match.js'

/** Queues the matching that switching MusicBrainz on or adding an AcoustID key allows. */
export async function queueNewlyPossibleMatching(before: ServerSettings, after: ServerSettings): Promise<void> {
  // Keyless, so a sweep that started before the change cannot swallow this one.
  if (!before.musicBrainzEnabled && after.musicBrainzEnabled) await enqueue('matching.sweep', {})
  if (!before.acoustIdKeySet && after.acoustIdKeySet) await enqueue('matching.retry-fingerprints', {}, { singletonKey: 'retry-fingerprints' })
}

/**
 * Sets unlocked `unmatched` files back to `pending`, then sweeps. Files with a known
 * AcoustID were fingerprinted and looked up already. Returns how many files it reset.
 */
export async function retryWithFingerprints(): Promise<number> {
  const updated = await db.update(mediaFiles).set({ matchStatus: 'pending', updatedAt: new Date() }).where(and(
    eq(mediaFiles.matchStatus, 'unmatched'),
    eq(mediaFiles.matchLocked, false),
    isNull(mediaFiles.missingSince),
    gte(mediaFiles.probeStage, 1),
    isNull(mediaFiles.acoustid),
    isNotNull(mediaFiles.groupKey),
    isNotNull(mediaFiles.recordingId),
  ))
  if (updated.count > 0) await sweep()
  return updated.count
}
