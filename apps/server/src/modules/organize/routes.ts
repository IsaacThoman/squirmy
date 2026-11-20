import {
  Id, OrganizeBatchListQuery, OrganizePreviewRequest, queryKeys,
  type OrganizeBatch, type OrganizeBatchAccepted, type OrganizeBatchList,
} from '@squirmy/contracts'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { organizeBatches } from '../../database/schema.js'
import { requireAdmin } from '../../lib/auth.js'
import { conflict } from '../../lib/errors.js'
import { enqueue } from '../../jobs/index.js'
import { invalidate } from '../../realtime/index.js'
import { getBatch, getBatchSummary, listBatches } from './batches.js'
import { assertManaged, loadBatch } from './journal.js'
import { planOrganize } from './plan.js'

const IdParams = z.object({ id: Id })

/** Tells open admin screens that organize batches changed. */
export const invalidateBatches = () => invalidate('admins', [queryKeys.adminOrganize()])

/**
 * Moves a batch from one of `from` to `to` and enqueues `job` in the same transaction,
 * so a batch is never marked as running without a job to run it. A batch already in
 * `to` is enqueued again, which resumes it after a job that gave up.
 */
async function start(batchId: string, from: string[], to: string, job: string, refusal: string, code: string) {
  const { batch, root } = await loadBatch(batchId)
  if (![...from, to].includes(batch.status)) throw conflict(refusal, code)
  assertManaged(root)
  await db.transaction(async (tx) => {
    const updated = await tx.update(organizeBatches).set({ status: to })
      .where(and(eq(organizeBatches.id, batchId), inArray(organizeBatches.status, [...from, to])))
      .returning({ id: organizeBatches.id })
    if (updated.length === 0) throw conflict(refusal, code)
    await enqueue(job, { batchId }, { singletonKey: batchId, tx })
  })
  await invalidateBatches()
}

export async function organizeRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    requireAdmin(request)
  })

  app.post('/admin/organize/preview', async (request, reply): Promise<OrganizeBatch> => {
    const body = OrganizePreviewRequest.parse(request.body)
    const batchId = await planOrganize({ ...body, userId: requireAdmin(request).id })
    await invalidateBatches()
    reply.code(201)
    return getBatch(batchId)
  })

  app.get('/admin/organize/batches', async (request): Promise<OrganizeBatchList> => listBatches(OrganizeBatchListQuery.parse(request.query)))

  app.get('/admin/organize/batches/:id', async (request): Promise<OrganizeBatch> => getBatch(IdParams.parse(request.params).id))

  app.post('/admin/organize/batches/:id/apply', async (request, reply): Promise<OrganizeBatchAccepted> => {
    const { id } = IdParams.parse(request.params)
    await start(id, ['planned'], 'applying', 'organize.apply', 'Only a planned batch can be applied', 'batch_not_planned')
    reply.code(202)
    return getBatchSummary(id)
  })

  app.post('/admin/organize/batches/:id/revert', async (request, reply): Promise<OrganizeBatchAccepted> => {
    const { id } = IdParams.parse(request.params)
    await start(id, ['applied'], 'reverting', 'organize.revert', 'Only an applied batch can be undone', 'batch_not_applied')
    reply.code(202)
    return getBatchSummary(id)
  })
}
