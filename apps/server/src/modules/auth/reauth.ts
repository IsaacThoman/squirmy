import { eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { db } from '../../database/client.js'
import { authSessions } from '../../database/schema.js'
import { requireUser, type AuthUser } from '../../lib/auth.js'
import { badRequest, forbidden } from '../../lib/errors.js'
import { hasPassword, verifyCredentials } from './service.js'

/** How recent a sign-in stands in for the password, on an account that has none. */
const recentSignInMs = 10 * 60 * 1000

/**
 * Confirms that whoever holds this session is the account's owner, before something a borrowed
 * session alone must not do (a credential that outlives it). With a password: the password. Without
 * one (an account made by single sign-on): a sign-in from the last ten minutes, which the provider
 * itself checked.
 */
export async function reauthenticate(request: FastifyRequest, currentPassword: string | undefined): Promise<AuthUser> {
  const user = requireUser(request)
  if (await hasPassword(user.id)) {
    if (!currentPassword) throw badRequest('Enter your current password', 'current_password_required')
    const verified = await verifyCredentials(user.username, currentPassword)
    if (!verified || verified.id !== user.id) throw forbidden('The current password is wrong', 'invalid_credentials')
    return user
  }
  const [session] = request.authSessionId
    ? await db.select({ createdAt: authSessions.createdAt }).from(authSessions).where(eq(authSessions.id, request.authSessionId))
    : []
  if (!session || Date.now() - session.createdAt.getTime() > recentSignInMs) {
    throw forbidden('Sign in again first: this needs a sign-in from the last 10 minutes.', 'reauth_required')
  }
  return user
}
