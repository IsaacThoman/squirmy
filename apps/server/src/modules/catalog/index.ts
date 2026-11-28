import { schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { makeHomePicks, queueDailyHomePicks, type HomePicksJob } from './home-picks.js'
import { catalogRoutes } from './routes.js'

/** The read side, and Home's rails made ahead of time (home-picks.ts). */
export const catalogModule: ServerModule = {
  name: 'catalog',
  routes: catalogRoutes,
  async jobs(registry) {
    // Mostly waits on similar-artist lookups; two users at a time keep a morning's run short.
    registry.define<HomePicksJob>('catalog.home-picks', { concurrency: 2, retryLimit: 1, timeoutSeconds: 10 * 60 }, async ({ userId }) => {
      await makeHomePicks(userId)
    })
    registry.define('catalog.home-picks-all', { retryLimit: 1 }, async () => {
      await queueDailyHomePicks()
    })
    await schedule('catalog.home-picks-all', '0 5 * * *')
  },
}
