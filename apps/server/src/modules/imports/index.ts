import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Id } from '@squirmy/contracts'
import { and, eq, inArray, lt } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { imports } from '../../database/schema.js'
import { enqueue, schedule } from '../../jobs/index.js'
import { AppError } from '../../lib/errors.js'
import type { ServerModule } from '../types.js'
import { startInbox, stopInbox } from './inbox.js'
import { failureMessage, ImportFailure, markFailed, processImport, type ImportProcessJob } from './process.js'
import { importsRoutes } from './routes.js'
import { failImport } from './service.js'
import { stagingRoot } from './staging.js'

export {
  addImportFile, commitImport, createImport, failImport, getImport, importCopies,
  type CreateImportInput, type ImportFileInput,
} from './service.js'
export { refileImport } from './process.js'

const retryLimit = 3
/** Imports that receive nothing for this long are expired. */
const receivingMaxAgeMs = 24 * 60 * 60_000
/** Staging folders without a live import are removed once they are this old. */
const orphanMinAgeMs = 60 * 60_000

/**
 * Expires imports stuck in `receiving`, re-queues `processing` ones whose job was lost,
 * and removes staging folders no live import owns.
 */
export async function sweepImports(now = Date.now()) {
  const stale = await db.select({ id: imports.id }).from(imports)
    .where(and(eq(imports.status, 'receiving'), lt(imports.updatedAt, new Date(now - receivingMaxAgeMs))))
  for (const { id } of stale) {
    await failImport(id, 'Expired: no files arrived for a day').catch((error: unknown) => {
      if (!(error instanceof AppError)) throw error
    })
  }
  for (const { id } of await db.select({ id: imports.id }).from(imports).where(eq(imports.status, 'processing'))) {
    await enqueue('imports.process', { importId: id }, { singletonKey: id })
  }
  const names = (await readdir(stagingRoot()).catch(() => [])).filter((name) => Id.safeParse(name).success)
  const live = new Set((names.length === 0 ? [] : await db.select({ id: imports.id }).from(imports)
    .where(and(inArray(imports.id, names), inArray(imports.status, ['receiving', 'processing'])))).map((row) => row.id))
  for (const name of names) {
    if (live.has(name)) continue
    const folder = path.join(stagingRoot(), name)
    const info = await stat(folder).catch(() => null)
    if (info && now - info.mtimeMs > orphanMinAgeMs) await rm(folder, { recursive: true, force: true })
  }
}

/**
 * Imports: web uploads, the inbox folder and (through the service functions exported
 * here) acquisition deliveries. Jobs:
 *   imports.process  { importId }  takes a committed import into the library
 *   imports.sweep    {}            expiry, lost jobs and orphaned staging folders
 */
export const importsModule: ServerModule = {
  name: 'imports',
  routes: importsRoutes,
  async jobs(jobs) {
    // Identification waits on the library pipeline and filing may copy across file
    // systems, so a run can take hours; a second run of one import waits on its lock.
    // Runs mostly wait, and an on-demand track plays only once its import runs: playing an
    // album fetches the current track and the next two at once, so they must not queue.
    jobs.define<ImportProcessJob>('imports.process', { concurrency: 4, retryLimit, timeoutSeconds: 6 * 60 * 60 }, async ({ importId }, { attempt }) => {
      try {
        await processImport(importId)
      } catch (error) {
        if (!(error instanceof ImportFailure) && attempt <= retryLimit) throw error
        await markFailed(importId, failureMessage(error))
      }
    })
    jobs.define('imports.sweep', { retryLimit: 1 }, async () => {
      await sweepImports()
    })
    await schedule('imports.sweep', '*/15 * * * *')
  },
  async start({ role }) {
    if (role === 'api') return
    await enqueue('imports.sweep', {}, { singletonKey: 'sweep' })
    startInbox()
  },
  async stop() {
    await stopInbox()
  },
}
