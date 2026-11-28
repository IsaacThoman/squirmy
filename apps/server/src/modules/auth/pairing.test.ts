import { AuthResponse, AuthSessionList, Ok, TwoFactorChallenge, TwoFactorSetup, TvPairing, TvPairingPoll, TvPairingPreview } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { resetConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { tvPairings } from '../../database/schema.js'
import { body, errorCode } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAppPassword, createSession, insertSsoUser, insertUser } from './service.js'
import { base32Decode, hotp, totpStep } from './totp.js'

const device = { id: 'living-room-tv', name: 'Living Room Apple TV', kind: 'tv' }
const ip = '192.168.1.20'
const password = 'correct horse'
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe('Apple TV pairing', () => {
  useTestDatabase()
  let app: FastifyInstance
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    app = await buildApp()
  })
  afterEach(async () => {
    await app.close()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    resetConfig()
  })

  function pair(action: string, payload: object, headers?: Record<string, string>, remoteAddress = ip) {
    return app.inject({ method: 'POST', url: `/api/v1/auth/tv-pairing/${action}`, payload, headers, remoteAddress })
  }
  const start = async () => body(await pair('start', { device }, { host: 'squirmy.local:4747' }), TvPairing)
  const advance = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000)
  const addUser = (username: string) => insertUser(db, { username, password, role: 'member' })
  const login = (username: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })

  it('issues a local QR, enforces polling backoff and creates exactly one auditable session after approval', async () => {
    const user = await addUser('ada')
    const auth = bearer(body(await login('ada'), AuthResponse).token)
    const issued = await start()
    expect(issued.verificationUrl).toBe(`http://squirmy.local:4747/pair?code=${issued.userCode}`)
    expect(issued.qrCode).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(JSON.stringify(await db.select().from(tvPairings))).not.toContain(issued.deviceCode)
    expect(JSON.stringify(await db.select().from(tvPairings))).not.toContain(issued.userCode.replace('-', ''))
    const poll = () => pair('poll', { deviceCode: issued.deviceCode })
    const early = await poll()
    expect(early.headers['cache-control']).toBe('no-store')
    expect(body(early, TvPairingPoll)).toEqual({ status: 'slow_down', intervalSeconds: 10 })
    advance(10)
    expect(body(await poll(), TvPairingPoll)).toEqual({ status: 'pending', intervalSeconds: 10 })

    const lookup = { code: issued.userCode.toLowerCase() }
    expect(errorCode(await pair('lookup', lookup), 401)).toBe('unauthorized')
    const preview = body(await pair('lookup', lookup, auth), TvPairingPreview)
    expect(preview).toMatchObject({ deviceName: device.name, ipAddress: ip })
    const approval = { ...lookup, id: preview.id }
    expect(errorCode(await pair('approve', approval), 401)).toBe('unauthorized')
    const cookie = { cookie: `squirmy_session=${body(await login('ada'), AuthResponse).token}` }
    expect(errorCode(await pair('approve', approval, cookie), 403)).toBe('csrf')
    const approvals = await Promise.all([pair('approve', approval, auth), pair('approve', approval, auth)])
    expect(approvals.map(response => response.statusCode).sort()).toEqual([200, 404])
    expect(errorCode(await pair('lookup', lookup, auth), 404)).toBe('pairing_unavailable')

    advance(10)
    const responses = await Promise.all([poll(), poll()])
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 404])
    const result = body(responses.find(response => response.statusCode === 200)!, TvPairingPoll)
    expect(result.status).toBe('approved')
    if (result.status !== 'approved') throw new Error('TV did not receive a session')
    expect(result.session.user.id).toBe(user.id)
    const sessions = body(await app.inject({ url: '/api/v1/auth/sessions', headers: bearer(result.session.token) }), AuthSessionList)
    expect(sessions.items.filter(session => session.method === 'tv_pairing')).toMatchObject([
      { current: true, deviceName: device.name, clientKind: 'tv' },
    ])
  })

  it('expires an approved code and rejects a pairing if the approving session is revoked', async () => {
    await addUser('grace')
    const auth = bearer(body(await login('grace'), AuthResponse).token)
    const approve = async (issued: TvPairing) => {
      const { id } = body(await pair('lookup', { code: issued.userCode }, auth), TvPairingPreview)
      body(await pair('approve', { code: issued.userCode, id }, auth), Ok)
      return { deviceCode: issued.deviceCode }
    }
    const expired = await approve(await start())
    advance(600)
    expect(errorCode(await pair('poll', expired), 404)).toBe('pairing_unavailable')

    const revoked = await approve(await start())
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth })
    advance(5)
    expect(errorCode(await pair('poll', revoked), 404)).toBe('pairing_unavailable')
  })

  it('accepts a TOTP-authenticated session and uses PUBLIC_URL for the QR', async () => {
    vi.stubEnv('PUBLIC_URL', 'https://music.example.test')
    resetConfig()
    await addUser('ada-totp')
    const first = bearer(body(await login('ada-totp'), AuthResponse).token)
    const setup = body(await app.inject({ method: 'POST', url: '/api/v1/auth/two-factor/setup', headers: first, payload: { currentPassword: password } }), TwoFactorSetup)
    const code = () => hotp(base32Decode(setup.secret), totpStep())
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/two-factor/enable', headers: first, payload: { code: code() } })).statusCode).toBe(200)
    advance(30)
    const passwordOnly = await login('ada-totp')
    expect(errorCode(passwordOnly, 401)).toBe('two_factor_required')
    const { challenge } = TwoFactorChallenge.parse(passwordOnly.json().error.details)
    const signedIn = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login/two-factor', payload: { challenge, code: code() } }), AuthResponse)
    const issued = await start()
    expect(new URL(issued.verificationUrl).origin).toBe('https://music.example.test')
    const auth = bearer(signedIn.token)
    const { id } = body(await pair('lookup', { code: issued.userCode }, auth), TvPairingPreview)
    body(await pair('approve', { code: issued.userCode, id }, auth), Ok)
    advance(5)
    expect(body(await pair('poll', { deviceCode: issued.deviceCode }), TvPairingPoll).status).toBe('approved')
  })

  it('accepts an SSO session but rejects API tokens and app passwords', async () => {
    const user = await insertSsoUser({
      username: 'sso-user', displayName: null, email: null,
      identity: { issuer: 'https://sso.example.test', subject: '1', claims: {} },
    })
    const auth = bearer((await createSession(db, { userId: user.id, clientKind: 'web', method: 'sso' })).token)
    const apiToken = await createAppPassword(user.id, 'read token', { scopes: ['library:read'] })
    const appPassword = await createAppPassword(user.id, 'Subsonic')
    const issued = await start()
    const { id } = body(await pair('lookup', { code: issued.userCode }, auth), TvPairingPreview)
    const approval = { code: issued.userCode, id }
    expect(errorCode(await pair('approve', approval, bearer(apiToken.secret!)), 403)).toBe('insufficient_scope')
    expect(errorCode(await pair('approve', approval, bearer(appPassword.secret!)), 401)).toBe('unauthorized')
    body(await pair('approve', approval, auth), Ok)
    advance(5)
    expect(body(await pair('poll', { deviceCode: issued.deviceCode }), TvPairingPoll).status).toBe('approved')
  })

  it('limits issuance by address and code lookups by account', async () => {
    const payload = { device }
    for (let i = 0; i < 10; i++) expect((await pair('start', payload)).statusCode).toBe(200)
    const blocked = await pair('start', payload)
    expect(errorCode(blocked, 429)).toBe('rate_limited')
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect((await pair('start', payload, undefined, '192.168.1.21')).statusCode).toBe(200)

    await addUser('lin')
    const auth = bearer(body(await login('lin'), AuthResponse).token)
    const lookup = { code: 'ABCD-EFGH' }
    for (let i = 0; i < 20; i++) expect((await pair('lookup', lookup, auth)).statusCode).toBe(404)
    expect(errorCode(await pair('lookup', lookup, auth, '192.168.1.21'), 429)).toBe('rate_limited')
  })
})
