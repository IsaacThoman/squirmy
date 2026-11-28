import { queryKeys, UserSettings, type UpdateUserSettings } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { users } from '../../database/schema.js'
import { forbidden, notFound } from '../../lib/errors.js'
import { invalidate } from '../../realtime/index.js'

const libraryRoots = [['library'], ['home'], ['album'], ['artist'], ['track'], ['search'], ['likes'], ['playlists']] as const

/**
 * What changes when explicit content is turned on or off for a user: the lists and pages that
 * hide explicit songs or show clean versions in their place (Home, search, album pages), the
 * user (`User.allowsExplicit`, by which clients gray explicit songs) and everything cached
 * with the songs in it. Admins changing a restriction invalidate the same.
 */
export const explicitRoots = [...libraryRoots, ['me']] as const

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
  if (patch.allowExplicit === true) {
    const [user] = await db.select({ restricted: users.explicitRestricted }).from(users).where(eq(users.id, userId))
    if (!user) throw notFound('No such user')
    // The admin's restriction is the point: the user may not lift it from their own settings.
    if (user.restricted) throw forbidden('An admin has turned explicit content off for this account', 'explicit_restricted')
  }
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
    ...patch.allowExplicit !== undefined ? explicitRoots : [],
  ])
  return UserSettings.parse(row.settings)
}
