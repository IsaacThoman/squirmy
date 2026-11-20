import type { FastifyRequest } from 'fastify'
import type { users } from '../database/schema.js'
import { forbidden, unauthorized } from './errors.js'

/** The signed-in user, as the auth hook loads it. */
export type AuthUser = Omit<typeof users.$inferSelect, 'passwordHash'>

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook for /api routes; null when the request carries no valid session. */
    user: AuthUser | null
    authSessionId: string | null
    /** True when the session came from the cookie rather than a bearer token. */
    viaCookie: boolean
  }
}

export const SESSION_COOKIE = 'squirmy_session'

export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw unauthorized()
  return request.user
}

export function requireAdmin(request: FastifyRequest): AuthUser {
  const user = requireUser(request)
  if (user.role !== 'admin') throw forbidden()
  return user
}
