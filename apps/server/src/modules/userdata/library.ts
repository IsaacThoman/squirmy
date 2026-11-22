/**
 * Saves to a user's library (`library_items`). A user's library is the server's collection
 * plus these saves (docs/architecture.md, "Availability"); the catalog lists read both.
 *
 * Saving needs no file: the album or track is in the library at once, and for a user who
 * may fetch music the server then fetches what is missing, in the background and on a
 * best-effort basis, so a provider that is slow or down never fails the save. Removing
 * deletes the save and nothing else: files stay as cache, likes and playlists stay.
 */
import { queryKeys, type LibraryEntityType } from '@squirmy/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { libraryItems, users } from '../../database/schema.js'
import { AppError } from '../../lib/errors.js'
import { enqueue } from '../../jobs/index.js'
import { invalidate } from '../../realtime/index.js'
import { requestAlbum, requestTrack } from '../acquisition/jobs.js'
import { activeProviders } from '../acquisition/providers.js'
import { resolveMerged } from '../catalog/redirects.js'
import { albumDetailRun } from '../enrichment/detail.js'
import { entityKey, entityTable, resolveEntity, storedType } from './entities.js'

export type FetchSavedJob = { userId: string; type: LibraryEntityType; id: string }

function warn(message: string, error?: unknown) {
  if (getConfig().LOG_LEVEL === 'silent') return
  console.warn(`[userdata] ${message}`, ...(error === undefined ? [] : [error]))
}

/** Everything that shows whether the entity is in the user's library, for their other devices. */
async function invalidateLibrary(userId: string, type: LibraryEntityType, id: string) {
  // Track rows carry `inLibrary` wherever they are listed (wants too); artists count library albums.
  const keys: (readonly unknown[])[] = [
    queryKeys.library(), queryKeys.home(), queryKeys.likes(), queryKeys.playlists(), queryKeys.history(), queryKeys.search(), queryKeys.wants(),
    entityKey(type, id),
  ]
  const pages = await db.execute<{ kind: 'album' | 'artist' | 'track'; id: string }>(type === 'album'
    ? sql`
      select 'artist' as kind, artist_id as id from album_artists where album_id = ${id}
      union select 'track', recording_id from media_files where album_id = ${id} and recording_id is not null
      union select 'track', rt.recording_id from release_tracks rt join releases rl on rl.id = rt.release_id where rl.album_id = ${id}`
    : sql`
      select distinct 'album' as kind, rl.album_id as id from release_tracks rt join releases rl on rl.id = rt.release_id where rt.recording_id = ${id}
      union select 'album', album_id from media_files where recording_id = ${id} and album_id is not null
      union select 'artist', artist_id from recording_artists where recording_id = ${id}`)
  keys.push(...pages.map((page) => entityKey(page.kind, page.id)))
  await invalidate({ user: userId }, keys)
}

/** Whether the user may spend a provider: an enabled admin, or a member with `canAcquire`. */
async function isRequester(userId: string): Promise<boolean> {
  const [user] = await db.select({ role: users.role, canAcquire: users.canAcquire, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
  return Boolean(user && !user.disabledAt && (user.canAcquire || user.role === 'admin'))
}

/**
 * Saves an album or track to the user's library (idempotent). Follows merge redirects;
 * 404 when it does not exist. Returns the id saved.
 */
export async function saveToLibrary(userId: string, type: LibraryEntityType, id: string): Promise<string> {
  const entityId = await resolveEntity(type, id)
  await db.insert(libraryItems).values({ userId, entityType: storedType[type], entityId }).onConflictDoNothing()
  await invalidateLibrary(userId, type, entityId)
  try {
    if ((await activeProviders()).length > 0 && await isRequester(userId)) {
      await enqueue<FetchSavedJob>('userdata.fetch-saved', { userId, type, id: entityId }, { singletonKey: `${userId}:${type}:${entityId}` })
    }
  } catch (error) {
    warn(`Could not ask for the files of saved ${type} ${entityId}`, error)
  }
  return entityId
}

/** Removes a save (idempotent), under the given id and wherever its redirects lead. */
export async function removeFromLibrary(userId: string, type: LibraryEntityType, id: string): Promise<void> {
  const resolved = (await resolveMerged(entityTable[type], [id])).get(id)
  const ids = [...new Set([id, resolved ?? id])]
  await db.delete(libraryItems).where(and(eq(libraryItems.userId, userId), eq(libraryItems.entityType, storedType[type]), inArray(libraryItems.entityId, ids)))
  await invalidateLibrary(userId, type, resolved ?? id)
}

/**
 * The `userdata.fetch-saved` job: asks acquisition for what a save is missing. An album
 * from a search may not have a track list yet, so that is completed first. Refusals
 * (nothing to fetch, no provider has it, the user may no longer fetch) are logged and end
 * the job; only unexpected errors retry. A save removed meanwhile fetches nothing.
 */
export async function fetchSaved({ userId, type, id }: FetchSavedJob): Promise<void> {
  const [kept] = await db.select({ id: libraryItems.entityId }).from(libraryItems)
    .where(and(eq(libraryItems.userId, userId), eq(libraryItems.entityType, storedType[type]), eq(libraryItems.entityId, id)))
  if (!kept) return
  try {
    // Acquisition records no origin for a request yet; once it does, these are `library` ones.
    if (type === 'album') {
      await albumDetailRun(id).catch((error: unknown) => warn(`Could not complete album ${id} before fetching it`, error))
      await requestAlbum(userId, id)
    } else {
      await requestTrack(userId, id, null)
    }
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    if (error.code !== 'already_available') warn(`Not fetching saved ${type} ${id}: ${error.code}`)
  }
}
