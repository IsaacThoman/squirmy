import { queryKeys, UserSettings, type UpdateUserSettings } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { users } from '../../database/schema.js'
import { notFound } from '../../lib/errors.js'
import { invalidate } from '../../realtime/index.js'

const libraryRoots = [['library'], ['home'], ['album'], ['artist'], ['track'], ['search'], ['likes'], ['playlists']] as const

/** The user's settings with defaults filled in for keys never set. */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  const [row] = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId))
  if (!row) throw notFound('No such user')
  return UserSettings.parse(row.settings)
}

/**
 * Merges a partial update into the stored settings in one statement. Keys the update
 * leaves out, including ones this version does not know (and per-user secrets), are kept.
 */
export async function updateUserSettings(userId: string, patch: UpdateUserSettings): Promise<UserSettings> {
  const [row] = await db.update(users)
    .set({ settings: sql`${users.settings} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ settings: users.settings })
  if (!row) throw notFound('No such user')
  // The scrobbling status reports each service's switch.
  const scrobbling = patch.scrobbleListenBrainz !== undefined || patch.scrobbleLastFm !== undefined
  await invalidate({ user: userId }, [
    queryKeys.settings(),
    ...scrobbling ? [queryKeys.scrobbling()] : [],
    // Whether the collection is in the library changes membership on every list and page
    // that shows it (`inLibrary`, an album's `library`), so all of them are read again.
    ...patch.libraryIncludesServerMusic !== undefined ? libraryRoots : [],
  ])
  return UserSettings.parse(row.settings)
}
