import { eq } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { libraryRoots } from '../../database/schema.js'
import { schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { analyzeFile, type AnalyzeJob } from './analyze.js'
import { ingestGroup, type IngestJob } from './ingest.js'
import { probeFile, type ProbeJob } from './probe.js'
import { stopProgress } from './progress.js'
import { addConfiguredRoots, requestScan } from './roots.js'
import { libraryRoutes } from './routes.js'
import { purgeMissing, scanRoot, type ScanJob } from './scan.js'
import { startWatching, stopWatching } from './watch.js'

/**
 * Jobs, in pipeline order:
 *   library.scan     { rootId, paths? }   one at a time per root
 *   library.probe    { fileId }           tags and technical details
 *   library.ingest   { rootId, groupKey } catalog rows for an album group
 *   library.analyze  { fileId }           audio hash and move detection, low priority
 * and then matching.match-album and loudness.measure, owned by other modules.
 */
export const libraryModule: ServerModule = {
  name: 'library',
  routes: libraryRoutes,
  async jobs(jobs) {
    jobs.define<ScanJob>('library.scan', { concurrency: 2, timeoutSeconds: 6 * 60 * 60 }, async (data) => {
      await scanRoot(data)
    })
    jobs.define<ProbeJob>('library.probe', { concurrency: 4 }, probeFile)
    // Stately: a file probed while its group is being ingested queues one more pass.
    jobs.define<IngestJob>('library.ingest', { concurrency: 2, policy: 'stately' }, ingestGroup)
    jobs.define<AnalyzeJob>('library.analyze', { concurrency: 2 }, analyzeFile)
    jobs.define('library.scan-all', {}, async () => {
      const roots = await db.select({ id: libraryRoots.id }).from(libraryRoots).where(eq(libraryRoots.enabled, true))
      for (const root of roots) await requestScan(root.id)
    })
    jobs.define('library.purge-missing', {}, async () => {
      await purgeMissing()
    })
    await schedule('library.scan-all', '0 4 * * *')
    await schedule('library.purge-missing', '30 5 * * *')
  },
  async start({ role }) {
    await addConfiguredRoots()
    if (role !== 'api') await startWatching()
  },
  async stop() {
    await stopWatching()
    await stopProgress()
  },
}
