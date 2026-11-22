import { API_PREFIX, AcquisitionPolicy, type UpdateAcquisitionPolicy } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { libraryRoots, serverSettings } from '../../database/schema.js'
import { badRequest } from '../../lib/errors.js'

/** The policy is one row of `server_settings`, beside the operator settings. */
const policyKey = 'acquisition_policy'
const cacheMs = 5_000

let cache: { value: AcquisitionPolicy; at: number } | undefined

/** Current acquisition policy with defaults applied. Cached for a few seconds. */
export async function getAcquisitionPolicy(): Promise<AcquisitionPolicy> {
  if (cache && Date.now() - cache.at < cacheMs) return cache.value
  const [row] = await db.select().from(serverSettings).where(eq(serverSettings.key, policyKey))
  const value = AcquisitionPolicy.parse(row?.value ?? {})
  cache = { value, at: Date.now() }
  return value
}

/** Applies a partial update; a chosen target root must be a managed root. */
export async function updateAcquisitionPolicy(patch: UpdateAcquisitionPolicy): Promise<AcquisitionPolicy> {
  if (patch.targetRootId) {
    const [root] = await db.select({ mode: libraryRoots.mode }).from(libraryRoots).where(eq(libraryRoots.id, patch.targetRootId))
    if (root?.mode !== 'managed') throw badRequest('Acquired music can only go to a managed library root', 'target_root_not_managed')
  }
  const next = AcquisitionPolicy.parse({ ...(await getAcquisitionPolicy()), ...patch })
  await db.insert(serverSettings).values({ key: policyKey, value: next })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value: next, updatedAt: new Date() } })
  cache = undefined
  return getAcquisitionPolicy()
}

/** Drops the cached policy. Tests that write the table directly call it. */
export function invalidateAcquisitionPolicy() {
  cache = undefined
}

/**
 * The origin delivery URLs start with: the policy's `deliveryBaseUrl`, else `PUBLIC_URL`,
 * else this server on localhost. A provider in another container needs one of the first two.
 */
export async function deliveryOrigin(): Promise<string> {
  const { deliveryBaseUrl } = await getAcquisitionPolicy()
  const config = getConfig()
  return (deliveryBaseUrl ?? config.PUBLIC_URL ?? `http://localhost:${config.PORT}`).replace(/\/+$/, '')
}

/** The two URLs a provider delivers a job's files to. */
export async function deliveryUrls(jobId: string): Promise<{ uploadUrl: string; completeUrl: string }> {
  const base = `${await deliveryOrigin()}${API_PREFIX}/acquisition/deliveries/${jobId}`
  return { uploadUrl: `${base}/files`, completeUrl: `${base}/complete` }
}
