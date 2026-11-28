import { AccountSecurity, AuthResponse, AuthSessionList, Ok, Passkey, PasskeyOptions, SetupStatus, User, UserSecurity } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { resetConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { passkeys, totpCredentials, users } from '../../database/schema.js'
import { body, errorCode } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { SoftPasskey } from '../../test/webauthn.js'
import { insertUser } from './service.js'
import { relyingParty } from './passkeys.js'

const origin = 'https://music.example.com'
const password = 'correct horse'

describe('passkeys', () => {
  useTestDatabase()
  let app: FastifyInstance
  beforeAll(async () => {
    process.env.PUBLIC_URL = origin
    resetConfig()
    app = await buildApp()
  })
  afterAll(async () => {
    await app.close()
    delete process.env.PUBLIC_URL
    resetConfig()
  })

  const call = (options: InjectOptions) => app.inject(options)
  // Sign-ins come from addresses of their own, so the per-address limit does not count the whole file.
  let address = 0
  const from = () => ({ remoteAddress: `10.0.${Math.floor(++address / 250)}.${address % 250 + 1}` })
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  async function account(username: string, role: 'admin' | 'member' = 'member') {
    const user = await insertUser(db, { username, password, role })
    const login = body(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } }), AuthResponse)
    return { user, headers: bearer(login.token) }
  }

  async function addPasskey(headers: Record<string, string>, key = new SoftPasskey(origin), name = 'MacBook') {
    const started = body(await call({ method: 'POST', url: '/api/v1/auth/passkeys/options', headers, payload: { currentPassword: password } }), PasskeyOptions)
    const response = key.register(started.options as { challenge: string; user: { id: string } })
    const passkey = body(await call({ method: 'POST', url: '/api/v1/auth/passkeys', headers, payload: { challenge: started.challenge, name, response } }), Passkey, 201)
    return { key, passkey }
  }

  async function signInWith(key: SoftPasskey, mutate?: (response: ReturnType<SoftPasskey['authenticate']>) => void, origin?: string) {
    const place = from()
    const started = body(await call({ method: 'POST', url: '/api/v1/auth/passkey-login/options', payload: {}, ...place }), PasskeyOptions)
    expect(started.options).toMatchObject({ rpId: 'music.example.com', userVerification: 'required' })
    expect(started.options.allowCredentials ?? []).toEqual([])
    const response = key.authenticate(started.options as { challenge: string }, origin)
    mutate?.(response)
    return call({ method: 'POST', url: '/api/v1/auth/passkey-login', payload: { challenge: started.challenge, response, device: { id: 'mac-00000001', name: 'MacBook', kind: 'web' } }, ...place })
  }

  it('derives the relying party from PUBLIC_URL, and only for https or localhost', () => {
    expect(relyingParty()).toEqual({ id: 'music.example.com', origin })
    for (const [url, expected] of [
      ['http://music.example.com', null],
      ['http://localhost:5173', { id: 'localhost', origin: 'http://localhost:5173' }],
      ['https://192.168.1.20:4747', null],
      ['https://Music.Example.com./', { id: 'music.example.com', origin: 'https://music.example.com.' }],
    ] as const) {
      process.env.PUBLIC_URL = url
      resetConfig()
      expect(relyingParty(), url).toEqual(expected)
    }
    process.env.PUBLIC_URL = origin
    resetConfig()
  })

  it('says whether passkeys can be used before anyone signs in', async () => {
    await insertUser(db, { username: 'root', password, role: 'admin' })
    expect(body(await call({ url: '/api/v1/setup/status' }), SetupStatus).passkeysAvailable).toBe(true)
  })

  it('adds a passkey with the password, then signs in with it without a username', async () => {
    const { user, headers } = await account('ada')
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/passkeys/options', headers, payload: { currentPassword: 'wrong' } }), 403)).toBe('invalid_credentials')
    const started = body(await call({ method: 'POST', url: '/api/v1/auth/passkeys/options', headers, payload: { currentPassword: password } }), PasskeyOptions)
    expect(started.options).toMatchObject({
      rp: { id: 'music.example.com', name: 'Squirmy' },
      user: { name: 'ada' },
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    })

    const key = new SoftPasskey(origin)
    const response = key.register(started.options as { challenge: string; user: { id: string } })
    const passkey = body(await call({ method: 'POST', url: '/api/v1/auth/passkeys', headers, payload: { challenge: started.challenge, name: 'MacBook', response } }), Passkey, 201)
    expect(passkey).toMatchObject({ name: 'MacBook', lastUsedAt: null })
    // A challenge is used once.
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/passkeys', headers, payload: { challenge: started.challenge, name: 'Again', response } }), 400)).toBe('invalid_challenge')
    expect(body(await call({ url: '/api/v1/auth/security', headers }), AccountSecurity).passkeys).toEqual([passkey])

    const signedIn = body(await signInWith(key), AuthResponse)
    expect(signedIn.user.id).toBe(user.id)
    const sessions = body(await call({ url: '/api/v1/auth/sessions', headers: bearer(signedIn.token) }), AuthSessionList)
    expect(sessions.items.find((session) => session.current)?.method).toBe('passkey')
    const [stored] = await db.select().from(passkeys).where(eq(passkeys.id, passkey.id))
    expect(stored?.counter).toBe(1)
    expect(stored?.lastUsedAt).not.toBeNull()
  })

  it('skips the authenticator code: the passkey verified the user', async () => {
    const { headers } = await account('grace')
    const { key } = await addPasskey(headers)
    // Two-factor on: the password alone stops short, the passkey does not.
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.usernameKey, 'grace'))
    await db.insert(totpCredentials).values({ userId: row!.id, secretEncrypted: 'unused', confirmedAt: new Date() })
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'grace', password } }), 401)).toBe('two_factor_required')
    body(await signInWith(key), AuthResponse)
  })

  it('refuses a passkey it does not know, a forged signature, another origin and a stale challenge', async () => {
    const { headers } = await account('linus')
    const { key } = await addPasskey(headers)
    expect(errorCode(await signInWith(new SoftPasskey(origin)), 401)).toBe('invalid_passkey')
    expect(errorCode(await signInWith(key, (response) => { response.response.signature = Buffer.alloc(70, 1).toString('base64url') }), 401)).toBe('invalid_passkey')
    expect(errorCode(await signInWith(key, undefined, 'https://evil.example.com'), 401)).toBe('invalid_passkey')
    // A user handle that names another account.
    expect(errorCode(await signInWith(key, (response) => { response.response.userHandle = Buffer.alloc(16, 7).toString('base64url') }), 401)).toBe('invalid_passkey')

    const started = body(await call({ method: 'POST', url: '/api/v1/auth/passkey-login/options', payload: {} }), PasskeyOptions)
    const response = key.authenticate(started.options as { challenge: string })
    body(await call({ method: 'POST', url: '/api/v1/auth/passkey-login', payload: { challenge: started.challenge, response } }), AuthResponse)
    // The same assertion again: its challenge is gone.
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/passkey-login', payload: { challenge: started.challenge, response } }), 401)).toBe('invalid_challenge')
  })

  it('refuses a passkey made without user verification', async () => {
    const { headers } = await account('barbara')
    const started = body(await call({ method: 'POST', url: '/api/v1/auth/passkeys/options', headers, payload: { currentPassword: password } }), PasskeyOptions)
    const response = new SoftPasskey(origin, undefined, false).register(started.options as { challenge: string; user: { id: string } })
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/passkeys', headers, payload: { challenge: started.challenge, name: 'Key', response } }), 400)).toBe('invalid_passkey')
  })

  it('renames and removes passkeys, only the account’s own', async () => {
    const { headers } = await account('ken')
    const { key, passkey } = await addPasskey(headers)
    const other = await account('dennis')
    expect(errorCode(await call({ method: 'PATCH', url: `/api/v1/auth/passkeys/${passkey.id}`, headers: other.headers, payload: { name: 'Mine' } }), 404)).toBe('not_found')
    expect(errorCode(await call({ method: 'DELETE', url: `/api/v1/auth/passkeys/${passkey.id}`, headers: other.headers }), 404)).toBe('not_found')
    expect(body(await call({ method: 'PATCH', url: `/api/v1/auth/passkeys/${passkey.id}`, headers, payload: { name: ' iPhone ' } }), Passkey).name).toBe('iPhone')
    body(await call({ method: 'DELETE', url: `/api/v1/auth/passkeys/${passkey.id}`, headers }), Ok)
    expect(errorCode(await signInWith(key), 401)).toBe('invalid_passkey')
  })

  it('refuses a disabled account, and an admin reset removes the passkeys', async () => {
    const admin = await account('margaret', 'admin')
    const { user, headers } = await account('alan')
    const { key } = await addPasskey(headers)
    expect(body(await call({ url: `/api/v1/admin/users/${user.id}/security`, headers: admin.headers }), UserSecurity).passkeys).toHaveLength(1)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id))
    expect(errorCode(await signInWith(key), 403)).toBe('account_disabled')
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, user.id))
    body(await call({ method: 'PATCH', url: `/api/v1/admin/users/${user.id}`, headers: admin.headers, payload: { password: 'a new password' } }), User)
    expect(errorCode(await signInWith(key), 401)).toBe('invalid_passkey')
  })

  it('limits passkey sign-ins per address', async () => {
    const place = { remoteAddress: '192.0.2.77' }
    for (let attempt = 0; attempt < 20; attempt += 1) body(await call({ method: 'POST', url: '/api/v1/auth/passkey-login/options', payload: {}, ...place }), PasskeyOptions)
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/passkey-login/options', payload: {}, ...place }), 429)).toBe('rate_limited')
  })

  it('answers passkeys_unavailable without an https PUBLIC_URL', async () => {
    process.env.PUBLIC_URL = 'http://music.example.com'
    resetConfig()
    try {
      expect(errorCode(await call({ method: 'POST', url: '/api/v1/auth/passkey-login/options', payload: {} }), 409)).toBe('passkeys_unavailable')
      expect(body(await call({ url: '/api/v1/setup/status' }), SetupStatus).passkeysAvailable).toBe(false)
    } finally {
      process.env.PUBLIC_URL = origin
      resetConfig()
    }
  })
})
