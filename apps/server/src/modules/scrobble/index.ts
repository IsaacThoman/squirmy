import { enqueue, schedule } from '../../jobs/index.js'
import { getConfig } from '../../config.js'
import { onPlayStart } from '../sessions/index.js'
import type { ServerModule } from '../types.js'
import { type DeliverJob, deliverScrobbles, sweepScrobbles } from './delivery.js'
import { sweepHearts, syncHearts } from './hearts.js'
import { announceNowPlaying } from './nowplaying.js'
import { scrobbleRoutes } from './routes.js'

export { scrobblingStatus } from './status.js'

let unsubscribe: (() => void) | null = null

function report(error: unknown): void {
  if (getConfig().LOG_LEVEL !== 'silent') console.error('[scrobble]', error)
}

/**
 * Sends what users listen to on to ListenBrainz and Last.fm. Completed plays are found by
 * `scrobble.sweep` (every minute and at worker start) and sent by `scrobble.deliver`;
 * plays starting on the active device are announced as "now playing" from the API process.
 */
export const scrobbleModule: ServerModule = {
  name: 'scrobble',
  routes: scrobbleRoutes,
  async jobs(jobs) {
    jobs.define('scrobble.sweep', { timeoutSeconds: 5 * 60 }, sweepScrobbles)
    jobs.define<DeliverJob>('scrobble.deliver', { concurrency: 2, timeoutSeconds: 10 * 60 }, ({ userId, target }) => deliverScrobbles(userId, target))
    jobs.define('scrobble.hearts-sweep', {}, sweepHearts)
    jobs.define<{ userId: string }>('scrobble.hearts', { concurrency: 2, timeoutSeconds: 15 * 60 }, ({ userId }) => syncHearts(userId))
    await schedule('scrobble.sweep', '* * * * *')
    await schedule('scrobble.hearts-sweep', '*/15 * * * *')
  },
  async start({ role }) {
    if (role !== 'api') await enqueue('scrobble.sweep', {}, { singletonKey: 'sweep' })
    // Sessions live in the API process, so that is where plays start.
    if (role !== 'worker') unsubscribe = onPlayStart((userId, play) => void announceNowPlaying(userId, play).catch(report))
  },
  stop() {
    unsubscribe?.()
    unsubscribe = null
  },
}
