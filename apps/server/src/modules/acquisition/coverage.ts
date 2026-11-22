/**
 * Seam between availability, sessions and the acquisition module.
 *
 * With no acquisition provider configured (the default) nothing is on demand and
 * requests are answered as failed.
 */
import type { AcquisitionOrigin } from '@squirmy/contracts'
import { AppError } from '../../lib/errors.js'
import { requestTrack } from './jobs.js'
import { announceOutcome, stillWorking } from './outcomes.js'
import { activeProviders } from './providers.js'
import { coveredRecordings } from './resolve.js'

/**
 * Of the given unowned recordings (ids already redirect-resolved), the ones an enabled
 * provider can supply. Called by every list, so it reads only the coverage caches; with no
 * enabled provider it returns at once without touching the database.
 */
export async function onDemandRecordings(recordingIds: readonly string[]): Promise<Set<string>> {
  if (recordingIds.length === 0) return new Set()
  const providers = await activeProviders()
  if (providers.length === 0) return new Set()
  return coveredRecordings(providers, [...new Set(recordingIds)])
}

/**
 * Ask providers for a recording because a user is about to play it. Resolves at once;
 * the result arrives later as a `setEntryState` session command and an invalidation.
 * A request that cannot go ahead (the user may not fetch, nothing covers it, the quota is
 * full) is answered as failed straight away, unless another job is already fetching it.
 */
export async function requestRecording(request: {
  userId: string
  recordingId: string
  albumId?: string | null
  /**
   * Why it is asked for: `play` for the entry the user is waiting on, `prefetch` for one
   * further down the queue. Not read yet: it is there for starting waiting jobs in this
   * order, so a prefetch never holds up what is playing.
   */
  origin?: Extract<AcquisitionOrigin, 'play' | 'prefetch'>
}): Promise<void> {
  try {
    await requestTrack(request.userId, request.recordingId, request.albumId ?? null)
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    if (error.code === 'already_available') {
      await announceOutcome({ ready: [request.recordingId] })
      return
    }
    if ((await stillWorking([request.recordingId])).size > 0) return
    await announceOutcome({ failed: [request.recordingId] })
  }
}
