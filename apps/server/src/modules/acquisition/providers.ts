import {
  Id, ProviderCapabilities,
  type AcquisitionProvider, type CreateAcquisitionProviderRequest, type ProviderCoverage, type UpdateAcquisitionProviderRequest,
} from '@squirmy/contracts'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { acquisitionProviders } from '../../database/schema.js'
import { decrypt, encrypt } from '../../lib/crypto.js'
import { notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { dropCachedReads } from '../../lib/read-cache.js'
import { fetchCapabilities, ProviderCallError, type ProviderEndpoint } from './client.js'

type ProviderRow = typeof acquisitionProviders.$inferSelect

/** An enabled provider that has answered `capabilities` at least once. */
export type ActiveProvider = ProviderEndpoint & {
  id: string
  name: string
  coverage: ProviderCoverage
  priority: number
  capabilities: ProviderCapabilities
}

const secretPurpose = 'acquisition-provider-secret'
/** Other processes see provider changes within this long. */
const cacheMs = 30_000

let cache: { value: ActiveProvider[]; at: number } | undefined

/** The coverage that counts: the admin's override, else what the provider declared. */
function coverageOf(row: Pick<ProviderRow, 'coverage' | 'coverageOverride'>): ProviderCoverage {
  return (row.coverageOverride ?? row.coverage) as ProviderCoverage
}

export function toProvider(row: ProviderRow): AcquisitionProvider {
  const capabilities = ProviderCapabilities.safeParse(row.capabilities)
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    coverage: coverageOf(row),
    priority: row.priority,
    capabilities: row.capabilities && capabilities.success ? capabilities.data : null,
    lastOkAt: row.lastOkAt?.toISOString() ?? null,
    lastError: row.lastError,
  }
}

/**
 * Enabled providers that have described themselves, highest priority first. Cached in
 * memory, so availability checks cost nothing when no provider is set up.
 */
export async function activeProviders(): Promise<ActiveProvider[]> {
  if (cache && Date.now() - cache.at < cacheMs) return cache.value
  const rows = await db.select().from(acquisitionProviders)
    .where(and(eq(acquisitionProviders.enabled, true), isNotNull(acquisitionProviders.capabilities)))
    .orderBy(desc(acquisitionProviders.priority), acquisitionProviders.id)
  const value = rows.flatMap((row): ActiveProvider[] => {
    const capabilities = ProviderCapabilities.safeParse(row.capabilities)
    if (!capabilities.success) return []
    return [{
      id: row.id, name: row.name, baseUrl: row.baseUrl, secret: decrypt(secretPurpose, row.secretEncrypted),
      coverage: (row.coverageOverride as ProviderCoverage | null) ?? capabilities.data.coverage, priority: row.priority, capabilities: capabilities.data,
    }]
  })
  cache = { value, at: Date.now() }
  return value
}

/** Forgets the cached provider list. Called after every change; tests call it too. */
export function invalidateProviders() {
  cache = undefined
  // Which tracks are on demand follows the providers, and every cached page shows it.
  dropCachedReads('all', [['acquisition-providers']])
}

async function loadRow(providerId: string): Promise<ProviderRow> {
  const [row] = Id.safeParse(providerId).success ? await db.select().from(acquisitionProviders).where(eq(acquisitionProviders.id, providerId)) : []
  if (!row) throw notFound('No such provider', 'provider_not_found')
  return row
}

/** Every provider, highest priority first. */
export async function listProviders(): Promise<AcquisitionProvider[]> {
  const rows = await db.select().from(acquisitionProviders).orderBy(desc(acquisitionProviders.priority), acquisitionProviders.id)
  return rows.map(toProvider)
}

/** The provider and its decrypted secret, for calls to it. */
export async function providerEndpoint(providerId: string): Promise<ProviderRow & ProviderEndpoint> {
  const row = await loadRow(providerId)
  return { ...row, secret: decrypt(secretPurpose, row.secretEncrypted) }
}

/** Saves a provider and tests it right away; an unreachable one is kept with `lastError`. */
export async function createProvider(input: CreateAcquisitionProviderRequest): Promise<AcquisitionProvider> {
  const id = newId()
  await db.insert(acquisitionProviders).values({
    id, name: input.name, baseUrl: input.baseUrl, secretEncrypted: encrypt(secretPurpose, input.secret),
    enabled: input.enabled, priority: input.priority,
  })
  invalidateProviders()
  return testProvider(id)
}

/** Applies a partial update. A new address or secret is tested again. */
export async function updateProvider(providerId: string, patch: UpdateAcquisitionProviderRequest): Promise<AcquisitionProvider> {
  await loadRow(providerId)
  const [row] = await db.update(acquisitionProviders).set({
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
    ...(patch.secret === undefined ? {} : { secretEncrypted: encrypt(secretPurpose, patch.secret) }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.coverage === undefined ? {} : { coverageOverride: patch.coverage }),
    updatedAt: new Date(),
  }).where(eq(acquisitionProviders.id, providerId)).returning()
  invalidateProviders()
  if (patch.baseUrl !== undefined || patch.secret !== undefined) return testProvider(providerId)
  return toProvider(row!)
}

/** Deletes a provider with its jobs, offers and misses. */
export async function deleteProvider(providerId: string): Promise<void> {
  await loadRow(providerId)
  await db.delete(acquisitionProviders).where(eq(acquisitionProviders.id, providerId))
  invalidateProviders()
}

/**
 * `GET {baseUrl}/capabilities`: stores the capabilities and declared coverage with
 * `last_ok_at`, or the failure as `last_error`. An admin's coverage override is kept: it
 * is the operator's word on what this provider can fetch, whatever it says of itself.
 * Never throws for a provider's fault.
 */
export async function testProvider(providerId: string): Promise<AcquisitionProvider> {
  const row = await providerEndpoint(providerId)
  let update: Partial<ProviderRow>
  try {
    const capabilities = await fetchCapabilities(row)
    update = { capabilities, coverage: capabilities.coverage, lastOkAt: new Date(), lastError: null }
  } catch (error) {
    if (!(error instanceof ProviderCallError)) throw error
    update = { lastError: error.message }
  }
  const [updated] = await db.update(acquisitionProviders).set({ ...update, updatedAt: new Date() })
    .where(eq(acquisitionProviders.id, providerId)).returning()
  invalidateProviders()
  return toProvider(updated!)
}

/** Records a failed call to a provider for the admin page. */
export async function noteProviderError(providerId: string, message: string) {
  await db.update(acquisitionProviders).set({ lastError: message.slice(0, 500), updatedAt: new Date() }).where(eq(acquisitionProviders.id, providerId))
}
