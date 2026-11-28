import {
  AccountSecurity, AppPassword, AuthResponse, AuthSessionList, Ok, RecoveryCodes, TwoFactorChallenge, TwoFactorSetup, UserSecurity,
} from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { authChallenges, authSessions, recoveryCodes, totpCredentials, users } from '../../database/schema.js'
import { body, errorCode } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { insertUser } from './service.js'
import { base32Decode, hotp, totpStep, TOTP_STEP_SECONDS } from './totp.js'

const password = 'correct horse'
const device = { id: 'device-2fa-0001', name: 'Test phone', kind: 'ios' as const }

describe('two-factor authentication and sessions', () => {
  useTestDatabase()
  let app: FastifyInstance
  // Only Date is faked, so codes can be made for a step and steps passed without waiting.
  let now = Date.UTC(2026, 10, 28, 12, 0, 0)
  beforeAll(async () => { app = await buildApp() })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
  })
  afterEach(() => { vi.useRealTimers() })
  /** Moves the clock to the next 30-second step, so the next code is new. */
  const nextStep = () => {
    now += TOTP_STEP_SECONDS * 1000
    vi.setSystemTime(now)
  }

  const call = (options: InjectOptions) => app.inject(options)
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  async function account(username: string) {
    const user = await insertUser(db, { username, password, role: 'member' })
    const login = body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } }), AuthResponse)
    return { user, headers: bearer(login.token) }
  }

  /** Turns two-factor on for an account; resolves to its secret and recovery codes. */
  async function enrol(headers: Record<string, string>) {
    const setup = body(await call({ method: 'POST', url: '/api/v1/auth/two-factor/setup', headers, payload: { currentPassword: password } }), TwoFactorSetup)
    const key = base32Decode(setup.secret)
    const code = () => hotp(key, totpStep())
    const { recoveryCodes: codes } = body(await call({ method: 'POST', url: '/api/v1/auth/two-factor/enable', headers, payload: { code: code() } }), RecoveryCodes)
    nextStep()
    return { setup, code, codes }
  }

  async function challenge(username: string): Promise<string> {
    const response = await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })
    expect(errorCode(response, 401)).toBe('two_factor_required')
    return TwoFactorChallenge.parse(response.json().error.details).challenge
  }

  const finish = (payload: Record<string, unknown>) => call({ method: 'POST', url: '/api/v1/auth/login/two-factor', payload })

  it('enrols with a QR code and a confirming code, then asks for a code after the password', async () => {
    const { user, headers } = await account('ada')
    expect(body(await call({ url: '/api/v1/auth/security', headers }), AccountSecurity))
      .toEqual({ hasPassword: true, twoFactor: { enabled: false, enabledAt: null, recoveryCodesRemaining: 0 }, passkeys: [] })

    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/two-factor/setup', headers, payload: { currentPassword: 'wrong' } }), 403)).toBe('invalid_credentials')
    const setup = body(await call({ method: 'POST', url: '/api/v1/auth/two-factor/setup', headers, payload: { currentPassword: password } }), TwoFactorSetup)
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(setup.otpauthUrl).toBe(`otpauth://totp/Squirmy:ada?secret=${setup.secret}&issuer=Squirmy&algorithm=SHA1&digits=6&period=30`)
    expect(setup.qrCode).toMatch(/^data:image\/svg\+xml;base64,/)
    // Stored encrypted, and not on until confirmed.
    const [stored] = await db.select().from(totpCredentials).where(eq(totpCredentials.userId, user.id))
    expect(stored?.secretEncrypted).not.toContain(setup.secret)
    expect(stored?.confirmedAt).toBeNull()
    body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ada', password } }), AuthResponse)

    const key = base32Decode(setup.secret)
    const wrong = hotp(key, totpStep() + 5)
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/two-factor/enable', headers, payload: { code: wrong } }), 403)).toBe('invalid_code')
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/two-factor/enable', headers, payload: { code: '12' } }), 400)).toBe('invalid_request')
    const enabled = body(await call({ method: 'POST', url: '/api/v1/auth/two-factor/enable', headers, payload: { code: hotp(key, totpStep()) } }), RecoveryCodes)
    expect(enabled.recoveryCodes).toHaveLength(10)
    expect(new Set(enabled.recoveryCodes).size).toBe(10)
    for (const code of enabled.recoveryCodes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/)
    // Only keyed hashes are kept.
    const hashes = await db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, user.id))
    expect(JSON.stringify(hashes)).not.toContain(enabled.recoveryCodes[0]!.replace('-', ''))
    expect(body(await call({ url: '/api/v1/auth/security', headers }), AccountSecurity).twoFactor).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 })
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/two-factor/setup', headers, payload: { currentPassword: password } }), 409)).toBe('two_factor_enabled')

    // The right password alone opens no session.
    const before = (await db.select().from(authSessions).where(eq(authSessions.userId, user.id))).length
    const token = await challenge('ada')
    expect((await db.select().from(authSessions).where(eq(authSessions.userId, user.id))).length).toBe(before)

    // The code the enrolment used cannot sign in.
    expect(errorCode(await finish({ challenge: token, code: hotp(key, totpStep()) }), 401)).toBe('invalid_code')
    expect(errorCode(await finish({ challenge: token, code: hotp(key, totpStep() - 1) }), 401)).toBe('invalid_code')
    nextStep()
    const signedIn = body(await finish({ challenge: token, code: hotp(key, totpStep()), device }), AuthResponse)
    expect(signedIn.user.username).toBe('ada')
    const sessions = body(await call({ url: '/api/v1/auth/sessions', headers: bearer(signedIn.token) }), AuthSessionList)
    expect(sessions.items.find((session) => session.current)).toMatchObject({ method: 'two_factor', clientKind: 'ios', deviceName: 'Test phone' })

    // The challenge is used up, and the code cannot be used again with a new one.
    expect(errorCode(await finish({ challenge: token, code: hotp(key, totpStep()) }), 401)).toBe('invalid_challenge')
    expect(errorCode(await finish({ challenge: await challenge('ada'), code: hotp(key, totpStep()) }), 401)).toBe('invalid_code')
  })

  it('takes each recovery code once, written any way', async () => {
    const { headers } = await account('grace')
    const { codes } = await enrol(headers)
    const first = codes[0]!
    const signedIn = body(await finish({ challenge: await challenge('grace'), code: ` ${first.toUpperCase().replace('-', ' ')} ` }), AuthResponse)
    const sessions = body(await call({ url: '/api/v1/auth/sessions', headers: bearer(signedIn.token) }), AuthSessionList)
    expect(sessions.items.find((session) => session.current)?.method).toBe('recovery_code')
    expect(errorCode(await finish({ challenge: await challenge('grace'), code: first }), 401)).toBe('invalid_code')
    expect(body(await call({ url: '/api/v1/auth/security', headers }), AccountSecurity).twoFactor.recoveryCodesRemaining).toBe(9)
  })

  it('drops a challenge after five wrong codes, and when it expires', async () => {
    const { headers } = await account('linus')
    const { code } = await enrol(headers)
    const token = await challenge('linus')
    for (let attempt = 0; attempt < 5; attempt += 1) expect(errorCode(await finish({ challenge: token, code: '000000' }), 401)).toBe('invalid_code')
    expect(errorCode(await finish({ challenge: token, code: code() }), 401)).toBe('invalid_challenge')

    const later = await challenge('linus')
    now += 6 * 60 * 1000
    vi.setSystemTime(now)
    expect(errorCode(await finish({ challenge: later, code: code() }), 401)).toBe('invalid_challenge')
    expect(errorCode(await finish({ challenge: 'made-up', code: code() }), 401)).toBe('invalid_challenge')
  })

  it('limits wrong codes per account across challenges', async () => {
    const { headers } = await account('barbara')
    const { code } = await enrol(headers)
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(errorCode(await finish({ challenge: await challenge('barbara'), code: '000000' }), 401)).toBe('invalid_code')
    }
    const blocked = await finish({ challenge: await challenge('barbara'), code: code() })
    expect(errorCode(blocked, 429)).toBe('rate_limited')
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('keeps app passwords working without a code: they are separate credentials', async () => {
    const { headers } = await account('ken')
    await enrol(headers)
    const created = body(await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers, payload: { name: 'Car', currentPassword: password } }), AppPassword, 201)
    const ping = await call({ url: `/rest/ping.view?u=ken&p=${encodeURIComponent(created.secret!)}&v=1.16.1&c=test&f=json` })
    expect(ping.json()['subsonic-response'].status).toBe('ok')
  })

  it('turns off with the password and a current code, and makes new recovery codes the same way', async () => {
    const { headers } = await account('margaret')
    const { code, codes } = await enrol(headers)
    const confirm = (url: string, payload: Record<string, unknown>) => call({ method: 'POST', url, headers, payload })

    expect(errorCode(await confirm('/api/v1/auth/two-factor/recovery-codes', { currentPassword: 'wrong', code: code() }), 403)).toBe('invalid_credentials')
    expect(errorCode(await confirm('/api/v1/auth/two-factor/recovery-codes', { currentPassword: password, code: '000000' }), 403)).toBe('invalid_code')
    const renewed = body(await confirm('/api/v1/auth/two-factor/recovery-codes', { currentPassword: password, code: codes[1]! }), RecoveryCodes)
    expect(renewed.recoveryCodes).toHaveLength(10)
    // The old set is gone.
    expect(errorCode(await finish({ challenge: await challenge('margaret'), code: codes[2]! }), 401)).toBe('invalid_code')

    expect(errorCode(await confirm('/api/v1/auth/two-factor/disable', { currentPassword: password, code: '000000' }), 403)).toBe('invalid_code')
    body(await confirm('/api/v1/auth/two-factor/disable', { currentPassword: password, code: code() }), Ok)
    expect(body(await call({ url: '/api/v1/auth/security', headers }), AccountSecurity).twoFactor).toEqual({ enabled: false, enabledAt: null, recoveryCodesRemaining: 0 })
    body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'margaret', password } }), AuthResponse)
    expect(errorCode(await confirm('/api/v1/auth/two-factor/disable', { currentPassword: password, code: code() }), 409)).toBe('two_factor_disabled')
  })

  it('forgets unfinished sign-ins when the password changes', async () => {
    const { user, headers } = await account('edsger')
    const { code } = await enrol(headers)
    const token = await challenge('edsger')
    body(await call({ method: 'POST', url: '/api/v1/auth/password', headers, payload: { currentPassword: password, newPassword: 'battery staple', keepAppPasswords: true } }), Ok)
    expect(await db.select().from(authChallenges).where(eq(authChallenges.userId, user.id))).toEqual([])
    expect(errorCode(await finish({ challenge: token, code: code() }), 401)).toBe('invalid_challenge')
  })

  it('refuses a disabled account at the second step', async () => {
    const { user, headers } = await account('alan')
    const { code } = await enrol(headers)
    const token = await challenge('alan')
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id))
    expect(errorCode(await finish({ challenge: token, code: code() }), 403)).toBe('account_disabled')
  })

  it('lists sessions and signs out one, or all the others', async () => {
    const { headers } = await account('donald')
    const login = async () => body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'donald', password, device } }), AuthResponse).token
    const phone = await login()
    const laptop = body(await call({
      method: 'POST', url: '/api/v1/auth/login', headers: { 'x-squirmy-client': 'web', 'user-agent': 'Firefox/140' }, payload: { username: 'donald', password },
    }), AuthResponse).token

    const list = body(await call({ url: '/api/v1/auth/sessions', headers }), AuthSessionList).items
    expect(list).toHaveLength(3)
    expect(list.filter((session) => session.current)).toHaveLength(1)
    expect(list).toContainEqual(expect.objectContaining({ clientKind: 'ios', deviceName: 'Test phone', method: 'password', current: false }))
    expect(list).toContainEqual(expect.objectContaining({ clientKind: 'web', userAgent: 'Firefox/140', deviceName: null }))

    const phoneId = body(await call({ url: '/api/v1/auth/sessions', headers: bearer(phone) }), AuthSessionList).items.find((session) => session.current)!.id
    body(await call({ method: 'DELETE', url: `/api/v1/auth/sessions/${phoneId}`, headers }), Ok)
    expect((await call({ url: '/api/v1/auth/me', headers: bearer(phone) })).statusCode).toBe(401)
    expect(errorCode(await call({ method: 'DELETE', url: `/api/v1/auth/sessions/${phoneId}`, headers }), 404)).toBe('not_found')

    // Someone else's session is not found, rather than ended.
    const other = await account('someone')
    const otherId = body(await call({ url: '/api/v1/auth/sessions', headers: other.headers }), AuthSessionList).items[0]!.id
    expect(errorCode(await call({ method: 'DELETE', url: `/api/v1/auth/sessions/${otherId}`, headers }), 404)).toBe('not_found')
    expect((await call({ url: '/api/v1/auth/me', headers: other.headers })).statusCode).toBe(200)

    body(await call({ method: 'POST', url: '/api/v1/auth/sessions/revoke-others', headers }), Ok)
    expect((await call({ url: '/api/v1/auth/me', headers: bearer(laptop) })).statusCode).toBe(401)
    expect(body(await call({ url: '/api/v1/auth/sessions', headers }), AuthSessionList).items).toHaveLength(1)

    // Ending your own session signs you out.
    const own = body(await call({ url: '/api/v1/auth/sessions', headers }), AuthSessionList).items[0]!.id
    body(await call({ method: 'DELETE', url: `/api/v1/auth/sessions/${own}`, headers }), Ok)
    expect((await call({ url: '/api/v1/auth/me', headers })).statusCode).toBe(401)
  })

  it('lets admins see and end a user’s sessions and turn off their second factor', async () => {
    await insertUser(db, { username: 'root', password, role: 'admin' })
    const admin = bearer(body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'root', password } }), AuthResponse).token)
    const { user, headers } = await account('niklaus')
    const { code } = await enrol(headers)

    const security = body(await call({ url: `/api/v1/admin/users/${user.id}/security`, headers: admin }), UserSecurity)
    expect(security.twoFactorEnabled).toBe(true)
    expect(security.sessions).toHaveLength(1)
    expect(security.sessions[0]?.current).toBe(false)
    expect((await call({ url: `/api/v1/admin/users/${user.id}/security`, headers })).statusCode).toBe(403)

    body(await call({ method: 'DELETE', url: `/api/v1/admin/users/${user.id}/sessions/${security.sessions[0]!.id}`, headers: admin }), Ok)
    expect((await call({ url: '/api/v1/auth/me', headers })).statusCode).toBe(401)

    const again = bearer(body(await finish({ challenge: await challenge('niklaus'), code: code() }), AuthResponse).token)
    body(await call({ method: 'DELETE', url: `/api/v1/admin/users/${user.id}/sessions`, headers: admin }), Ok)
    expect((await call({ url: '/api/v1/auth/me', headers: again })).statusCode).toBe(401)

    body(await call({ method: 'DELETE', url: `/api/v1/admin/users/${user.id}/two-factor`, headers: admin }), Ok)
    body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'niklaus', password } }), AuthResponse)

    // Not their own: that takes their password and a code, in their settings.
    const [root] = await db.select().from(users).where(eq(users.usernameKey, 'root'))
    expect(errorCode(await call({ method: 'DELETE', url: `/api/v1/admin/users/${root!.id}/two-factor`, headers: admin }), 403)).toBe('own_two_factor')
    // Signing yourself out everywhere keeps the session you are using.
    body(await call({ method: 'DELETE', url: `/api/v1/admin/users/${root!.id}/sessions`, headers: admin }), Ok)
    expect((await call({ url: '/api/v1/auth/me', headers: admin })).statusCode).toBe(200)
    expect(errorCode(await call({ url: `/api/v1/admin/users/00000000-0000-7000-8000-000000000000/security`, headers: admin }), 404)).toBe('not_found')
  })
})
