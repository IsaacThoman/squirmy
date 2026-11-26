import { createHash } from 'node:crypto'
import { APP_PASSWORD_LIMIT } from '@squirmy/contracts'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { eq, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { resetConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { appPasswords, authSessions, devices, invites, users } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { findAppPasswordByKey, insertUser, rememberDevice, verifyAppPassword } from './service.js'

const device = { id: 'device-0001', name: 'Test phone', kind: 'ios' as const }

describe('auth', () => {
  useTestDatabase()
  let app: FastifyInstance
  beforeAll(async () => { app = await buildApp() })
  afterAll(async () => { await app.close() })

  const call = (options: InjectOptions) => app.inject(options)
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const web = { 'x-squirmy-client': 'web' }
  let adminToken = ''

  it('sets up the first admin once', async () => {
    expect((await call({ url: '/api/v1/setup/status' })).json()).toMatchObject({ needsSetup: true, serverName: 'Squirmy', registrationRequiresInvite: true, wantlistEnabled: false, supportsTvDevices: true })
    expect((await call({ url: '/api/v1/setup/status' })).json().version).toMatch(/^(\d+\.\d+\.\d+|dev(\+[0-9a-f]+)?)$/)

    // Concurrent attempts: exactly one wins.
    const attempts = await Promise.all(['admin', 'other'].map((username) =>
      call({ method: 'POST', url: '/api/v1/setup', payload: { username, password: 'correct horse', device } })))
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const winner = attempts.find((response) => response.statusCode === 200)!
    expect(winner.json().user.role).toBe('admin')
    expect((await call({ url: '/api/v1/setup/status' })).json().needsSetup).toBe(false)
    expect(await db.select().from(devices)).toEqual([expect.objectContaining({ id: device.id, kind: 'ios' })])

    // Rename the winner so later tests know its name.
    await db.update(users).set({ username: 'admin', usernameKey: 'admin' }).where(eq(users.role, 'admin'))
  })

  it('logs in with a bearer token, reads me and logs out', async () => {
    const login = await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ADMIN', password: 'correct horse' } })
    expect(login.statusCode).toBe(200)
    expect(login.cookies).toEqual([])
    const { token, user } = login.json()
    adminToken = token
    expect(user.username).toBe('admin')

    const [session] = await db.select().from(authSessions).where(eq(authSessions.userId, user.id)).limit(1)
    expect(session?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(await db.select().from(authSessions))).not.toContain(token)

    const me = await call({ url: '/api/v1/auth/me', headers: bearer(token) })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ username: 'admin', role: 'admin', disabled: false })

    const second = (await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'correct horse' } })).json().token
    expect((await call({ method: 'POST', url: '/api/v1/auth/logout', headers: bearer(second) })).statusCode).toBe(200)
    expect((await call({ url: '/api/v1/auth/me', headers: bearer(second) })).statusCode).toBe(401)
    expect((await call({ url: '/api/v1/auth/me', headers: bearer(token) })).statusCode).toBe(200)
  })

  it('rejects wrong passwords and unknown users alike', async () => {
    const wrong = await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'nope' } })
    const unknown = await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ghost', password: 'nope' } })
    expect(wrong.statusCode).toBe(401)
    expect(unknown.json()).toEqual(wrong.json())
    expect((await call({ url: '/api/v1/auth/me' })).statusCode).toBe(401)
  })

  it('gives browsers a cookie and requires the CSRF header on cookie writes', async () => {
    const login = await call({ method: 'POST', url: '/api/v1/auth/login', headers: web, payload: { username: 'admin', password: 'correct horse' } })
    const cookie = login.cookies.find((entry) => entry.name === 'squirmy_session')
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' })
    expect(cookie?.value).toBe(login.json().token)
    const headers = { cookie: `squirmy_session=${cookie!.value}` }

    const me = await call({ url: '/api/v1/auth/me', headers })
    expect(me.statusCode).toBe(200)
    expect(me.cookies.find((entry) => entry.name === 'squirmy_session')?.maxAge).toBeGreaterThan(0)

    const forged = await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers, payload: { name: 'x', currentPassword: 'correct horse' } })
    expect(forged.statusCode).toBe(403)
    expect(forged.json().error.code).toBe('csrf')
    const allowed = await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers: { ...headers, 'x-squirmy-request': '1' }, payload: { name: 'x', currentPassword: 'correct horse' } })
    expect(allowed.statusCode).toBe(201)
    // Bearer requests are exempt.
    expect((await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers: bearer(adminToken), payload: { name: 'y', currentPassword: 'correct horse' } })).statusCode).toBe(201)

    const logout = await call({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...headers, 'x-squirmy-request': '1' } })
    expect(logout.cookies.find((entry) => entry.name === 'squirmy_session')?.value).toBe('')
    expect((await call({ url: '/api/v1/auth/me', headers })).statusCode).toBe(401)
  })

  it('marks the cookie Secure for HTTPS, including behind a tunnel that drops the protocol', async () => {
    const cookieFor = async (headers: Record<string, string>) => {
      const login = await call({ method: 'POST', url: '/api/v1/auth/login', headers: { ...web, ...headers }, payload: { username: 'admin', password: 'correct horse' } })
      return login.cookies.find((entry) => entry.name === 'squirmy_session')!
    }
    expect((await cookieFor({ host: 'music.example.com' })).secure).toBeUndefined()
    process.env.PUBLIC_URL = 'https://Music.Example.com'
    resetConfig()
    try {
      expect((await cookieFor({ host: 'music.example.com' })).secure).toBe(true)
      expect((await cookieFor({ host: 'music.example.com:443' })).secure).toBe(true)
      expect((await cookieFor({ host: 'music.example.com.' })).secure).toBe(true)
      // Plain HTTP on the LAN keeps working: browsers drop Secure cookies there.
      expect((await cookieFor({ host: '192.168.1.20:4747' })).secure).toBeUndefined()
    } finally {
      delete process.env.PUBLIC_URL
      resetConfig()
    }
  })

  it('rate limits login per username and per address', async () => {
    const limited = await buildApp()
    await insertUser(db, { username: 'spread', password: 'spread password', role: 'member', canUpload: false, canAcquire: false })
    try {
      const attempt = (username: string, ip: string, password = 'nope') =>
        limited.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { username, password } })

      // Correct sign-ins use up nobody's budget.
      for (let index = 0; index < 8; index++) expect((await attempt('admin', '10.0.2.1', 'correct horse')).statusCode).toBe(200)

      // Failures lock that username out from that address only.
      const guesses = []
      for (let index = 0; index < 6; index++) guesses.push((await attempt('ADMIN', '10.0.3.1')).statusCode)
      expect(guesses).toEqual([401, 401, 401, 401, 401, 429])
      expect((await attempt('admin', '10.0.3.1', 'correct horse')).statusCode).toBe(429)
      expect((await attempt('admin', '10.0.3.2', 'correct horse')).statusCode).toBe(200)
      expect((await attempt('admin', '2001:db8:1:1::5', 'correct horse')).statusCode).toBe(200)
      // IPv6 counts per /64.
      for (let index = 0; index < 5; index++) await attempt('admin', `2001:db8:1:1::${index + 10}`)
      expect((await attempt('admin', '2001:db8:1:1::99', 'correct horse')).statusCode).toBe(429)

      // Concurrent guesses cannot all slip past the count while the first is checked.
      const burst = await Promise.all(Array.from({ length: 12 }, () => attempt('admin', '10.0.6.1')))
      expect(burst.filter((response) => response.statusCode === 401)).toHaveLength(5)
      expect(burst.filter((response) => response.statusCode === 429)).toHaveLength(7)

      // Many /64s of one /48 count together too.
      for (let net = 0; net < 2; net++) for (let index = 0; index < 5; index++) await attempt('admin', `2001:db8:7:${net}::${index + 1}`)
      expect((await attempt('admin', '2001:db8:7:9::1', 'correct horse')).statusCode).toBe(429)
      expect((await attempt('admin', '2001:db8:8::1', 'correct horse')).statusCode).toBe(200)

      // A looser ceiling across every address, which spares addresses that signed in lately.
      await attempt('spread', '10.0.4.200', 'spread password')
      const spread = []
      for (let index = 0; index < 31; index++) spread.push((await attempt('spread', `10.0.4.${index}`)).statusCode)
      expect(spread.slice(0, 30).every((status) => status === 401)).toBe(true)
      expect(spread[30]).toBe(429)
      expect((await attempt('spread', '10.0.4.99', 'spread password')).statusCode).toBe(429)
      expect((await attempt('spread', '10.0.4.200', 'spread password')).statusCode).toBe(200)

      const perIp = []
      for (let index = 0; index < 20; index++) perIp.push((await attempt(`someone${index}`, '10.0.1.1')).statusCode)
      expect(perIp.every((status) => status === 401)).toBe(true)
      const last = await attempt('someone-else', '10.0.1.1')
      expect(last.statusCode).toBe(429)
      expect(last.json().error.code).toBe('rate_limited')
      expect(Number(last.headers['retry-after'])).toBeGreaterThan(0)

      const huge = await attempt('admin', '10.0.5.1', 'x'.repeat(201))
      expect(huge.statusCode).toBe(400)
    } finally {
      await limited.close()
    }
  })

  it('registers with an invite, and without one only when allowed', async () => {
    const [invite] = await db.insert(invites).values({ id: newId(), code: 'invite-123', canUpload: true }).returning()
    const register = (payload: object) => call({ method: 'POST', url: '/api/v1/auth/register', payload })

    expect((await register({ username: 'nobody', password: 'long enough' })).json().error.code).toBe('invite_required')
    expect((await register({ inviteCode: 'wrong', username: 'nobody', password: 'long enough' })).json().error.code).toBe('invalid_invite')
    expect((await register({ inviteCode: 'invite-123', username: 'ADMIN', password: 'long enough' })).json().error.code).toBe('username_taken')

    const joined = await register({ inviteCode: 'invite-123', username: 'mira', password: 'long enough' })
    expect(joined.statusCode).toBe(200)
    expect(joined.json().user).toMatchObject({ username: 'mira', role: 'member', canUpload: true })
    const [used] = await db.select().from(invites).where(eq(invites.id, invite!.id))
    expect(used?.usedBy).toBe(joined.json().user.id)
    expect((await register({ inviteCode: 'invite-123', username: 'again', password: 'long enough' })).json().error.code).toBe('invalid_invite')

    await updateServerSettings({ registrationRequiresInvite: false })
    const open = await register({ username: 'walk-in', password: 'long enough' })
    expect(open.statusCode).toBe(200)
    expect(open.json().user.canUpload).toBe(false)
    await updateServerSettings({ registrationRequiresInvite: true })
  })

  it('changes the password and ends the other sessions', async () => {
    const login = (password: string) => call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'mira', password } })
    const keep = (await login('long enough')).json().token
    const other = (await login('long enough')).json().token
    const change = (payload: object) => call({ method: 'POST', url: '/api/v1/auth/password', headers: bearer(keep), payload })

    expect((await change({ currentPassword: 'wrong', newPassword: 'new password' })).statusCode).toBe(403)
    expect((await change({ currentPassword: 'long enough', newPassword: 'new password' })).statusCode).toBe(200)
    expect((await call({ url: '/api/v1/auth/me', headers: bearer(keep) })).statusCode).toBe(200)
    expect((await call({ url: '/api/v1/auth/me', headers: bearer(other) })).statusCode).toBe(401)
    expect((await login('long enough')).statusCode).toBe(401)
    expect((await login('new password')).statusCode).toBe(200)
  })

  it('deletes app passwords on a password change unless asked to keep them', async () => {
    const token = (await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'mira', password: 'new password' } })).json().token
    const create = async () => (await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers: bearer(token), payload: { name: 'App', currentPassword: 'new password' } })).json().secret as string
    const change = (payload: object) => call({ method: 'POST', url: '/api/v1/auth/password', headers: bearer(token), payload })

    const kept = await create()
    expect((await change({ currentPassword: 'new password', newPassword: 'newer password', keepAppPasswords: true })).statusCode).toBe(200)
    expect(await findAppPasswordByKey(kept)).not.toBeNull()
    expect((await change({ currentPassword: 'newer password', newPassword: 'new password' })).statusCode).toBe(200)
    expect(await findAppPasswordByKey(kept)).toBeNull()
  })

  it('needs the current password to create an app password, and caps how many', async () => {
    const create = (payload: object) => call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers: bearer(adminToken), payload })
    // Clients from before the change get a code they can show.
    const old = await create({ name: 'Old app' })
    expect(old.statusCode).toBe(400)
    expect(old.json().error.code).toBe('current_password_required')
    const wrong = await create({ name: 'Phone', currentPassword: 'wrong' })
    expect(wrong.statusCode).toBe(403)
    expect(wrong.json().error.code).toBe('invalid_credentials')

    const [admin] = await db.select().from(users).where(eq(users.usernameKey, 'admin'))
    const held = (await db.select().from(appPasswords).where(eq(appPasswords.userId, admin!.id))).length
    await db.insert(appPasswords).values(Array.from({ length: APP_PASSWORD_LIMIT - held }, (_, index) => ({
      id: newId(), userId: admin!.id, name: `filler ${index}`, secretEncrypted: 'x', keyHash: `filler-${index}`,
    })))
    const full = await create({ name: 'One more', currentPassword: 'correct horse' })
    expect(full.statusCode).toBe(409)
    expect(full.json().error.code).toBe('too_many_app_passwords')
    await db.delete(appPasswords).where(like(appPasswords.name, 'filler %'))
  })

  it('creates app passwords that work for Subsonic auth', async () => {
    const created = await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers: bearer(adminToken), payload: { name: 'Phone', currentPassword: 'correct horse' } })
    const { id, secret } = created.json()
    expect(secret).toEqual(expect.any(String))

    const [row] = await db.select().from(appPasswords).where(eq(appPasswords.id, id))
    expect(row?.secretEncrypted).not.toContain(secret)

    const list = await call({ url: '/api/v1/auth/app-passwords', headers: bearer(adminToken) })
    const listed = list.json().items.find((item: { id: string }) => item.id === id)
    expect(listed).toMatchObject({ name: 'Phone' })
    expect(listed.secret).toBeUndefined()

    expect((await verifyAppPassword('admin', { password: secret }))?.username).toBe('admin')
    const salt = 'c19b2d'
    const token = createHash('md5').update(secret + salt).digest('hex')
    expect((await verifyAppPassword('Admin', { token, salt }))?.username).toBe('admin')
    expect(await verifyAppPassword('admin', { token, salt: 'other' })).toBeNull()
    expect(await verifyAppPassword('admin', { password: 'correct horse' })).toBeNull()
    expect((await findAppPasswordByKey(secret))?.username).toBe('admin')
    expect(await findAppPasswordByKey('not-a-key')).toBeNull()

    expect((await call({ method: 'DELETE', url: `/api/v1/auth/app-passwords/${id}`, headers: bearer(adminToken) })).statusCode).toBe(200)
    expect(await findAppPasswordByKey(secret)).toBeNull()
    expect((await call({ method: 'DELETE', url: `/api/v1/auth/app-passwords/${id}`, headers: bearer(adminToken) })).statusCode).toBe(404)
  })

  it('keeps the most recently seen 100 devices per user', async () => {
    const [mira] = await db.select().from(users).where(eq(users.usernameKey, 'mira'))
    await db.insert(devices).values(Array.from({ length: 100 }, (_, index) => ({
      userId: mira!.id, id: `old-device-${String(index).padStart(3, '0')}`, name: 'Old', kind: 'other', lastSeenAt: new Date(Date.now() - (200 - index) * 60_000),
    })))
    await rememberDevice(db, mira!.id, { id: 'new-device-1', name: 'New', kind: 'ios' })
    const kept = await db.select().from(devices).where(eq(devices.userId, mira!.id))
    expect(kept).toHaveLength(100)
    expect(kept.map((row) => row.id)).toContain('new-device-1')
    expect(kept.map((row) => row.id)).not.toContain('old-device-000')
  })

  it('forgets devices not seen for as long as a session lasts when a new one signs in', async () => {
    const user = await createUser()
    const day = 24 * 60 * 60_000
    await db.insert(devices).values([
      { userId: user.id, id: 'gone-device', name: 'Chrome on macOS', kind: 'web', lastSeenAt: new Date(Date.now() - 181 * day) },
      { userId: user.id, id: 'kept-device', name: 'Chrome on macOS', kind: 'web', lastSeenAt: new Date(Date.now() - 179 * day) },
    ])
    // Seeing a known device prunes nothing; a new one does.
    await rememberDevice(db, user.id, { id: 'kept-device', name: 'Chrome on macOS', kind: 'web' })
    expect((await db.select().from(devices).where(eq(devices.userId, user.id))).map((row) => row.id).toSorted()).toEqual(['gone-device', 'kept-device'])
    await rememberDevice(db, user.id, { id: 'new-device-2', name: 'iPhone', kind: 'ios' })
    expect((await db.select().from(devices).where(eq(devices.userId, user.id))).map((row) => row.id).toSorted()).toEqual(['kept-device', 'new-device-2'])
  })

  it('rejects disabled accounts', async () => {
    const token = (await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'walk-in', password: 'long enough' } })).json().token
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.usernameKey, 'walk-in'))
    expect((await call({ url: '/api/v1/auth/me', headers: bearer(token) })).statusCode).toBe(401)
    const login = await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'walk-in', password: 'long enough' } })
    expect(login.json().error.code).toBe('account_disabled')
  })
})
