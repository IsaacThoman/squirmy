import {
  AuthResponse, ChangePasswordRequest, CreateAppPasswordRequest, Id, LoginRequest, RegisterRequest, SetupRequest,
  type AppPassword, type AppPasswordList, type ClientDevice, type Ok, type SetupStatus, type User,
} from '@squirmy/contracts'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { getConfig } from '../../config.js'
import { db, type Executor } from '../../database/client.js'
import { invites, users } from '../../database/schema.js'
import { requireUser, SESSION_COOKIE, type AuthUser } from '../../lib/auth.js'
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js'
import { FailureCounter, KnownPlaces } from '../../lib/failures.js'
import { addressKey, networkKey } from '../../lib/proxy.js'
import { getServerSettings } from '../../lib/settings.js'
import { getVersion } from '../../lib/version.js'
import { disconnectSockets } from '../../realtime/index.js'
import {
  countUsers, createAppPassword, createSession, deleteAppPassword, hashPassword, insertUser, listAppPasswords, revokeAppPasswords,
  revokeSession, revokeUserSessions, toUser, usernameKey, verifyCredentials,
} from './service.js'

const cookieMaxAgeSeconds = 180 * 24 * 60 * 60

/**
 * A per-minute limit as a preHandler. Every limiter shares the plugin's store, so keys are
 * namespaced; counters live in this process only.
 */
function limiter(app: FastifyInstance, name: string, max: number, key: (request: FastifyRequest) => string) {
  const check = app.createRateLimit({ max, timeWindow: 60_000, keyGenerator: (request) => `${name}:${key(request)}` })
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await check(request)
    if (result.isAllowed || !result.isExceeded) return
    reply.header('retry-after', result.ttlInSeconds)
    throw tooMany(result.ttlInSeconds)
  }
}

function tooMany(seconds: number): AppError {
  return new AppError(429, 'rate_limited', `Too many attempts. Try again in ${seconds} seconds.`)
}

const isWeb = (request: FastifyRequest) => request.headers['x-squirmy-client'] === 'web'

/**
 * Whether the browser reached the server over HTTPS. A proxy or tunnel that terminates TLS
 * and does not forward the protocol makes the request look like plain HTTP, so an https
 * PUBLIC_URL also counts for requests to its host name. Other names (a LAN address over
 * plain HTTP) keep a cookie browsers accept there.
 */
function isHttps(request: FastifyRequest): boolean {
  if (request.protocol === 'https') return true
  const publicUrl = getConfig().PUBLIC_URL
  if (!publicUrl?.startsWith('https://')) return false
  // A trailing dot names the same host to DNS and to the browser.
  return new URL(publicUrl).hostname.replace(/\.$/, '') === request.hostname.toLowerCase().replace(/\.$/, '')
}

function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(request),
    maxAge: cookieMaxAgeSeconds,
  })
}

/** Opens a session for a user who just proved who they are, and answers with `AuthResponse`. */
async function signIn(request: FastifyRequest, reply: FastifyReply, executor: Executor, user: AuthUser, device?: ClientDevice): Promise<AuthResponse> {
  const { token } = await createSession(executor, {
    userId: user.id,
    device,
    clientKind: device?.kind ?? (isWeb(request) ? 'web' : 'other'),
    userAgent: request.headers['user-agent'],
  })
  if (isWeb(request)) setSessionCookie(request, reply, token)
  return { user: toUser(user), token }
}

export async function authRoutes(app: FastifyInstance) {
  const loginPerIp = limiter(app, 'login-ip', 20, (request) => addressKey(request.ip))
  // Failed sign-ins only. Per username and address, so someone guessing from one place
  // cannot lock the owner out from another; per username and IPv6 /48, since one client
  // can hold many /64s; and per username across every address, a ceiling against guessing
  // from many places at once. Addresses the account signed in from lately are exempt from
  // that ceiling, so an attack spread over many addresses cannot lock the owner out of
  // the places they actually use.
  const failuresHere = new FailureCounter(5, 60_000)
  const failuresNearby = new FailureCounter(10, 60_000)
  const failuresAnywhere = new FailureCounter(30, 60_000)
  const knownPlaces = new KnownPlaces(30 * 24 * 60 * 60 * 1000)
  const setupPerIp = limiter(app, 'setup-ip', 10, (request) => addressKey(request.ip))
  const registerPerIp = limiter(app, 'register-ip', 10, (request) => addressKey(request.ip))
  const passwordPerUser = limiter(app, 'password-user', 10, (request) => request.user?.id ?? addressKey(request.ip))

  app.get('/setup/status', async (): Promise<SetupStatus> => {
    const settings = await getServerSettings()
    return {
      needsSetup: (await countUsers()) === 0,
      version: getVersion(),
      serverName: settings.serverName,
      registrationRequiresInvite: settings.registrationRequiresInvite,
      wantlistEnabled: settings.wantlistEnabled,
      sharingEnabled: settings.sharingEnabled,
      supportsTvDevices: true,
    }
  })

  app.post('/setup', { preHandler: setupPerIp }, async (request, reply): Promise<AuthResponse> => {
    const body = SetupRequest.parse(request.body)
    return db.transaction(async (tx) => {
      // Two setup requests racing must not both create an admin.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('squirmy:setup'))`)
      if ((await countUsers(tx)) > 0) throw conflict('This server is already set up', 'already_set_up')
      const user = await insertUser(tx, { username: body.username, password: body.password, role: 'admin', canUpload: true, canAcquire: true })
      return signIn(request, reply, tx, user, body.device)
    })
  })

  app.post('/auth/login', { preHandler: loginPerIp }, async (request, reply): Promise<AuthResponse> => {
    const body = LoginRequest.parse(request.body)
    const name = usernameKey(body.username)
    const here = `${name}\n${addressKey(request.ip)}`
    const nearby = `${name}\n${networkKey(request.ip)}`
    const known = knownPlaces.has(here)
    const wait = Math.max(
      failuresHere.blockedFor(here),
      failuresNearby.blockedFor(nearby),
      known ? 0 : failuresAnywhere.blockedFor(name),
    )
    if (wait > 0) {
      reply.header('retry-after', wait)
      throw tooMany(wait)
    }
    // Counted before the password check and taken back on success, in the same tick as
    // the checks above, so concurrent attempts cannot all slip past the limits.
    failuresHere.fail(here)
    failuresNearby.fail(nearby)
    failuresAnywhere.fail(name)
    const user = await verifyCredentials(body.username, body.password)
    if (!user) throw unauthorized('Wrong username or password', 'invalid_credentials')
    failuresHere.clear(here)
    failuresNearby.undo(nearby)
    failuresAnywhere.undo(name)
    knownPlaces.add(here)
    if (user.disabledAt) throw forbidden('This account is disabled', 'account_disabled')
    return signIn(request, reply, db, user, body.device)
  })

  app.post('/auth/logout', async (request, reply): Promise<Ok> => {
    if (request.authSessionId && request.user) {
      await revokeSession(request.authSessionId)
      await disconnectSockets(request.user.id, { only: request.authSessionId })
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/auth/me', async (request, reply): Promise<User> => {
    const user = requireUser(request)
    // Browsers open the app with this call; renewing the cookie keeps its expiry sliding too.
    const token = request.cookies[SESSION_COOKIE]
    if (request.viaCookie && token) setSessionCookie(request, reply, token)
    return toUser(user)
  })

  app.post('/auth/register', { preHandler: registerPerIp }, async (request, reply): Promise<AuthResponse> => {
    const body = RegisterRequest.parse(request.body)
    const settings = await getServerSettings()
    if ((await countUsers()) === 0) throw conflict('Set up the server first', 'setup_required')
    if (!body.inviteCode && settings.registrationRequiresInvite) throw badRequest('An invite code is required', 'invite_required')
    return db.transaction(async (tx) => {
      let invite: typeof invites.$inferSelect | undefined
      if (body.inviteCode) {
        // Claiming in one statement means two registrations cannot share an invite.
        [invite] = await tx.update(invites)
          .set({ usedAt: new Date() })
          .where(and(
            eq(invites.code, body.inviteCode),
            isNull(invites.usedAt),
            or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
          ))
          .returning()
        if (!invite) throw badRequest('That invite code is not valid', 'invalid_invite')
      }
      const user = await insertUser(tx, {
        username: body.username,
        password: body.password,
        role: invite?.role ?? 'member',
        canUpload: invite?.canUpload ?? false,
        canAcquire: invite?.canAcquire ?? false,
      })
      if (invite) await tx.update(invites).set({ usedBy: user.id }).where(eq(invites.id, invite.id))
      return signIn(request, reply, tx, user, body.device)
    })
  })

  app.post('/auth/password', { preHandler: passwordPerUser }, async (request): Promise<Ok> => {
    const current = requireUser(request)
    const body = ChangePasswordRequest.parse(request.body)
    const verified = await verifyCredentials(current.username, body.currentPassword)
    if (!verified || verified.id !== current.id) throw forbidden('The current password is wrong', 'invalid_credentials')
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() }).where(eq(users.id, current.id))
      await revokeUserSessions(tx, current.id, request.authSessionId ?? undefined)
      if (!body.keepAppPasswords) await revokeAppPasswords(tx, current.id)
    })
    await disconnectSockets(current.id, { except: request.authSessionId ?? undefined })
    return { ok: true }
  })

  app.get('/auth/app-passwords', async (request): Promise<AppPasswordList> => {
    const user = requireUser(request)
    return { items: await listAppPasswords(user.id), nextCursor: null }
  })

  app.post('/auth/app-passwords', { preHandler: passwordPerUser }, async (request, reply): Promise<AppPassword> => {
    const user = requireUser(request)
    const sent = request.body as { currentPassword?: unknown } | undefined
    if (typeof sent?.currentPassword !== 'string' || !sent.currentPassword) {
      throw badRequest('Enter your current password to create an app password', 'current_password_required')
    }
    const body = CreateAppPasswordRequest.parse(request.body)
    const verified = await verifyCredentials(user.username, body.currentPassword)
    if (!verified || verified.id !== user.id) throw forbidden('The current password is wrong', 'invalid_credentials')
    reply.code(201)
    return createAppPassword(user.id, body.name)
  })

  app.delete('/auth/app-passwords/:id', async (request): Promise<Ok> => {
    const user = requireUser(request)
    const { id } = z.object({ id: Id }).parse(request.params)
    if (!await deleteAppPassword(user.id, id)) throw notFound()
    return { ok: true }
  })
}
