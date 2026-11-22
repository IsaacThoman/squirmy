import { createHash } from 'node:crypto'
import {
  Id, ProviderCapabilities,
  type AcquisitionProvider, type ClearProviderMissesResponse, type CreateAcquisitionProviderRequest, type ProviderCoverage, type UpdateAcquisitionProviderRequest,
} from '@squirmy/contracts'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { acquisitionProviders } from '../../database/schema.js'
import { decrypt, encrypt } from '../../lib/crypto.js'
import { notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { dropCachedReads } from '../../lib/read-cache.js'
import { fetchCapabilities, ProviderCallError, type ProviderEndpoint } from './client.js'
import { forgetMisses, unavailableCounts } from './misses.js'
import { forgetAsked, invalidateRecordings } from './resolve.js'

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
/** Different recordings that fail at a provider, with nothing delivered in between, before it is failing (health.ts). */
export const FAILING_AFTER = 3
/** Other processes see provider changes within this long. */
const cacheMs = 30_000

let cache: { value: ActiveProvider[]; at: number } | undefined

/** Whether a provider is failing, from its streak of failed recordings (health.ts). */
export function isFailing(row: Pick<ProviderRow, 'failingSince' | 'failingRecordings'>): boolean {
  return row.failingSince !== null && row.failingRecordings.length >= FAILING_AFTER
}

/** The coverage that counts: the admin's override, else what the provider declared. */
function coverageOf(row: Pick<ProviderRow, 'coverage' | 'coverageOverride'>): ProviderCoverage {
  return (row.coverageOverride ?? row.coverage) as ProviderCoverage
}

/** Sorted keys all the way down, so the same answer always hashes the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, item]) => [key, canonical(item)]))
  return value
}

/**
 * Which build of a provider answered: its declared version (the protocol has none of its
 * own, and the field is optional) and a hash of everything it declared. A provider that
 * declares no version still changes identity when an update changes what it declares.
 */
export function providerIdentity(capabilities: ProviderCapabilities): string {
  const hash = createHash('sha256').update(JSON.stringify(canonical(capabilities))).digest('hex').slice(0, 16)
  return `${capabilities.version ?? 'unversioned'}#${hash}`
}

export function toProvider(row: ProviderRow, unavailableTracks = 0): AcquisitionProvider {
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
    failingSince: isFailing(row) ? row.failingSince!.toISOString() : null,
    unavailableTracks,
  }
}

/** One provider as the admin API shows it, with its unavailable tracks counted. */
async function shown(row: ProviderRow): Promise<AcquisitionProvider> {
  return toProvider(row, (await unavailableCounts()).get(row.id) ?? 0)
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
  const [rows, counts] = await Promise.all([
    db.select().from(acquisitionProviders).orderBy(desc(acquisitionProviders.priority), acquisitionProviders.id),
    unavailableCounts(),
  ])
  return rows.map((row) => toProvider(row, counts.get(row.id) ?? 0))
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

/**
 * Applies a partial update. A new address or secret is tested again. Turning the provider
 * back on, or pointing the server at it anew, is how an admin says it changed: what it
 * could not supply before is asked for again.
 */
export async function updateProvider(providerId: string, patch: UpdateAcquisitionProviderRequest): Promise<AcquisitionProvider> {
  const before = await loadRow(providerId)
  const reconfigured = (patch.enabled === true && !before.enabled)
    || (patch.baseUrl !== undefined && patch.baseUrl !== before.baseUrl)
    || patch.secret !== undefined
  const [row] = await db.update(acquisitionProviders).set({
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
    ...(patch.secret === undefined ? {} : { secretEncrypted: encrypt(secretPurpose, patch.secret) }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.coverage === undefined ? {} : { coverageOverride: patch.coverage }),
    updatedAt: new Date(),
  }).where(eq(acquisitionProviders.id, providerId)).returning()
  if (reconfigured) await missesForgotten(providerId, await forgetMisses(db, providerId, { resetHealth: true }))
  invalidateProviders()
  if (patch.baseUrl !== undefined || patch.secret !== undefined) return testProvider(providerId)
  return shown(reconfigured ? await loadRow(providerId) : row!)
}

/**
 * Once a provider's misses stop counting: its tracks' screens are refreshed, and a
 * `must_resolve` provider is asked about them again as soon as a list shows them.
 */
async function missesForgotten(providerId: string, recordingIds: readonly string[]) {
  forgetAsked(providerId)
  await invalidateRecordings(recordingIds)
}

/**
 * The admin's "Retry unavailable tracks": every miss the provider has recorded stops
 * counting (the rows stay for the history), so its tracks are on demand again and the next
 * request asks it again. Its failing streak, if any, is left alone: that is about whether
 * it delivers, which this does not change.
 */
export async function clearProviderMisses(providerId: string): Promise<ClearProviderMissesResponse> {
  await loadRow(providerId)
  const cleared = await forgetMisses(db, providerId)
  invalidateProviders()
  await missesForgotten(providerId, cleared)
  return { cleared: cleared.length, provider: await shown(await loadRow(providerId)) }
}

/** Deletes a provider with its jobs, offers and misses. */
export async function deleteProvider(providerId: string): Promise<void> {
  await loadRow(providerId)
  await db.delete(acquisitionProviders).where(eq(acquisitionProviders.id, providerId))
  invalidateProviders()
}

/**
 * Stores a `capabilities` answer: the capabilities, declared coverage and identity. When the
 * identity differs from the last one (another version, or other capabilities; also the
 * first answer since servers began recording it), the provider's misses stop counting and
 * its failing streak ends: they describe the provider it was.
 */
async function storeCapabilities(providerId: string, capabilities: ProviderCapabilities, extra: Partial<ProviderRow> = {}): Promise<ProviderRow> {
  const identity = providerIdentity(capabilities)
  const forgotten = await db.transaction(async (tx) => {
    // The lock keeps two checks of the same new version from both moving the epoch on.
    const [before] = await tx.select({ identity: acquisitionProviders.identity }).from(acquisitionProviders).where(eq(acquisitionProviders.id, providerId)).for('update')
    const changed = before !== undefined && before.identity !== identity
    await tx.update(acquisitionProviders).set({ capabilities, coverage: capabilities.coverage, identity, ...extra, updatedAt: new Date() })
      .where(eq(acquisitionProviders.id, providerId))
    return changed ? forgetMisses(tx, providerId, { resetHealth: true }) : null
  })
  invalidateProviders()
  if (forgotten) await missesForgotten(providerId, forgotten)
  return loadRow(providerId)
}

/**
 * `GET {baseUrl}/capabilities`: stores the answer (`storeCapabilities`) with `last_ok_at`,
 * or the failure as `last_error`. An admin's coverage override is kept: it is the
 * operator's word on what this provider can fetch, whatever it says of itself. Never
 * throws for a provider's fault.
 */
export async function testProvider(providerId: string): Promise<AcquisitionProvider> {
  const row = await providerEndpoint(providerId)
  try {
    const capabilities = await fetchCapabilities(row)
    return shown(await storeCapabilities(providerId, capabilities, { lastOkAt: new Date(), lastError: null }))
  } catch (error) {
    if (!(error instanceof ProviderCallError)) throw error
    const [updated] = await db.update(acquisitionProviders).set({ lastError: error.message, updatedAt: new Date() })
      .where(eq(acquisitionProviders.id, providerId)).returning()
    invalidateProviders()
    return shown(updated!)
  }
}

/**
 * `acquisition.check` (every five minutes and at worker start): asks each enabled provider
 * for its capabilities, so an updated provider is noticed without an admin pressing Test,
 * and its misses stop counting. An answer moves `last_ok_at` on, so the admin page shows it
 * answering; a failure is kept as `last_error`, as a failed resolve is. Neither touches the
 * failing streak (health.ts): that counts fetches of recordings, and answering
 * `capabilities` says nothing about whether the provider can still fetch them.
 */
export async function checkProviders() {
  const rows = await db.select({ id: acquisitionProviders.id }).from(acquisitionProviders).where(eq(acquisitionProviders.enabled, true))
  for (const { id } of rows) {
    try {
      await storeCapabilities(id, await fetchCapabilities(await providerEndpoint(id)))
      await noteProviderAnswered(id)
    } catch (error) {
      if (!(error instanceof ProviderCallError)) {
        if (getConfig().LOG_LEVEL !== 'silent') console.error('[acquisition] Could not check a provider', error)
        continue
      }
      // Rate limited is not a fault, as with a resolve.
      if (!error.busy) await noteProviderError(id, error.message)
    }
  }
}

/**
 * The provider answered a check. The last error goes unless the provider is failing: then
 * it is why fetches fail, which the admin page shows with the outage, and an answer to
 * `capabilities` does not make it untrue.
 */
async function noteProviderAnswered(providerId: string) {
  const failing = and(isNotNull(acquisitionProviders.failingSince), sql`cardinality(${acquisitionProviders.failingRecordings}) >= ${FAILING_AFTER}`)
  await db.update(acquisitionProviders)
    .set({ lastOkAt: new Date(), lastError: sql`case when ${failing} then ${acquisitionProviders.lastError} else null end`, updatedAt: new Date() })
    .where(eq(acquisitionProviders.id, providerId))
}

/** Records a failed call to a provider for the admin page. */
export async function noteProviderError(providerId: string, message: string) {
  await db.update(acquisitionProviders).set({ lastError: message.slice(0, 500), updatedAt: new Date() }).where(eq(acquisitionProviders.id, providerId))
}
