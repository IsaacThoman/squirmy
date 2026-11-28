import {
  AuthResponse, ChangePasswordRequest, ConfirmTwoFactorRequest, CreateAppPasswordRequest, EnableTwoFactorRequest, Id, LoginRequest, PasskeyLoginRequest,
  RegisterPasskeyRequest, RegisterRequest, RenamePasskeyRequest, SetupRequest, StartPasskeyRequest, StartTwoFactorRequest, TwoFactorLoginRequest,
  type AccountSecurity, type AppPassword, type AppPasswordList, type AuthSessionList, type ClientDevice, type Ok, type Passkey, type PasskeyOptions,
  type RecoveryCodes, type SetupStatus, type SignInMethod, type TwoFactorChallenge, type TwoFactorSetup, type User,
} from '@squirmy/contracts'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
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
  authenticationOptions, deletePasskey, listPasskeys, registerPasskey, registrationOptions, relyingParty, renamePasskey, verifyPasskeySignIn,
} from './passkeys.js'
import { consumeChallenge, createChallenge, dropUserChallenges, failChallenge, findChallenge } from './challenges.js'
import {
  countUsers, createAppPassword, createSession, deleteAppPassword, hashPassword, insertUser, listAppPasswords, listSessions, revokeAppPasswords,
  revokeSession, revokeUserSession, revokeUserSessions, toUser, usernameKey, verifyCredentials,
} from './service.js'
import {
  disableTwoFactor, enableTwoFactor, regenerateRecoveryCodes, startTwoFactorSetup, twoFactorEnabled, twoFactorStatus, redeemSecondFactor,
} from './two-factor.js'

const cookieMaxAgeSeconds = 180 * 24 * 60 * 60
/** How long the second step of a sign-in waits for its code, and how many wrong codes it takes. */
const twoFactorChallengeMs = 5 * 60 * 1000
const twoFactorChallengeAttempts = 5
/** A passkey ceremony waits this long for the browser and the person at it. */
const passkeyChallengeMs = 5 * 60 * 1000

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
export async function signIn(
  request: FastifyRequest, reply: FastifyReply, executor: Executor, user: AuthUser, method: SignInMethod, device?: ClientDevice,
): Promise<AuthResponse> {
  const { token } = await createSession(executor, {
    userId: user.id,
    device,
    clientKind: device?.kind ?? (isWeb(request) ? 'web' : 'other'),
    userAgent: request.headers['user-agent'],
    method,
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
  const secondFactorPerIp = limiter(app, 'second-factor-ip', 20, (request) => addressKey(request.ip))
  // Wrong authenticator or recovery codes per account, wherever they come from: whoever tries
  // them already has the password (or a session), and six digits are few. Counted before the
  // check and taken back on success, like sign-in failures.
  const codeFailures = new FailureCounter(10, 60 * 60_000)

  /** Checks a second factor against the account's limit; resolves to what matched, or null. */
  async function checkSecondFactor(reply: FastifyReply, userId: string, code: string): Promise<'two_factor' | 'recovery_code' | null> {
    const wait = codeFailures.blockedFor(userId)
    if (wait > 0) {
      reply.header('retry-after', wait)
      throw tooMany(wait)
    }
    codeFailures.fail(userId)
    const matched = await redeemSecondFactor(userId, code)
    if (matched) codeFailures.undo(userId)
    return matched
  }

  /** The account password, for actions a borrowed session alone must not be able to take. */
  async function checkCurrentPassword(user: AuthUser, password: string) {
    const verified = await verifyCredentials(user.username, password)
    if (!verified || verified.id !== user.id) throw forbidden('The current password is wrong', 'invalid_credentials')
  }

  app.get('/setup/status', async (): Promise<SetupStatus> => {
    const settings = await getServerSettings()
    return {
      needsSetup: (await countUsers()) === 0,
      version: getVersion(),
      serverName: settings.serverName,
      registrationRequiresInvite: settings.registrationRequiresInvite,
      wantlistEnabled: settings.wantlistEnabled,
      supportsTvDevices: true,
      passkeysAvailable: relyingParty() !== null,
    }
  })

  app.post('/setup', { preHandler: setupPerIp }, async (request, reply): Promise<AuthResponse> => {
    const body = SetupRequest.parse(request.body)
    return db.transaction(async (tx) => {
      // Two setup requests racing must not both create an admin.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('squirmy:setup'))`)
      if ((await countUsers(tx)) > 0) throw conflict('This server is already set up', 'already_set_up')
      const user = await insertUser(tx, { username: body.username, password: body.password, role: 'admin', canUpload: true, canAcquire: true })
      return signIn(request, reply, tx, user, 'password', body.device)
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
    if (await twoFactorEnabled(user.id)) {
      // No session yet: the code comes next, with this challenge.
      const { token, expiresAt } = await createChallenge({ kind: 'two_factor', userId: user.id, ttlMs: twoFactorChallengeMs })
      const details: TwoFactorChallenge = { challenge: token, expiresAt: expiresAt.toISOString() }
      throw new AppError(401, 'two_factor_required', 'Enter the code from your authenticator app.', details)
    }
    return signIn(request, reply, db, user, 'password', body.device)
  })

  app.post('/auth/login/two-factor', { preHandler: secondFactorPerIp }, async (request, reply): Promise<AuthResponse> => {
    const body = TwoFactorLoginRequest.parse(request.body)
    const expired = () => unauthorized('That sign-in has expired. Enter your password again.', 'invalid_challenge')
    const challenge = await findChallenge('two_factor', body.challenge)
    if (!challenge?.userId) throw expired()
    const matched = await checkSecondFactor(reply, challenge.userId, body.code)
    if (!matched) {
      await failChallenge(challenge.id, twoFactorChallengeAttempts)
      throw unauthorized('That code is not right. Check your authenticator app and try again.', 'invalid_code')
    }
    // Used up only now, so a mistyped code can be corrected; only one request gets it.
    if (!await consumeChallenge('two_factor', body.challenge)) throw expired()
    const [user] = await db.select().from(users).where(eq(users.id, challenge.userId))
    if (!user) throw expired()
    if (user.disabledAt) throw forbidden('This account is disabled', 'account_disabled')
    return signIn(request, reply, db, user, matched, body.device)
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
      return signIn(request, reply, tx, user, 'password', body.device)
    })
  })

  app.post('/auth/password', { preHandler: passwordPerUser }, async (request): Promise<Ok> => {
    const current = requireUser(request)
    const body = ChangePasswordRequest.parse(request.body)
    await checkCurrentPassword(current, body.currentPassword)
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() }).where(eq(users.id, current.id))
      await revokeUserSessions(tx, current.id, request.authSessionId ?? undefined)
      await dropUserChallenges(tx, current.id)
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
    await checkCurrentPassword(user, body.currentPassword)
    reply.code(201)
    return createAppPassword(user.id, body.name)
  })

  app.delete('/auth/app-passwords/:id', async (request): Promise<Ok> => {
    const user = requireUser(request)
    const { id } = z.object({ id: Id }).parse(request.params)
    if (!await deleteAppPassword(user.id, id)) throw notFound()
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // Sessions: where the account is signed in
  // -------------------------------------------------------------------------

  app.get('/auth/sessions', async (request): Promise<AuthSessionList> => {
    const user = requireUser(request)
    return { items: await listSessions(user.id, request.authSessionId), nextCursor: null }
  })

  app.delete('/auth/sessions/:id', async (request, reply): Promise<Ok> => {
    const user = requireUser(request)
    const { id } = z.object({ id: Id }).parse(request.params)
    if (!await revokeUserSession(user.id, id)) throw notFound('No such session')
    await disconnectSockets(user.id, { only: id })
    // Ending this browser's own session is signing out.
    if (id === request.authSessionId) reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.post('/auth/sessions/revoke-others', async (request): Promise<Ok> => {
    const user = requireUser(request)
    await revokeUserSessions(db, user.id, request.authSessionId ?? undefined)
    await disconnectSockets(user.id, { except: request.authSessionId ?? undefined })
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // Two-factor authentication (TOTP) for password sign-ins
  // -------------------------------------------------------------------------

  app.get('/auth/security', async (request): Promise<AccountSecurity> => {
    const user = requireUser(request)
    return { hasPassword: true, twoFactor: await twoFactorStatus(user.id), passkeys: await listPasskeys(user.id) }
  })

  app.post('/auth/two-factor/setup', { preHandler: passwordPerUser }, async (request): Promise<TwoFactorSetup> => {
    const user = requireUser(request)
    const body = StartTwoFactorRequest.parse(request.body)
    await checkCurrentPassword(user, body.currentPassword)
    const { serverName } = await getServerSettings()
    return startTwoFactorSetup(user, serverName)
  })

  app.post('/auth/two-factor/enable', { preHandler: passwordPerUser }, async (request): Promise<RecoveryCodes> => {
    const user = requireUser(request)
    const body = EnableTwoFactorRequest.parse(request.body)
    const codes = await enableTwoFactor(user.id, body.code)
    if (!codes) throw forbidden('That code is not right. Check the time on your phone and try the newest code.', 'invalid_code')
    return { recoveryCodes: codes }
  })

  /** Password and a current code, so a borrowed session cannot quietly turn the second factor off. */
  async function confirmTwoFactor(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser> {
    const user = requireUser(request)
    const body = ConfirmTwoFactorRequest.parse(request.body)
    if (!await twoFactorEnabled(user.id)) throw conflict('Two-factor authentication is off', 'two_factor_disabled')
    await checkCurrentPassword(user, body.currentPassword)
    if (!await checkSecondFactor(reply, user.id, body.code)) {
      throw forbidden('That code is not right. Use the newest code from your authenticator app, or an unused recovery code.', 'invalid_code')
    }
    return user
  }

  app.post('/auth/two-factor/disable', { preHandler: passwordPerUser }, async (request, reply): Promise<Ok> => {
    const user = await confirmTwoFactor(request, reply)
    await disableTwoFactor(db, user.id)
    return { ok: true }
  })

  app.post('/auth/two-factor/recovery-codes', { preHandler: passwordPerUser }, async (request, reply): Promise<RecoveryCodes> => {
    const user = await confirmTwoFactor(request, reply)
    return { recoveryCodes: await regenerateRecoveryCodes(user.id) }
  })

  // -------------------------------------------------------------------------
  // Passkeys (WebAuthn): added in settings, used on the sign-in page
  // -------------------------------------------------------------------------

  const passkeyPerIp = limiter(app, 'passkey-ip', 20, (request) => addressKey(request.ip))

  function requireRelyingParty() {
    const rp = relyingParty()
    if (!rp) throw new AppError(409, 'passkeys_unavailable', 'Passkeys need PUBLIC_URL to be the server’s https address.')
    return rp
  }

  app.post('/auth/passkeys/options', { preHandler: passwordPerUser }, async (request): Promise<PasskeyOptions> => {
    const user = requireUser(request)
    const rp = requireRelyingParty()
    const body = StartPasskeyRequest.parse(request.body)
    // A passkey outlives the session it is added from, like an app password.
    await checkCurrentPassword(user, body.currentPassword)
    const options = await registrationOptions(user, rp, (await getServerSettings()).serverName)
    const { token } = await createChallenge({ kind: 'passkey_register', userId: user.id, data: { challenge: options.challenge }, ttlMs: passkeyChallengeMs })
    return { challenge: token, options: options as unknown as Record<string, unknown> }
  })

  app.post('/auth/passkeys', { preHandler: passwordPerUser }, async (request, reply): Promise<Passkey> => {
    const user = requireUser(request)
    const rp = requireRelyingParty()
    const body = RegisterPasskeyRequest.parse(request.body)
    const challenge = await consumeChallenge('passkey_register', body.challenge)
    if (!challenge || challenge.userId !== user.id) throw badRequest('That took too long. Add the passkey again.', 'invalid_challenge')
    const passkey = await registerPasskey({
      userId: user.id,
      name: body.name,
      expectedChallenge: String(challenge.data.challenge),
      response: body.response as unknown as RegistrationResponseJSON,
      rp,
    })
    if (!passkey) throw badRequest('The passkey could not be checked. Try again.', 'invalid_passkey')
    reply.code(201)
    return passkey
  })

  app.patch('/auth/passkeys/:id', async (request): Promise<Passkey> => {
    const user = requireUser(request)
    const { id } = z.object({ id: Id }).parse(request.params)
    const body = RenamePasskeyRequest.parse(request.body)
    const passkey = await renamePasskey(user.id, id, body.name)
    if (!passkey) throw notFound('No such passkey')
    return passkey
  })

  app.delete('/auth/passkeys/:id', async (request): Promise<Ok> => {
    const user = requireUser(request)
    const { id } = z.object({ id: Id }).parse(request.params)
    if (!await deletePasskey(user.id, id)) throw notFound('No such passkey')
    return { ok: true }
  })

  app.post('/auth/passkey-login/options', { preHandler: passkeyPerIp }, async (): Promise<PasskeyOptions> => {
    const rp = requireRelyingParty()
    const options = await authenticationOptions(rp)
    const { token } = await createChallenge({ kind: 'passkey_login', data: { challenge: options.challenge }, ttlMs: passkeyChallengeMs })
    return { challenge: token, options: options as unknown as Record<string, unknown> }
  })

  app.post('/auth/passkey-login', { preHandler: passkeyPerIp }, async (request, reply): Promise<AuthResponse> => {
    const rp = requireRelyingParty()
    const body = PasskeyLoginRequest.parse(request.body)
    // Used up whatever the outcome: each ceremony is signed over its own challenge.
    const challenge = await consumeChallenge('passkey_login', body.challenge)
    if (!challenge) throw unauthorized('That took too long. Try your passkey again.', 'invalid_challenge')
    const user = await verifyPasskeySignIn({
      expectedChallenge: String(challenge.data.challenge),
      response: body.response as unknown as AuthenticationResponseJSON,
      rp,
    })
    if (!user) throw unauthorized('That passkey isn’t one this server knows. Sign in with your password, then add it in Settings → Security.', 'invalid_passkey')
    if (user.disabledAt) throw forbidden('This account is disabled', 'account_disabled')
    return signIn(request, reply, db, user, 'passkey', body.device)
  })
}
