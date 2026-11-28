import { createHash } from 'node:crypto'
import { AccountSecurity, AppPassword, AuthResponse, AuthSessionList, Ok, ServerSettings, SetupStatus, SsoLinkStart, User, type UpdateServerSettings } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { resetConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { ssoIdentities, users } from '../../database/schema.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, errorCode } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { FakeOidcProvider, type FakeClaims } from '../../test/oidc-provider.js'
import { insertUser } from './service.js'
import { claimGroups, forgetSsoDiscovery, usernameFromClaims } from './sso.js'

const origin = 'https://music.example.com'
const password = 'correct horse'

describe('single sign-on', () => {
  useTestDatabase()
  let app: FastifyInstance
  const provider = new FakeOidcProvider()
  let address = 0

  beforeAll(async () => {
    process.env.PUBLIC_URL = origin
    resetConfig()
    await provider.start()
    app = await buildApp()
  })
  afterAll(async () => {
    await app.close()
    await provider.stop()
    delete process.env.PUBLIC_URL
    delete process.env.SQUIRMY_ADMIN_PASSWORD_LOGIN
    resetConfig()
  })

  const settings = (patch: UpdateServerSettings = {}) => updateServerSettings({
    ssoEnabled: true,
    ssoName: 'Authelia',
    ssoIssuerUrl: provider.issuer,
    ssoClientId: provider.clientId,
    ssoClientSecret: provider.clientSecret,
    ssoAutoCreateUsers: false,
    ssoAllowedGroups: '',
    passwordLoginDisabled: false,
    ...patch,
  })
  beforeEach(async () => {
    provider.tamper = null
    forgetSsoDiscovery()
    await settings()
  })

  // As a browser reaches it through the https proxy in front: the public host name.
  const call = (options: InjectOptions) => app.inject({
    remoteAddress: `10.1.${Math.floor(++address / 250)}.${address % 250 + 1}`,
    ...options,
    headers: { host: 'music.example.com', ...options.headers },
  })
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const location = (response: LightMyRequestResponse) => {
    expect(response.statusCode, response.body).toBe(302)
    return String(response.headers.location)
  }

  /** The round trip as a browser makes it: start, the provider's approval, then the callback with the cookie. */
  async function roundTrip(claims: FakeClaims, query = '') {
    const start = await call({ url: `/api/v1/auth/sso/start${query}` })
    const cookie = start.cookies.find((entry) => entry.name === 'squirmy_sso')!
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/v1/auth/sso', secure: true })
    const back = provider.approve(location(start), claims)
    expect(`${back.origin}${back.pathname}`).toBe(`${origin}/api/v1/auth/sso/callback`)
    const callback = await call({ url: `${back.pathname}${back.search}`, headers: { cookie: `squirmy_sso=${cookie.value}` } })
    return { start, back, cookie: `squirmy_sso=${cookie.value}`, callback, to: location(callback) }
  }

  const sessionCookie = (response: LightMyRequestResponse) => response.cookies.find((entry) => entry.name === 'squirmy_session')

  it('reads usernames and groups from claims', () => {
    expect(usernameFromClaims({ preferred_username: 'ada.lovelace' }, 'preferred_username')).toBe('ada.lovelace')
    expect(usernameFromClaims({ email: 'Grace Hopper@navy.mil' }, 'email')).toBe('Grace-Hopper')
    expect(usernameFromClaims({ preferred_username: '!' }, 'preferred_username')).toBeNull()
    expect(usernameFromClaims({}, 'preferred_username')).toBeNull()
    expect(claimGroups({ groups: ['music', 1] }, 'groups')).toEqual(['music'])
    expect(claimGroups({ realm_access: { roles: ['music'] } }, 'realm_access.roles')).toEqual(['music'])
    expect(claimGroups({ groups: 'a, b c' }, 'groups')).toEqual(['a', 'b', 'c'])
  })

  it('tells clients the provider name before anyone signs in', async () => {
    expect(body(await call({ url: '/api/v1/setup/status' }), SetupStatus)).toMatchObject({ ssoName: 'Authelia', passwordLoginEnabled: true })
    await settings({ ssoEnabled: false })
    expect(body(await call({ url: '/api/v1/setup/status' }), SetupStatus).ssoName).toBeNull()
    expect(location(await call({ url: '/api/v1/auth/sso/start' }))).toBe('/login?sso_error=sso_unavailable')
  })

  it('creates an account when allowed, with the code flow, PKCE, state and nonce', async () => {
    await settings({ ssoAutoCreateUsers: true })
    const first = await roundTrip({ sub: 'u-ada', preferred_username: 'ada', name: 'Ada Lovelace', email: 'ada@example.com', email_verified: true }, '?next=/album/x')
    const authorize = new URL(location(first.start))
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ client_id: 'squirmy', response_type: 'code', scope: 'openid profile email', code_challenge_method: 'S256' })
    expect(authorize.searchParams.get('state')).toBeTruthy()
    expect(authorize.searchParams.get('nonce')).toBeTruthy()
    expect(first.to).toBe('/album/x')
    const token = sessionCookie(first.callback)!
    expect(token).toMatchObject({ httpOnly: true, secure: true })
    const me = body(await call({ url: '/api/v1/auth/me', headers: bearer(token.value) }), User)
    expect(me).toMatchObject({ username: 'ada', displayName: 'Ada Lovelace', email: 'ada@example.com' })
    const sessions = body(await call({ url: '/api/v1/auth/sessions', headers: bearer(token.value) }), AuthSessionList)
    expect(sessions.items[0]?.method).toBe('sso')
    // No password: the account signs in only through the provider.
    expect(body(await call({ url: '/api/v1/auth/security', headers: bearer(token.value) }), AccountSecurity)).toMatchObject({ hasPassword: false, ssoIdentities: [expect.objectContaining({ email: 'ada@example.com' })] })

    // The same person again is the same account.
    const again = await roundTrip({ sub: 'u-ada', preferred_username: 'renamed' })
    expect(body(await call({ url: '/api/v1/auth/me', headers: bearer(sessionCookie(again.callback)!.value) }), User).id).toBe(me.id)
  })

  it('refuses someone without an account unless creating them is on, and a taken username', async () => {
    expect((await roundTrip({ sub: 'u-nobody', preferred_username: 'nobody' })).to).toBe('/login?sso_error=sso_no_account')
    await settings({ ssoAutoCreateUsers: true })
    await insertUser(db, { username: 'taken', password, role: 'member' })
    expect((await roundTrip({ sub: 'u-taken', preferred_username: 'TAKEN' })).to).toBe('/login?sso_error=sso_username_taken')
    expect((await roundTrip({ sub: 'u-bad', preferred_username: '@@' })).to).toBe('/login?sso_error=sso_username_invalid')
  })

  it('links an existing account by an email the provider verified', async () => {
    const user = await insertUser(db, { username: 'grace', password, role: 'member', email: 'grace@example.com' })
    expect((await roundTrip({ sub: 'u-grace-unverified', email: 'GRACE@example.com', email_verified: false })).to).toBe('/login?sso_error=sso_no_account')
    const linked = await roundTrip({ sub: 'u-grace', email: 'GRACE@example.com', email_verified: true })
    expect(linked.to).toBe('/')
    expect(body(await call({ url: '/api/v1/auth/me', headers: bearer(sessionCookie(linked.callback)!.value) }), User).id).toBe(user.id)
    expect(await db.select().from(ssoIdentities).where(eq(ssoIdentities.userId, user.id))).toHaveLength(1)
  })

  it('lets admins set emails, one account each', async () => {
    await insertUser(db, { username: 'barbara', password, role: 'admin' })
    const headers = bearer(body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'barbara', password } }), AuthResponse).token)
    const made = body(await call({ method: 'POST', url: '/api/v1/admin/users', headers, payload: { username: 'edsger', password, email: 'Edsger@example.com' } }), User, 201)
    expect(made.email).toBe('Edsger@example.com')
    const other = body(await call({ method: 'POST', url: '/api/v1/admin/users', headers, payload: { username: 'tony', password } }), User, 201)
    expect(errorCode(await call({ method: 'PATCH', url: `/api/v1/admin/users/${other.id}`, headers, payload: { email: 'edsger@EXAMPLE.com' } }), 409)).toBe('email_taken')
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/admin/users', headers, payload: { username: 'tony2', password, email: 'EDSGER@example.com' } }), 409)).toBe('email_taken')
    expect(body(await call({ method: 'PATCH', url: `/api/v1/admin/users/${other.id}`, headers, payload: { email: 'tony@example.com' } }), User).email).toBe('tony@example.com')
    expect(body(await call({ method: 'PATCH', url: `/api/v1/admin/users/${made.id}`, headers, payload: { email: null } }), User).email).toBeNull()
    expect(errorCode(await call({ method: 'PATCH', url: `/api/v1/admin/users/${made.id}`, headers, payload: { email: 'not an email' } }), 400)).toBe('invalid_request')
  })

  it('requires an allowed group, from the ID token or userinfo', async () => {
    await settings({ ssoAutoCreateUsers: true, ssoAllowedGroups: 'music, admins' })
    expect((await roundTrip({ sub: 'u-outsider', preferred_username: 'outsider', groups: ['other'] })).to).toBe('/login?sso_error=sso_not_allowed')
    provider.userinfo.set('u-member', { groups: ['music'] })
    expect((await roundTrip({ sub: 'u-member', preferred_username: 'member' })).to).toBe('/')
  })

  it('refuses a callback without the browser cookie, a reused state, a forged ID token and a cancelled sign-in', async () => {
    await settings({ ssoAutoCreateUsers: true })
    const start = await call({ url: '/api/v1/auth/sso/start' })
    const back = provider.approve(location(start), { sub: 'u-linus', preferred_username: 'linus' })
    // Another browser (a link sent to someone else) has no cookie for it.
    expect(location(await call({ url: `${back.pathname}${back.search}` }))).toBe('/login?sso_error=sso_expired')
    expect(location(await call({ url: `${back.pathname}${back.search}`, headers: { cookie: 'squirmy_sso=wrong' } }))).toBe('/login?sso_error=sso_expired')

    const done = await roundTrip({ sub: 'u-linus', preferred_username: 'linus' })
    expect(location(await call({ url: `${done.back.pathname}${done.back.search}`, headers: { cookie: done.cookie } }))).toBe('/login?sso_error=sso_expired')

    for (const tamper of [
      (claims: Record<string, unknown>) => { claims.nonce = 'other' },
      (claims: Record<string, unknown>) => { claims.aud = 'someone-else' },
      (claims: Record<string, unknown>) => { claims.iss = 'https://evil.example.com' },
      (claims: Record<string, unknown>) => { claims.exp = 1 },
    ]) {
      provider.tamper = tamper
      expect((await roundTrip({ sub: 'u-linus', preferred_username: 'linus' })).to).toBe('/login?sso_error=sso_failed')
    }
    provider.tamper = null

    const cancelled = await call({ url: '/api/v1/auth/sso/start' })
    const state = new URL(location(cancelled)).searchParams.get('state')!
    const cookie = cancelled.cookies.find((entry) => entry.name === 'squirmy_sso')!.value
    expect(location(await call({ url: `/api/v1/auth/sso/callback?error=access_denied&state=${state}`, headers: { cookie: `squirmy_sso=${cookie}` } }))).toBe('/login?sso_error=sso_denied')
  })

  it('refuses a wrong client secret', async () => {
    await settings({ ssoAutoCreateUsers: true, ssoClientSecret: 'not-the-secret' })
    expect((await roundTrip({ sub: 'u-secret', preferred_username: 'secret' })).to).toBe('/login?sso_error=sso_failed')
  })

  it('lands only on paths of this app', async () => {
    await settings({ ssoAutoCreateUsers: true })
    for (const next of ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com']) {
      expect((await roundTrip({ sub: 'u-next', preferred_username: 'next' }, `?next=${encodeURIComponent(next)}`)).to).toBe('/')
    }
  })

  it('refuses a disabled account', async () => {
    await settings({ ssoAutoCreateUsers: true })
    await roundTrip({ sub: 'u-off', preferred_username: 'off' })
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.usernameKey, 'off'))
    expect((await roundTrip({ sub: 'u-off', preferred_username: 'off' })).to).toBe('/login?sso_error=account_disabled')
  })

  it('hands the iOS app a one-time code for its own scheme only', async () => {
    await settings({ ssoAutoCreateUsers: true })
    expect(errorCode(await call({ url: '/api/v1/auth/sso/start?client=native&redirect=https://evil.example.com' }), 400)).toBe('invalid_redirect')
    expect(errorCode(await call({ url: '/api/v1/auth/sso/start?client=native&redirect=squirmy://elsewhere' }), 400)).toBe('invalid_redirect')

    const verifier = 'a-verifier-only-the-app-knows-0123456789abcdef'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const trip = await roundTrip({ sub: 'u-phone', preferred_username: 'phone' }, `?client=native&redirect=${encodeURIComponent('squirmy://auth/sso')}&challenge=${challenge}`)
    expect(sessionCookie(trip.callback)).toBeUndefined()
    const back = new URL(trip.to)
    expect(`${back.protocol}//${back.host}${back.pathname}`).toBe('squirmy://auth/sso')
    const code = back.searchParams.get('code')!
    const device = { id: 'iphone-0000001', name: 'Phone', kind: 'ios' }
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/sso/exchange', payload: { code, verifier: 'a-wrong-verifier-of-the-right-length-0123456789', device } }), 401)).toBe('invalid_challenge')
    // A failed exchange used the code up.
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/sso/exchange', payload: { code, verifier, device } }), 401)).toBe('invalid_challenge')

    const again = await roundTrip({ sub: 'u-phone' }, `?client=native&redirect=${encodeURIComponent('squirmy-dev://auth/sso')}&challenge=${challenge}`)
    const next = new URL(again.to).searchParams.get('code')!
    const signedIn = body(await call({ method: 'POST', url: '/api/v1/auth/sso/exchange', payload: { code: next, verifier, device } }), AuthResponse)
    expect(signedIn.user.username).toBe('phone')
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/sso/exchange', payload: { code: next, verifier, device } }), 401)).toBe('invalid_challenge')

    await settings({ ssoAutoCreateUsers: false })
    expect((await roundTrip({ sub: 'u-new-app', preferred_username: 'y' }, `?client=native&redirect=${encodeURIComponent('squirmy://auth/sso')}`)).to).toBe('squirmy://auth/sso?error=sso_no_account')
  })

  it('links the provider to a signed-in account from settings, after the password', async () => {
    await insertUser(db, { username: 'ken', password, role: 'member' })
    const login = body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ken', password } }), AuthResponse)
    const headers = { ...bearer(login.token) }
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/sso/link', headers, payload: {} }), 400)).toBe('current_password_required')
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/sso/link', headers, payload: { currentPassword: 'wrong' } }), 403)).toBe('invalid_credentials')
    const started = await call({ method: 'POST', url: '/api/v1/auth/sso/link', headers, payload: { currentPassword: password } })
    const { url } = body(started, SsoLinkStart)
    const cookie = started.cookies.find((entry) => entry.name === 'squirmy_sso')!.value
    const back = provider.approve(url, { sub: 'u-ken', email: 'ken@example.com' })
    expect(location(await call({ url: `${back.pathname}${back.search}`, headers: { cookie: `squirmy_sso=${cookie}` } }))).toBe('/settings/security?sso=linked')
    const security = body(await call({ url: '/api/v1/auth/security', headers }), AccountSecurity)
    expect(security.ssoIdentities).toEqual([expect.objectContaining({ issuer: provider.issuer, email: 'ken@example.com' })])

    // The same provider account cannot also be linked to someone else.
    await insertUser(db, { username: 'dennis', password, role: 'member' })
    const other = bearer(body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'dennis', password } }), AuthResponse).token)
    const second = await call({ method: 'POST', url: '/api/v1/auth/sso/link', headers: other, payload: { currentPassword: password } })
    const secondBack = provider.approve(body(second, SsoLinkStart).url, { sub: 'u-ken' })
    const secondCookie = second.cookies.find((entry) => entry.name === 'squirmy_sso')!.value
    expect(location(await call({ url: `${secondBack.pathname}${secondBack.search}`, headers: { cookie: `squirmy_sso=${secondCookie}` } }))).toBe('/settings/security?sso_error=sso_linked_elsewhere')

    body(await call({ method: 'DELETE', url: `/api/v1/auth/sso/identities/${security.ssoIdentities[0]!.id}`, headers }), Ok)
    expect(body(await call({ url: '/api/v1/auth/security', headers }), AccountSecurity).ssoIdentities).toEqual([])
  })

  it('keeps the only way into an account', async () => {
    await settings({ ssoAutoCreateUsers: true })
    const trip = await roundTrip({ sub: 'u-only', preferred_username: 'only' })
    const headers = bearer(sessionCookie(trip.callback)!.value)
    const [identity] = body(await call({ url: '/api/v1/auth/security', headers }), AccountSecurity).ssoIdentities
    expect(errorCode(await call({ method: 'DELETE', url: `/api/v1/auth/sso/identities/${identity!.id}`, headers }), 409)).toBe('last_sign_in_method')
    // Without a password, a fresh sign-in stands in for one, and changing a password it does not have is refused.
    body(await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers, payload: { name: 'Car' } }), AppPassword, 201)
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/password', headers, payload: { currentPassword: 'x', newPassword: 'a new password' } }), 403)).toBe('no_password')
    // And a password login with no password cannot succeed.
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'only', password: 'anything' } }), 401)).toBe('invalid_credentials')
  })

  it('turns password sign-in off only with single sign-on working for the admin, with a recovery switch', async () => {
    await insertUser(db, { username: 'margaret', password, role: 'admin' })
    await insertUser(db, { username: 'listener', password, role: 'member' })
    const headers = bearer(body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'margaret', password } }), AuthResponse).token)
    // Not before this admin can sign in with the provider.
    expect(errorCode(await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers, payload: { passwordLoginDisabled: true } }), 409)).toBe('sso_required')
    const started = await call({ method: 'POST', url: '/api/v1/auth/sso/link', headers, payload: { currentPassword: password } })
    const back = provider.approve(body(started, SsoLinkStart).url, { sub: 'u-margaret' })
    location(await call({ url: `${back.pathname}${back.search}`, headers: { cookie: `squirmy_sso=${started.cookies.find((entry) => entry.name === 'squirmy_sso')!.value}` } }))
    body(await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers, payload: { passwordLoginDisabled: true } }), ServerSettings)
    expect(body(await call({ url: '/api/v1/setup/status' }), SetupStatus).passwordLoginEnabled).toBe(false)

    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'listener', password } }), 403)).toBe('password_login_disabled')
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'margaret', password } }), 403)).toBe('password_login_disabled')
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'newbie', password, inviteCode: 'x' } }), 403)).toBe('password_login_disabled')
    // Single sign-on cannot be switched off from under it.
    expect(errorCode(await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers, payload: { ssoEnabled: false } }), 409)).toBe('sso_required')

    // The recovery switch lets admins, and only admins, use their password.
    process.env.SQUIRMY_ADMIN_PASSWORD_LOGIN = 'true'
    resetConfig()
    try {
      body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'margaret', password } }), AuthResponse)
      expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'listener', password } }), 403)).toBe('password_login_disabled')
    } finally {
      delete process.env.SQUIRMY_ADMIN_PASSWORD_LOGIN
      resetConfig()
    }
    await updateServerSettings({ passwordLoginDisabled: false })
  })
})
