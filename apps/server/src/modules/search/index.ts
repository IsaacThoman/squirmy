import { schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { cleanupStubs } from './cleanup.js'
import { searchRoutes } from './routes.js'

/**
 * Library search, catalog search through the providers in providers.ts, and the stub
 * rows catalog results are stored as. Job: `search.cleanup` (daily) deletes stubs
 * nobody kept.
 */
export const searchModule: ServerModule = {
  name: 'search',
  routes: searchRoutes,
  async jobs(jobs) {
    jobs.define('search.cleanup', {}, async () => {
      await cleanupStubs()
    })
    await schedule('search.cleanup', '45 5 * * *')
  },
}
