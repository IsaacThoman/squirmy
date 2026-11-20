/**
 * Seam between availability, sessions and the acquisition module.
 *
 * With no acquisition provider configured (the default) nothing is on demand and
 * requests are ignored.
 */

/** Of the given unowned recordings, the ones an enabled provider can supply. */
export async function onDemandRecordings(_recordingIds: readonly string[]): Promise<Set<string>> {
  return new Set()
}

/**
 * Ask providers for a recording because a user is about to play it. Resolves at once;
 * the result arrives later as a `setEntryState` session command and an invalidation.
 */
export async function requestRecording(_request: { userId: string; recordingId: string; albumId?: string | null }): Promise<void> {}
