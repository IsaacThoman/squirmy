import { queryKeys, StartCatalogIndexImport, type CatalogIndexStatus, type Ok } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { enqueue } from '../../jobs/index.js'
import { requireAdmin } from '../../lib/auth.js'
import { conflict } from '../../lib/errors.js'
import { invalidate } from '../../realtime/index.js'
import { cancelImport, markInterruptedImports } from './import.js'
import { dropCatalogIndex, getCatalogIndexStatus } from './status.js'

/** Name and payload of the import job; the payload is the parsed request body. */
export const importJob = 'catalog-index.import'
export type ImportJob = StartCatalogIndexImport

export async function catalogIndexRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    requireAdmin(request)
  })

  app.get('/admin/catalog-index', async (): Promise<CatalogIndexStatus> => getCatalogIndexStatus())

  app.post('/admin/catalog-index/import', async (request, reply): Promise<Ok> => {
    const body: ImportJob = StartCatalogIndexImport.parse(request.body ?? {})
    // A row left running by a killed worker would otherwise refuse every import from now on.
    await markInterruptedImports()
    if ((await getCatalogIndexStatus()).latest?.state === 'running') throw conflict('A search index import is already running', 'catalog_index_import_running')
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
