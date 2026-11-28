import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { appPasswords, users } from '../../database/schema.js'
import { signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAppPassword, hashPassword } from './service.js'

describe('scoped API tokens', () => {
  useTestDatabase()
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeAll(async () => { app = await buildApp() })
  afterAll(async () => { await app.close() })

  it('creates, scopes, expires, and revokes bearer keys while keeping Subsonic app passwords', async () => {
    const password = 'a valid password'
    const admin = await signIn({ role: 'admin', passwordHash: await hashPassword(password) })
    const created = await app.inject({
      method: 'POST', url: '/api/v1/auth/app-passwords', headers: admin.headers,
      payload: { name: 'Reader', currentPassword: password, scopes: ['library:read'], expiresAt: new Date(Date.now() + 60_000).toISOString() },
    })
    expect(created.statusCode, created.body).toBe(201)
    const { id, secret, scopes } = created.json()
    expect(scopes).toEqual(['library:read'])
    const headers = { authorization: `Bearer ${secret}` }
    expect((await app.inject({ url: '/api/v1/library/tracks', headers })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v1/admin/settings', headers })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/v1/auth/app-passwords', headers })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/v1/playlists', headers, payload: { name: 'Forbidden playlist' } })).statusCode).toBe(403)
    const ping = (key: string) => app.inject({ url: `/rest/ping?apiKey=${key}&v=1.16.1&c=test&f=json` })
    expect((await ping(secret)).json()['subsonic-response'].error.code).toBe(44)
    const legacy = await createAppPassword(admin.id, 'Subsonic')
    expect((await ping(legacy.secret!)).json()['subsonic-response'].status).toBe('ok')

    await db.update(appPasswords).set({ expiresAt: new Date(0) }).where(eq(appPasswords.id, id))
    expect((await app.inject({ url: '/api/v1/library/tracks', headers })).statusCode).toBe(401)
    await db.update(appPasswords).set({ expiresAt: null }).where(eq(appPasswords.id, id))
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/auth/app-passwords/${id}`, headers: admin.headers })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v1/library/tracks', headers })).statusCode).toBe(401)
  })

  it('checks the current user role for admin scope and authorizes explicit playlist and playback operations', async () => {
    const admin = await signIn({ role: 'admin' })
    const adminKey = await createAppPassword(admin.id, 'Operator', { scopes: ['admin'] })
    const headers = { authorization: `Bearer ${adminKey.secret}` }
    expect((await app.inject({ url: '/api/v1/admin/settings', headers })).statusCode).toBe(200)
    await db.update(users).set({ role: 'member' }).where(eq(users.id, admin.id))
    expect((await app.inject({ url: '/api/v1/admin/settings', headers })).statusCode).toBe(403)

    const key = await createAppPassword(admin.id, 'Controller', { scopes: ['playlists:manage', 'playback:control'] })
    const control = { authorization: `Bearer ${key.secret}` }
    expect((await app.inject({ method: 'POST', url: '/api/v1/playlists', headers: control, payload: { name: 'Allowed playlist' } })).statusCode).toBe(201)
    expect((await app.inject({ url: '/api/v1/me/session', headers: control })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/session/command', headers: control, payload: { type: 'pause' } })).statusCode).toBe(409)
    expect((await app.inject({ url: '/api/v1/library/tracks', headers: control })).statusCode).toBe(403)
  })
})
