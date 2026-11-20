import { enqueue, schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { matchGroup, matchJobKey, sweep } from './match.js'

export { mergeAlbum, mergeArtist, mergeRecording, resolveMerged } from './merge.js'
export { matchJobKey }

/** Payload of `matching.match-album`, enqueued by the library module once a group is ingested. */
export type MatchAlbumJob = { rootId: string; groupKey: string }

/**
 * Identifies albums against MusicBrainz and upgrades local-only rows to MusicBrainz rows.
 * `matching.match-album` matches one album group; `matching.sweep` re-queues groups still
 * pending, so nothing waits forever if a job was lost.
 */
export const matchingModule: ServerModule = {
  name: 'matching',
  async jobs(registry) {
    // Mostly waiting on MusicBrainz's one request a second; a mirror has no such limit.
    registry.define<MatchAlbumJob>('matching.match-album', { concurrency: 2, timeoutSeconds: 30 * 60 }, async ({ rootId, groupKey }) => {
      await matchGroup(rootId, groupKey)
    })
    registry.define('matching.sweep', { retryLimit: 1 }, async () => {
      await sweep()
    })
    await schedule('matching.sweep', '*/10 * * * *')
  },
  async start({ role }) {
    if (role !== 'api') await enqueue('matching.sweep', {}, { singletonKey: 'sweep' })
  },
}
