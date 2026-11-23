import { queryKeys, StartCatalogIndexImport, type CatalogIndexStatus, type Ok } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { enqueue } from '../../jobs/index.js'
import { requireAdmin } from '../../lib/auth.js'
import { conflict } from '../../lib/errors.js'
import { invalidate } from '../../realtime/index.js'
import { cancelImport, interruptedImports, markInterruptedImports } from './import.js'
import { dropCatalogIndex, getCatalogIndexStatus } from './status.js'

/**
 * Name and payload of the import job: the parsed request body for a new import, or the
 * id of an import to carry on with after a restart.
 */
export const importJob = 'catalog-index.import'
export type ImportJob = Partial<StartCatalogIndexImport> & { resume?: string }

/**
 * Queues a resume for every interrupted import: those a shutdown stopped, and those whose
 * process died (marked here). The key carries the resume count, so repeated calls queue
 * one job per attempt, and the job that is running right now does not hold the key of
 * the next one. `startAfter` keeps a process that is shutting down from taking the job
 * itself: the next worker to look does.
 */
export async function resumeInterruptedImports(options: { startAfter?: number } = {}) {
  await markInterruptedImports()
  for (const row of await interruptedImports()) {
    await enqueue<ImportJob>(importJob, { resume: row.id }, {
      singletonKey: `catalog-index:resume:${row.id}:${row.resumes}`, priority: -10, ...options,
    })
  }
}

export async function catalogIndexRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    requireAdmin(request)
  })

  app.get('/admin/catalog-index', async (): Promise<CatalogIndexStatus> => getCatalogIndexStatus())

  app.post('/admin/catalog-index/import', async (request, reply): Promise<Ok> => {
    const body: ImportJob = StartCatalogIndexImport.parse(request.body ?? {})
    // A row left running by a killed worker is resumed rather than refusing every import from now on.
    await resumeInterruptedImports()
    const latest = (await getCatalogIndexStatus()).latest?.state
    if (latest === 'running' || latest === 'interrupted') throw conflict('A search index import is already running', 'catalog_index_import_running')
    const id = await enqueue(importJob, body, { singletonKey: 'catalog-index', priority: -10 })
    if (!id) throw conflict('A search index import is already queued', 'catalog_index_import_running')
    await invalidate('admins', [queryKeys.admin()])
    reply.code(202)
    return { ok: true }
  })

  // Stops the running import only; the index in use stays, as after a failed import.
  app.delete('/admin/catalog-index/import', async (): Promise<Ok> => {
    if (!(await cancelImport())) throw conflict('No search index import is running', 'catalog_index_import_not_running')
    await invalidate('admins', [queryKeys.admin()])
    return { ok: true }
  })

  app.delete('/admin/catalog-index', async (): Promise<Ok> => {
    await cancelImport()
    await dropCatalogIndex()
    await invalidate('admins', [queryKeys.admin()])
    return { ok: true }
  })
}
