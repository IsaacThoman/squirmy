import { queryKeys } from '@squirmy/contracts'
import { schedule } from '../../jobs/index.js'
import { invalidate } from '../../realtime/index.js'
import type { ServerModule } from '../types.js'
import { ImportCancelledError, ImportInterruptedError, importCanonicalDump, resumeImport } from './import.js'
import { catalogIndexRoutes, importJob, resumeInterruptedImports, type ImportJob } from './routes.js'

/**
 * How long shutting down waits for the import to record where it stopped. Stopping
 * cancels its statement and rolls back the uncommitted chunk, which takes well under a
 * second; the bound keeps a stuck database from holding up the rest of the shutdown,
 * which must finish inside the container's stop grace period.
 */
const checkpointGraceMs = 8_000

// The import running in this process, so shutting down can stop it and wait for its checkpoint.
let running: { controller: AbortController; done: Promise<void> } | undefined
let stopping = false

export const catalogIndexModule: ServerModule = {
  name: 'catalog-index',
  routes: catalogIndexRoutes,
  async jobs(jobs) {
    // A full import takes tens of minutes; a failed one is not retried automatically. One a
    // restart stops is resumed by its own job (`resume`), queued by `resumeInterruptedImports`.
    jobs.define<ImportJob>(importJob, { retryLimit: 0, timeoutSeconds: 6 * 60 * 60 }, async (data) => {
      // Picked up between the import's checkpoint and the end of the job system: leave it
      // to the next worker, which queues it again at start and from the sweep.
      if (stopping) return
      const controller = new AbortController()
      let finish!: () => void
      running = { controller, done: new Promise((resolve) => { finish = resolve }) }
      try {
        if (data.resume) await resumeImport(data.resume, { signal: controller.signal })
        else await importCanonicalDump({ source: data.source, recordingsPerArtist: data.recordingsPerArtist, signal: controller.signal })
      } catch (error) {
        // Queued now, while this process can still enqueue, so the replacement worker of a
        // rolling deploy carries on without waiting for the sweep.
        if (error instanceof ImportInterruptedError) await resumeInterruptedImports({ startAfter: 5 })
        else if (!(error instanceof ImportCancelledError)) throw error
      } finally {
        running = undefined
        finish()
        await invalidate('admins', [queryKeys.admin()])
      }
    })
    // Catches imports whose process was killed after the replacement worker had started,
    // which no start-up check sees.
    jobs.define('catalog-index.recover', { retryLimit: 0 }, () => resumeInterruptedImports())
    await schedule('catalog-index.recover', '* * * * *')
  },
  async start({ role }) {
    stopping = false
    // Picks up an import a restart or a crash stopped, without an admin having to notice.
    if (role !== 'api') await resumeInterruptedImports()
  },
  async stop() {
    stopping = true
    const current = running
    if (!current) return
    current.controller.abort()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([current.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, checkpointGraceMs) })])
    clearTimeout(timer)
  },
}
