import {
  AuthResponse, ChangePasswordRequest, CreateAppPasswordRequest, Id, LoginRequest, RegisterRequest, SetupRequest,
  type AppPassword, type AppPasswordList, type ClientDevice, type Ok, type SetupStatus, type User,
} from '@squirmy/contracts'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db, type Executor } from '../../database/client.js'
import { invites, users } from '../../database/schema.js'
import { requireUser, SESSION_COOKIE, type AuthUser } from '../../lib/auth.js'
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js'
import { addressKey } from '../../lib/proxy.js'
import { getServerSettings } from '../../lib/settings.js'
import { getVersion } from '../../lib/version.js'
import { disconnectSockets } from '../../realtime/index.js'
import {
  countUsers, createAppPassword, createSession, deleteAppPassword, hashPassword, insertUser, listAppPasswords, revokeSession,
  revokeUserSessions, toUser, usernameKey, verifyCredentials,
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
    throw new AppError(429, 'rate_limited', `Too many attempts. Try again in ${result.ttlInSeconds} seconds.`)
  }
}

const isWeb = (request: FastifyRequest) => request.headers['x-squirmy-client'] === 'web'

function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: request.protocol === 'https',
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
  const loginPerUsername = limiter(app, 'login-user', 5, (request) =>
    usernameKey(String((request.body as { username?: unknown } | undefined)?.username ?? '')))
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

  app.post('/auth/login', { preHandler: [loginPerIp, loginPerUsername] }, async (request, reply): Promise<AuthResponse> => {
    const body = LoginRequest.parse(request.body)
    const user = await verifyCredentials(body.username, body.password)
    if (!user) throw unauthorized('Wrong username or password', 'invalid_credentials')
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
    })
    await disconnectSockets(current.id, { except: request.authSessionId ?? undefined })
    return { ok: true }
  })

  app.get('/auth/app-passwords', async (request): Promise<AppPasswordList> => {
    const user = requireUser(request)
    return { items: await listAppPasswords(user.id), nextCursor: null }
  })

  app.post('/auth/app-passwords', async (request, reply): Promise<AppPassword> => {
    const user = requireUser(request)
    const body = CreateAppPasswordRequest.parse(request.body)
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
