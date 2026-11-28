import { enqueue, schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { evictCache } from './evict.js'
import { finishDelivery, startJob, sweepJobs, type StartJob } from './jobs.js'
import { startOutcomes, stopOutcomes } from './outcomes.js'
import { repairDeliveries } from './repair.js'
import { checkProviders } from './providers.js'
import { resetResolveQueue, runResolveJob, type ResolveJob } from './resolve.js'
import { acquisitionRoutes } from './routes.js'

/**
 * Acquisition providers: on-demand fetching of music the server does not have, through
 * operator-run services that speak docs/provider-protocol.md. Off until an admin adds a
 * provider. Jobs:
 *   acquisition.resolve  { providerId, recordingIds }  checks what a provider has before playback
 *   acquisition.start    { jobId }                     picks an offer and hands it to the provider
 *   acquisition.finish   { jobId }                     waits for the delivery's import and checks it
 *   acquisition.sweep    {}                            timeouts, quiet providers, restart recovery
 *   acquisition.check    {}                            asks enabled providers for their capabilities, noticing new versions
 *   acquisition.repair   {}                            deliveries that are not on the album they were requested from
 *   acquisition.evict    {}                            deletes least recently played unpinned cached files over the cache limit
 */
export const acquisitionModule: ServerModule = {
  name: 'acquisition',
  routes: acquisitionRoutes,
  async jobs(jobs) {
    jobs.define<ResolveJob>('acquisition.resolve', { concurrency: 2, retryLimit: 1, timeoutSeconds: 120 }, runResolveJob)
    jobs.define<StartJob>('acquisition.start', { concurrency: 4, timeoutSeconds: 300 }, async ({ jobId, attempt, upcoming }) => startJob(jobId, attempt, upcoming))
    // Waits on the import, which waits on identification: allow as long as that may take.
    jobs.define<StartJob>('acquisition.finish', { concurrency: 4, timeoutSeconds: 3 * 60 * 60 }, async ({ jobId }) => finishDelivery(jobId))
    jobs.define('acquisition.sweep', { retryLimit: 1 }, async () => sweepJobs())
    jobs.define('acquisition.check', { retryLimit: 0, timeoutSeconds: 5 * 60 }, async () => checkProviders())
    jobs.define('acquisition.repair', { retryLimit: 1, timeoutSeconds: 30 * 60 }, async () => {
      await repairDeliveries()
    })
    jobs.define('acquisition.evict', { retryLimit: 1, timeoutSeconds: 30 * 60 }, async () => {
      await evictCache()
    })
    await schedule('acquisition.sweep', '* * * * *')
    await schedule('acquisition.check', '*/5 * * * *')
    await schedule('acquisition.evict', '17 * * * *')
    await schedule('acquisition.repair', '25 4 * * *')
  },
  async start({ role }) {
    if (role !== 'worker') await startOutcomes()
    if (role === 'api') return
    await enqueue('acquisition.sweep', {}, { singletonKey: 'sweep' })
    await enqueue('acquisition.check', {}, { singletonKey: 'check' })
    await enqueue('acquisition.repair', {}, { singletonKey: 'repair' })
  },
  async stop() {
    resetResolveQueue()
    await stopOutcomes()
  },
}
