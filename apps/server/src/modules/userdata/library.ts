/**
 * Fetching what a library save is missing. Saving is the heart (`likes.ts`); a user's library
 * is the server's collection plus those saves (docs/architecture.md, "Availability").
 *
 * Saving needs no file: the album or track is in the library at once, and for a user who
 * may fetch music the server then fetches what is missing, in the background and on a
 * best-effort basis, so a provider that is slow or down never fails the save.
 */
import type { LibraryEntityType } from '@squirmy/contracts'
import { and, eq } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { likes, users } from '../../database/schema.js'
import { AppError } from '../../lib/errors.js'
import { enqueue } from '../../jobs/index.js'
import { requestAlbum, requestTrack } from '../acquisition/jobs.js'
import { activeProviders } from '../acquisition/providers.js'
import { albumDetailRun } from '../enrichment/detail.js'
import { storedType } from './entities.js'

export type FetchSavedJob = { userId: string; type: LibraryEntityType; id: string }

function warn(message: string, error?: unknown) {
  if (getConfig().LOG_LEVEL === 'silent') return
  console.warn(`[userdata] ${message}`, ...(error === undefined ? [] : [error]))
}

/** Whether the user may spend a provider: an enabled admin, or a member with `canAcquire`. */
async function isRequester(userId: string): Promise<boolean> {
  const [user] = await db.select({ role: users.role, canAcquire: users.canAcquire, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
  return Boolean(user && !user.disabledAt && (user.canAcquire || user.role === 'admin'))
}

/**
 * After a save of an album or track, asks in the background for what it is missing when the
 * user may fetch music and a provider is active. Never fails the save: a provider that is
 * slow or down only shows later, as unavailable rows.
 */
export async function fetchMissingOf(userId: string, type: LibraryEntityType, id: string): Promise<void> {
  try {
    if ((await activeProviders()).length > 0 && await isRequester(userId)) {
      await enqueue<FetchSavedJob>('userdata.fetch-saved', { userId, type, id }, { singletonKey: `${userId}:${type}:${id}` })
    }
  } catch (error) {
    warn(`Could not ask for the files of saved ${type} ${id}`, error)
  }
}

/**
 * The `userdata.fetch-saved` job: asks acquisition for what a save is missing. An album
 * from a search may not have a track list yet, so that is completed first. Refusals
 * (nothing to fetch, no provider has it, the user may no longer fetch) are logged and end
 * the job; only unexpected errors retry. A save removed meanwhile fetches nothing.
 */
export async function fetchSaved({ userId, type, id }: FetchSavedJob): Promise<void> {
  const [kept] = await db.select({ id: likes.entityId }).from(likes)
    .where(and(eq(likes.userId, userId), eq(likes.entityType, storedType[type]), eq(likes.entityId, id)))
  if (!kept) return
  try {
    // `library` jobs start after anything being played or fetched ahead.
    if (type === 'album') {
      await albumDetailRun(id).catch((error: unknown) => warn(`Could not complete album ${id} before fetching it`, error))
      await requestAlbum(userId, id, 'library')
    } else {
      await requestTrack(userId, id, null, 'library')
    }
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    if (error.code !== 'already_available') warn(`Not fetching saved ${type} ${id}: ${error.code}`)
  }
}
