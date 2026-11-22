/**
 * Seam between imports and acquisition.
 *
 * An import of kind `acquisition` calls `settleDelivery` once it has decided which of its
 * files are duplicates, on every pass of its identifying step after that, before it waits
 * for matching and files what was identified. That is the moment the delivery can be
 * checked against the request with nothing still arriving: the files that are what was
 * asked for are linked to the requested recordings and placed on the requested album
 * (place.ts), so the import files them like any identified album and the matcher is never
 * asked to recognize an album from one of its tracks.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { acquisitionJobs } from '../../database/schema.js'
import { placeDelivery } from './place.js'
import { verifyDelivery } from './verify.js'

/**
 * Checks the import's files against the acquisition job they were delivered for and places
 * what fits. `copies` are the library files the import kept instead of delivered
 * duplicates of them. Never throws: a delivery that cannot be settled now is settled when
 * the job ends, or by the sweep.
 */
export async function settleDelivery(importId: string, copies: readonly string[] = []): Promise<void> {
  try {
    const [job] = await db.select().from(acquisitionJobs).where(and(eq(acquisitionJobs.importId, importId), isNull(acquisitionJobs.completedAt)))
    if (!job) return
    await verifyDelivery(job, { copies })
    await placeDelivery(job)
  } catch (error) {
    if (getConfig().LOG_LEVEL !== 'silent') console.error('[acquisition]', error)
  }
}
