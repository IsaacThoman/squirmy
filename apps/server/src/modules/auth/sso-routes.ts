import { createHash } from 'node:crypto'
import { Id, LinkSsoRequest, SsoExchangeRequest, type AuthResponse, type Ok, type SsoLinkStart } from '@squirmy/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { users } from '../../database/schema.js'
import { requireUser } from '../../lib/auth.js'
import { hashToken, randomToken } from '../../lib/crypto.js'
import { badRequest, forbidden, notFound, unauthorized } from '../../lib/errors.js'
import { addressKey } from '../../lib/proxy.js'
import { consumeChallenge, createChallenge } from './challenges.js'
import { reauthenticate } from './reauth.js'
import { isHttps, limiter, setSessionCookie, signIn } from './routes.js'
import { createSession, insertSsoUser } from './service.js'
import {
  authorizationUrl, findSsoUser, findUserByEmail, finishSso, inAllowedGroups, linkSsoIdentity, newSsoSecrets, ssoProvider,
  unlinkSsoIdentity, usernameFromClaims, usernameTaken, verifiedEmail, type SsoProvider,
} from './sso.js'

/** Ties a round trip to the browser that started it, so a stolen callback link signs no one else in. */
const BROWSER_COOKIE = 'squirmy_sso'
const cookiePath = '/api/v1/auth/sso'
const roundTripMs = 10 * 60 * 1000
const exchangeMs = 2 * 60 * 1000
/** Where the iOS app asks to be sent back: its own scheme, and nothing else. */
const appRedirect = /^squirmy(-dev)?:\/\/auth\/sso$/

const StartQuery = z.object({
  next: z.string().max(2000).optional(),
  client: z.enum(['web', 'native']).default('web'),
  redirect: z.string().max(200).optional(),
  /** base64url SHA-256 of a verifier the app sends to `/auth/sso/exchange`. */
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
})

const CallbackQuery = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(4000).optional(),
  error: z.string().max(200).optional(),
})

type RoundTrip = {
  verifier: string
  nonce: string
  browser: string
  intent: 'login' | 'link'
  next: string
  client: 'web' | 'native'
  redirect?: string
  appChallenge?: string
}

/** A path in this app to land on, never another origin. */
function safePath(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  return next
}

export async function ssoRoutes(app: FastifyInstance) {
  const startPerIp = limiter(app, 'sso-start-ip', 30, (request) => addressKey(request.ip))
  const exchangePerIp = limiter(app, 'sso-exchange-ip', 20, (request) => addressKey(request.ip))

  /** Starts a round trip: keeps its secrets, ties it to this browser, and answers the provider's address. */
  async function begin(request: FastifyRequest, reply: FastifyReply, provider: SsoProvider, trip: Omit<RoundTrip, 'verifier' | 'nonce' | 'browser'>, userId?: string) {
    const { verifier, nonce } = newSsoSecrets()
    const browser = randomToken()
    const { token: state } = await createChallenge({
      kind: 'sso',
      userId: userId ?? null,
      data: { ...trip, verifier, nonce, browser: hashToken(browser) } satisfies RoundTrip,
      ttlMs: roundTripMs,
    })
    reply.setCookie(BROWSER_COOKIE, browser, { path: cookiePath, httpOnly: true, sameSite: 'lax', secure: isHttps(request), maxAge: roundTripMs / 1000 })
    return authorizationUrl(provider, { state, nonce, verifier })
  }

  app.get('/auth/sso/start', { preHandler: startPerIp }, async (request, reply) => {
    const query = StartQuery.parse(request.query)
    if (query.client === 'native' && !appRedirect.test(query.redirect ?? '')) throw badRequest('Not an address this server sends sign-ins back to', 'invalid_redirect')
    const provider = await ssoProvider()
    if (!provider) {
      return reply.redirect(query.client === 'native' ? `${query.redirect}?error=sso_unavailable` : '/login?sso_error=sso_unavailable')
    }
    const url = await begin(request, reply, provider, {
      intent: 'login',
      next: safePath(query.next),
      client: query.client,
      redirect: query.client === 'native' ? query.redirect : undefined,
      appChallenge: query.challenge,
    })
    return reply.redirect(url)
  })

  /** Links the provider account to the signed-in user. A JSON call, so the CSRF header guards it. */
  app.post('/auth/sso/link', { preHandler: startPerIp }, async (request, reply): Promise<SsoLinkStart> => {
    const user = requireUser(request)
    const body = LinkSsoRequest.parse(request.body ?? {})
    // A linked identity signs in on its own, like a passkey.
    await reauthenticate(request, body.currentPassword)
    const provider = await ssoProvider()
    if (!provider) throw notFound('Single sign-on is not set up on this server')
    return { url: await begin(request, reply, provider, { intent: 'link', next: '/settings/security', client: 'web' }, user.id) }
  })

  app.get('/auth/sso/callback', async (request, reply) => {
    const query = CallbackQuery.parse(request.query)
    const browser = request.cookies[BROWSER_COOKIE]
    reply.clearCookie(BROWSER_COOKIE, { path: cookiePath })
    const challenge = query.state ? await consumeChallenge('sso', query.state) : null
    const trip = challenge?.data as RoundTrip | undefined
    if (!challenge || !trip) return reply.redirect('/login?sso_error=sso_expired')
    const fail = (code: string) => reply.redirect(
      trip.client === 'native' ? `${trip.redirect}?error=${code}`
        : trip.intent === 'link' ? `/settings/security?sso_error=${code}`
          : `/login?sso_error=${code}`,
    )
    // The app's sign-in sheet keeps its own cookies; a browser other than the one that started is refused.
    if (!browser || hashToken(browser) !== trip.browser) return fail('sso_expired')
    if (query.error) return fail(query.error === 'access_denied' ? 'sso_denied' : 'sso_failed')
    const provider = await ssoProvider()
    if (!provider) return fail('sso_unavailable')

    let identity
    try {
      const callback = new URL(provider.callbackUrl)
      callback.search = new URL(request.url, 'http://callback').search
      identity = await finishSso(provider, callback, { state: query.state!, nonce: trip.nonce, verifier: trip.verifier })
    } catch (error) {
      request.log.warn({ err: error }, 'Single sign-on failed')
      return fail('sso_failed')
    }
    if (!inAllowedGroups(provider, identity.claims)) return fail('sso_not_allowed')

    if (trip.intent === 'link') {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, challenge.userId ?? ''))
      if (!user) return fail('sso_expired')
      if (!await linkSsoIdentity(user.id, identity)) return fail('sso_linked_elsewhere')
      return reply.redirect('/settings/security?sso=linked')
    }

    let user = await findSsoUser(identity.issuer, identity.subject)
    if (!user) {
      // An account an admin gave this verified email address is the same person.
      const email = verifiedEmail(identity.claims)
      const owner = email ? await findUserByEmail(email) : null
      if (owner) {
        if (!await linkSsoIdentity(owner.id, identity)) return fail('sso_linked_elsewhere')
        user = owner
      } else {
        if (!provider.autoCreateUsers) return fail('sso_no_account')
        const username = usernameFromClaims(identity.claims, provider.usernameClaim)
        if (!username) return fail('sso_username_invalid')
        if (await usernameTaken(username)) return fail('sso_username_taken')
        const displayName = typeof identity.claims.name === 'string' ? identity.claims.name.slice(0, 80) : null
        user = await insertSsoUser({ username, displayName, email, identity })
      }
    }
    if (user.disabledAt) return fail('account_disabled')

    if (trip.client === 'native') {
      const { token } = await createChallenge({ kind: 'sso_exchange', userId: user.id, data: { appChallenge: trip.appChallenge ?? null }, ttlMs: exchangeMs })
      return reply.redirect(`${trip.redirect}?code=${encodeURIComponent(token)}`)
    }
    const { token } = await createSession(db, { userId: user.id, clientKind: 'web', userAgent: request.headers['user-agent'], method: 'sso' })
    setSessionCookie(request, reply, token)
    return reply.redirect(trip.next)
  })

  /** The app trades the one-time code from its redirect for a session. */
  app.post('/auth/sso/exchange', { preHandler: exchangePerIp }, async (request, reply): Promise<AuthResponse> => {
    const body = SsoExchangeRequest.parse(request.body)
    const challenge = await consumeChallenge('sso_exchange', body.code)
    if (!challenge?.userId) throw unauthorized('That sign-in has expired. Try again.', 'invalid_challenge')
    const expected = challenge.data.appChallenge
    if (typeof expected === 'string') {
      const given = body.verifier ? createHash('sha256').update(body.verifier).digest('base64url') : null
      if (given !== expected) throw unauthorized('That sign-in has expired. Try again.', 'invalid_challenge')
    }
    const [user] = await db.select().from(users).where(eq(users.id, challenge.userId))
    if (!user) throw unauthorized('That sign-in has expired. Try again.', 'invalid_challenge')
    if (user.disabledAt) throw forbidden('This account is disabled', 'account_disabled')
    return signIn(request, reply, db, user, 'sso', body.device)
  })

  app.delete('/auth/sso/identities/:id', async (request): Promise<Ok> => {
    const user = requireUser(request)
    const { id } = z.object({ id: Id }).parse(request.params)
    if (!await unlinkSsoIdentity(user.id, id)) throw notFound('No such link')
    return { ok: true }
  })

}
