import { and, eq, isNull, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { invalidate, publish } from '../../realtime/index.js'

type QueryKey = readonly unknown[]

export function warn(message: string, error?: unknown) {
  if (getConfig().LOG_LEVEL === 'silent') return
  if (error === undefined) console.warn(`[library] ${message}`)
  else console.warn(`[library] ${message}`, error)
}

const pendingKeys = new Map<string, QueryKey>()
let flushTimer: NodeJS.Timeout | undefined

/**
 * Invalidates query keys for every client, coalesced over half a second: a scan ingests
 * hundreds of albums a minute, and each would otherwise make every open screen refetch.
 */
export function invalidateSoon(keys: readonly QueryKey[]) {
  for (const key of keys) pendingKeys.set(JSON.stringify(key), key)
  flushTimer ??= setTimeout(() => void flushInvalidations(), 500).unref()
}

export async function flushInvalidations() {
  clearTimeout(flushTimer)
  flushTimer = undefined
  const keys = [...pendingKeys.values()]
  pendingKeys.clear()
  if (keys.length > 0) await invalidate('all', keys).catch((error: unknown) => warn('Could not send invalidations', error))
}

const progressTimers = new Map<string, NodeJS.Timeout>()

/** Publishes probe progress for a root at most once a second. */
export function reportProbeProgress(rootId: string) {
  if (progressTimers.has(rootId)) return
  progressTimers.set(rootId, setTimeout(() => {
    progressTimers.delete(rootId)
    void publishProbeProgress(rootId).catch((error: unknown) => warn('Could not publish scan progress', error))
  }, 1000).unref())
}

/** `probing` while files of the root wait for their tags to be read, then `idle`. */
export async function publishProbeProgress(rootId: string) {
  const [counts] = await db.select({
    total: sql<number>`count(*)::int`,
    waiting: sql<number>`(count(*) filter (where ${mediaFiles.probeStage} = 0 and ${mediaFiles.probeError} is null))::int`,
  }).from(mediaFiles).where(and(eq(mediaFiles.rootId, rootId), isNull(mediaFiles.missingSince)))
  const { total = 0, waiting = 0 } = counts ?? {}
  await publish('admins', { type: 'scan.progress', rootId, phase: waiting > 0 ? 'probing' : 'idle', processed: total - waiting, total })
}

export async function stopProgress() {
  for (const timer of progressTimers.values()) clearTimeout(timer)
  progressTimers.clear()
  await flushInvalidations()
}
