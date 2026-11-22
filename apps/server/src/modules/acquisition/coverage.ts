/**
 * Seam between availability, sessions and the acquisition module.
 *
 * With no acquisition provider configured (the default) nothing is on demand and
 * requests are answered as failed.
 */
import type { AcquisitionOrigin, EntryFailure } from '@squirmy/contracts'
import { AppError } from '../../lib/errors.js'
import { requestTrack } from './jobs.js'
import { announceOutcome, stillWorking } from './outcomes.js'
import { activeProviders } from './providers.js'
import { announceAvailability, coveredRecordings } from './resolve.js'

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
 * Whether an album with no track list yet counts as on demand: true while an enabled
 * provider is `assume_available` (declared or set by the admin). Such a provider fetches
 * whatever is asked, so an album found by search is playable before its track list
 * arrives; with `must_resolve` providers only there is nothing to resolve yet, so it is not.
 */
export async function albumCoveredWithoutTracks(): Promise<boolean> {
  return (await activeProviders()).some((provider) => provider.coverage === 'assume_available')
}

/**
 * Ask providers for a recording because a user is about to play it. Resolves at once;
 * the result arrives later as a `setEntryState` session command and an invalidation.
 * A request that cannot go ahead (the user may not fetch, nothing covers it, the user has
 * too many fetches running) is answered as failed straight away, with its cause, unless
 * another job is already fetching it. The cache limit never refuses one: it evicts instead (evict.ts).
 */
export async function requestRecording(request: {
  userId: string
  recordingId: string
  albumId?: string | null
  /**
   * Why it is asked for: `play` (the default) for the entry the user is waiting on,
   * `prefetch` for one further down the queue. Waiting jobs start in this order, so a
   * prefetch never holds up what is playing.
   */
  origin?: Extract<AcquisitionOrigin, 'play' | 'prefetch'>
}): Promise<void> {
  try {
    await requestTrack(request.userId, request.recordingId, request.albumId ?? null, request.origin ?? 'play')
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    if (error.code === 'already_available') {
      await announceOutcome({ ready: [request.recordingId] })
      return
    }
    if ((await stillWorking([request.recordingId])).size > 0) return
    await announceOutcome({ failed: [request.recordingId], cause: await refusalCause(error.code) })
    // Nothing covers it (a miss, a provider turned off): lists that still show it as on
    // demand gray it out where it is, for everyone. A refusal of this user changes nothing.
    if (error.code === 'not_available') await announceAvailability([request.recordingId])
  }
}

/**
 * Why a request that could not go ahead failed, for the sessions: the track is not to be had
 * (no provider can supply it, it is gone, or this user may not fetch), or fetching itself is
 * down (no provider is enabled any more). Anything else, such as the job limit or a missing
 * import root, is an `error` the server does not explain to the listener.
 */
async function refusalCause(code: string): Promise<EntryFailure> {
  if (code === 'not_available') return (await activeProviders()).length === 0 ? 'outage' : 'unavailable'
  if (code === 'track_not_found' || code === 'acquire_not_allowed') return 'unavailable'
  return 'error'
}
