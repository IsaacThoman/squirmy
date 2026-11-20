import { createHash } from 'node:crypto'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { appPasswords, authSessions, devices, invites, users } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { findAppPasswordByKey, verifyAppPassword } from './service.js'

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
    expect((await call({ url: '/api/v1/setup/status' })).json()).toMatchObject({ needsSetup: true, serverName: 'Squirmy', registrationRequiresInvite: true })
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

    const forged = await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers, payload: { name: 'x' } })
    expect(forged.statusCode).toBe(403)
    expect(forged.json().error.code).toBe('csrf')
    const allowed = await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers: { ...headers, 'x-squirmy-request': '1' }, payload: { name: 'x' } })
    expect(allowed.statusCode).toBe(201)
    // Bearer requests are exempt.
    expect((await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers: bearer(adminToken), payload: { name: 'y' } })).statusCode).toBe(201)

    const logout = await call({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...headers, 'x-squirmy-request': '1' } })
    expect(logout.cookies.find((entry) => entry.name === 'squirmy_session')?.value).toBe('')
    expect((await call({ url: '/api/v1/auth/me', headers })).statusCode).toBe(401)
  })

  it('rate limits login per username and per address', async () => {
    const limited = await buildApp()
    try {
      const attempt = (username: string, ip: string) => limited.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { username, password: 'nope' } })
      const perUser = []
      for (let index = 0; index < 6; index++) perUser.push((await attempt('admin', `10.0.0.${index}`)).statusCode)
      expect(perUser).toEqual([401, 401, 401, 401, 401, 429])

      const perIp = []
      for (let index = 0; index < 20; index++) perIp.push((await attempt(`someone${index}`, '10.0.1.1')).statusCode)
      expect(perIp.every((status) => status === 401)).toBe(true)
      const last = await attempt('someone-else', '10.0.1.1')
      expect(last.statusCode).toBe(429)
      expect(last.json().error.code).toBe('rate_limited')
      expect(Number(last.headers['retry-after'])).toBeGreaterThan(0)
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

  it('creates app passwords that work for Subsonic auth', async () => {
    const created = await call({ method: 'POST', url: '/api/v1/auth/app-passwords', headers: bearer(adminToken), payload: { name: 'Phone' } })
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

  it('rejects disabled accounts', async () => {
    const token = (await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'walk-in', password: 'long enough' } })).json().token
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.usernameKey, 'walk-in'))
    expect((await call({ url: '/api/v1/auth/me', headers: bearer(token) })).statusCode).toBe(401)
    const login = await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'walk-in', password: 'long enough' } })
    expect(login.json().error.code).toBe('account_disabled')
  })
})
