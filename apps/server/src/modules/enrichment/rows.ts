/** Small catalog helpers shared by the enrichment steps. */
import { queryKeys } from '@squirmy/contracts'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db, type Executor, type Transaction } from '../../database/client.js'
import { albums, artists, externalIds, recordings, type CatalogEntityType } from '../../database/schema.js'
import { ProviderError } from '../../lib/http.js'
import { invalidate } from '../../realtime/index.js'
import { holdsCollection, saversOf } from '../catalog/availability.js'
import { lockUpserts } from '../matching/apply.js'
import { mergeAlbum, mergeArtist, mergeRecording, resolveMerged } from '../matching/merge.js'
import { warn } from './runner.js'

type EntityType = Exclude<CatalogEntityType, 'release'>

const tables = { artist: artists, album: albums, recording: recordings } as const
const mergers = { artist: mergeArtist, album: mergeAlbum, recording: mergeRecording } as const

export const day = 86_400_000

/** Follows merge redirects; null when the row does not exist. */
export async function currentId(type: EntityType, id: string): Promise<string | null> {
  const table = tables[type]
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id))
  return row ? resolveMerged(db, table, id) : null
}

/** The row's id at `provider` (the oldest when it has several), or null. */
export async function externalIdOf(provider: string, type: EntityType, entityId: string): Promise<string | null> {
  const [row] = await db.select({ id: externalIds.externalId }).from(externalIds)
    .where(and(eq(externalIds.provider, provider), eq(externalIds.entityType, type), eq(externalIds.entityId, entityId)))
    .orderBy(asc(externalIds.createdAt), asc(externalIds.externalId)).limit(1)
  return row?.id ?? null
}

/** SQL condition: the row has a present file, directly or, for an artist, through an album it is credited on. */
function hasFiles(type: EntityType, id: string) {
  switch (type) {
    case 'recording': return sql`exists (select 1 from media_files f where f.recording_id = ${id} and f.missing_since is null)`
    case 'album': return sql`exists (select 1 from media_files f where f.album_id = ${id} and f.missing_since is null)`
    case 'artist': return sql`exists (select 1 from album_artists aa join media_files f on f.album_id = aa.album_id and f.missing_since is null where aa.artist_id = ${id})`
  }
}

/** Whether a present file belongs to the album. */
export async function albumOwned(albumId: string, executor: Executor = db): Promise<boolean> {
  const [row] = await executor.execute<{ owned: boolean }>(sql`select ${hasFiles('album', albumId)} as owned`)
  return Boolean(row?.owned)
}

/**
 * Records that `externalId` at `provider` is `entityId`. When another row already holds
 * the id and has neither a MusicBrainz id nor files (a search stub, or a row built from
 * that provider), it is the same thing and is merged into `entityId`. Returns false when
 * the id stays with a different row.
 */
export async function linkExternalId(provider: string, type: EntityType, externalId: string, entityId: string): Promise<boolean> {
  const table = tables[type]
  return db.transaction(async (tx) => {
    await lockUpserts(tx)
    const key = and(eq(externalIds.provider, provider), eq(externalIds.entityType, type), eq(externalIds.externalId, externalId))
    const [row] = await tx.select({ entityId: externalIds.entityId }).from(externalIds).where(key)
    if (!row) {
      await tx.insert(externalIds).values({ provider, entityType: type, externalId, entityId }).onConflictDoNothing()
      return true
    }
    const [holder, target] = [await resolveMerged(tx, table, row.entityId), await resolveMerged(tx, table, entityId)]
    if (holder === target) return true
    const [other] = await tx.execute<{ mbid: string | null; owned: boolean }>(sql`
      select mbid, ${hasFiles(type, holder)} as owned from ${table} where id = ${holder}`)
    if (!other || other.mbid || other.owned) return false
    await mergers[type](holder, target, tx)
    return true
  })
}

/**
 * Gives a row a MusicBrainz id. When another row already has it, this row is merged into
 * that one. Returns the id of the row that now holds the MBID. Call it under `lockUpserts`.
 */
export async function adoptMbid(tx: Transaction, type: 'album' | 'artist', id: string, mbid: string): Promise<string> {
  const table = tables[type]
  const [row] = await tx.select({ mbid: table.mbid }).from(table).where(eq(table.id, id))
  if (row?.mbid === mbid) return id
  const [other] = await tx.select({ id: table.id }).from(table).where(eq(table.mbid, mbid))
  if (other) {
    const into = await resolveMerged(tx, table, other.id)
    if (into !== id) await mergers[type](id, into, tx)
    return into
  }
  await tx.update(table).set({ mbid, updatedAt: new Date() }).where(eq(table.id, id))
  return id
}

/** `adoptMbid` in its own transaction. */
export async function adoptMbidNow(type: 'album' | 'artist', id: string, mbid: string): Promise<string> {
  return db.transaction(async (tx) => {
    await lockUpserts(tx)
    return adoptMbid(tx, type, id, mbid)
  })
}

/**
 * Runs one optional step. A provider failure is logged and reported as false, so one
 * service being down does not stop the steps that need other services.
 */
export async function attempt(label: string, step: () => Promise<unknown>): Promise<boolean> {
  try {
    await step()
    return true
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    warn(`${label}: ${error.message}`)
    return false
  }
}

/** Tells every client to refetch these query keys. */
export async function changed(keys: readonly (readonly unknown[])[]) {
  if (keys.length > 0) await invalidate('all', keys).catch((error: unknown) => warn('Could not send invalidations', error))
}

/**
 * An album's cover or description changed. Its page is refetched where it is open; the
 * library's lists and Home, which show its cover, only for the users whose library holds
 * it. An album of fetched music is in nobody else's, and every delivery enriches one.
 */
export async function albumChanged(albumId: string) {
  if (await holdsCollection([albumId])) return changed([queryKeys.album(albumId), queryKeys.home(), queryKeys.library()])
  await changed([queryKeys.album(albumId)])
  for (const user of await saversOf([albumId], [])) {
    await invalidate({ user }, [queryKeys.home(), queryKeys.library()]).catch((error: unknown) => warn('Could not send invalidations', error))
  }
}

/** The 0..1 share of the largest value, for popularity. */
export function share(value: number, max: number): number {
  return max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
}
