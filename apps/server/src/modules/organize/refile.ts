import { and, eq } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { fileMoves, organizeBatches } from '../../database/schema.js'
import { AppError } from '../../lib/errors.js'
import { applyBatch } from './apply.js'
import { planOrganize } from './plan.js'

/**
 * Moves the provider deliveries of a managed root whose `_Fetched/` folders no longer
 * follow their credits (`refileCredits` in plan.ts) and removes the folders that leaves
 * empty. A plan with nothing to move is dropped rather than kept in the root's history.
 * When another batch holds the root, nothing happens and the next run tries again.
 * Returns how many files moved.
 */
export async function refileCredits(rootId: string): Promise<number> {
  const batchId = await planOrganize({ rootId, refileCredits: true, userId: null })
  const planned = await db.select({ id: fileMoves.id }).from(fileMoves)
    .where(and(eq(fileMoves.batchId, batchId), eq(fileMoves.kind, 'audio'), eq(fileMoves.status, 'planned')))
  if (planned.length === 0) {
    await db.delete(organizeBatches).where(eq(organizeBatches.id, batchId))
    return 0
  }
  try {
    await applyBatch(batchId)
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'organize_busy')) throw error
    await db.delete(organizeBatches).where(and(eq(organizeBatches.id, batchId), eq(organizeBatches.status, 'planned')))
    return 0
  }
  const applied = await db.select({ id: fileMoves.id }).from(fileMoves)
    .where(and(eq(fileMoves.batchId, batchId), eq(fileMoves.kind, 'audio'), eq(fileMoves.status, 'applied')))
  return applied.length
}
