import { queryKeys } from '@squirmy/contracts'
import { enqueue, schedule } from '../../jobs/index.js'
import { invalidate } from '../../realtime/index.js'
import type { ServerModule } from '../types.js'
import { ImportCancelledError, ImportInterruptedError, importCanonicalDump, resumeImport } from './import.js'
import { searchUpgradeNeeded, upgradeSearchIndexes } from './indexes.js'
import { catalogIndexRoutes, importJob, resumeInterruptedImports, type ImportJob } from './routes.js'

/**
 * How long shutting down waits for the import to record where it stopped. Stopping
 * cancels its statement and rolls back the uncommitted chunk, which takes well under a
 * second; the bound keeps a stuck database from holding up the rest of the shutdown,
 * which must finish inside the container's stop grace period.
 */
const checkpointGraceMs = 8_000

// The import running in this process, so shutting down can stop it and wait for its checkpoint.
type RunningJob = { controller: AbortController; done: Promise<void> }
let running: RunningJob | undefined
let upgrading: RunningJob | undefined
let stopping = false
const upgradeJob = 'catalog-index.upgrade'

async function queueUpgrade() {
  if (await searchUpgradeNeeded()) {
    // A killed worker can leave an active queue row until its timeout. PostgreSQL's
    // session lock prevents overlapping builds; a new key lets the next sweep retry.
    const minute = Math.floor(Date.now() / 60_000)
    await enqueue(upgradeJob, {}, { singletonKey: `search-index:${minute}`, priority: -10 })
  }
}

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
    jobs.define(upgradeJob, { retryLimit: 0, timeoutSeconds: 6 * 60 * 60 }, async () => {
      if (stopping) return
      const controller = new AbortController()
      let finish!: () => void
      upgrading = { controller, done: new Promise((resolve) => { finish = resolve }) }
      try {
        await upgradeSearchIndexes(controller.signal)
        await invalidate('admins', [queryKeys.admin()])
      } catch (error) {
        if (!controller.signal.aborted) throw error
      } finally {
        upgrading = undefined
        finish()
      }
    })
    // Picks up crashed imports and unfinished index builds even if another worker
    // was already running when the job stopped.
    jobs.define('catalog-index.recover', { retryLimit: 0 }, async () => {
      await resumeInterruptedImports()
      await queueUpgrade()
    })
    await schedule('catalog-index.recover', '* * * * *')
  },
  async start({ role }) {
    stopping = false
    // Picks up an import a restart or a crash stopped, without an admin having to notice.
    if (role !== 'api') {
      await resumeInterruptedImports()
      await queueUpgrade()
    }
  },
  async stop() {
    stopping = true
    const current = [running, upgrading]
    for (const job of current) job?.controller.abort()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all(current.map((job) => job?.done)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, checkpointGraceMs) }),
    ])
    clearTimeout(timer)
  },
}
