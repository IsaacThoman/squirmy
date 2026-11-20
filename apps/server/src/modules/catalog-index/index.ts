import { queryKeys } from '@squirmy/contracts'
import { invalidate } from '../../realtime/index.js'
import type { ServerModule } from '../types.js'
import { ImportCancelledError, importCanonicalDump } from './import.js'
import { catalogIndexRoutes, importJob, type ImportJob } from './routes.js'

// The import running in this process, so shutting down can stop it cleanly.
let running: AbortController | undefined

export const catalogIndexModule: ServerModule = {
  name: 'catalog-index',
  routes: catalogIndexRoutes,
  jobs(jobs) {
    // A full import takes tens of minutes; a failed one is not retried automatically.
    jobs.define<ImportJob>(importJob, { retryLimit: 0, timeoutSeconds: 6 * 60 * 60 }, async (data) => {
      running = new AbortController()
      try {
        await importCanonicalDump({ source: data.source, recordingsPerArtist: data.recordingsPerArtist, signal: running.signal })
      } catch (error) {
        if (!(error instanceof ImportCancelledError)) throw error
      } finally {
        running = undefined
        await invalidate('admins', [queryKeys.admin()])
      }
    })
  },
  stop() {
    running?.abort()
  },
}
