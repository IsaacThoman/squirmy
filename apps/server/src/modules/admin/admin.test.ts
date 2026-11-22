import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { queryKeys, SetupStatus } from '@squirmy/contracts'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { enqueue, startJobs, stopJobs } from '../../jobs/index.js'
import { getServerSecret } from '../../lib/settings.js'
import { invalidate } from '../../realtime/index.js'
import { useTestDatabase } from '../../test/database.js'

// Records invalidations and still sends them.
vi.mock('../../realtime/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../realtime/index.js')>()
  return { ...original, invalidate: vi.fn(original.invalidate) }
})
const invalidated = vi.mocked(invalidate)

describe('admin', () => {
  useTestDatabase()
  let app: FastifyInstance
  let admin: { authorization: string }
  let member: { authorization: string }
  let adminId = ''

  const call = (options: InjectOptions) => app.inject(options)
  const login = async (username: string, password: string) => {
    const response = await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })
    return { authorization: `Bearer ${response.json().token}` }
  }

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
    const setup = await call({ method: 'POST', url: '/api/v1/setup', payload: { username: 'root', password: 'root password' } })
    adminId = setup.json().user.id
    admin = { authorization: `Bearer ${setup.json().token}` }
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
  })

  it('creates, lists and updates users', async () => {
    const created = await call({ method: 'POST', url: '/api/v1/admin/users', headers: admin, payload: { username: 'Mira', password: 'mira password' } })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ username: 'Mira', role: 'member', disabled: false })
    expect((await call({ method: 'POST', url: '/api/v1/admin/users', headers: admin, payload: { username: 'mira', password: 'mira password' } })).statusCode).toBe(409)
    member = await login('mira', 'mira password')

    expect((await call({ url: '/api/v1/admin/users', headers: member })).statusCode).toBe(403)
    expect((await call({ url: '/api/v1/admin/users' })).statusCode).toBe(401)
    const list = await call({ url: '/api/v1/admin/users', headers: admin })
    expect(list.json().items.map((user: { username: string }) => user.username)).toEqual(['Mira', 'root'])

    const id = created.json().id
    const updated = await call({ method: 'PATCH', url: `/api/v1/admin/users/${id}`, headers: admin, payload: { displayName: 'Mira V', canUpload: true } })
    expect(updated.json()).toMatchObject({ displayName: 'Mira V', canUpload: true })
    expect((await call({ url: '/api/v1/auth/me', headers: member })).statusCode).toBe(200)

    // A password reset signs the user out everywhere.
    await call({ method: 'PATCH', url: `/api/v1/admin/users/${id}`, headers: admin, payload: { password: 'reset password' } })
    expect((await call({ url: '/api/v1/auth/me', headers: member })).statusCode).toBe(401)
    member = await login('mira', 'reset password')

    const disabled = await call({ method: 'PATCH', url: `/api/v1/admin/users/${id}`, headers: admin, payload: { disabled: true } })
    expect(disabled.json().disabled).toBe(true)
    expect((await call({ url: '/api/v1/auth/me', headers: member })).statusCode).toBe(401)
    await call({ method: 'PATCH', url: `/api/v1/admin/users/${id}`, headers: admin, payload: { disabled: false } })
    member = await login('mira', 'reset password')
  })

  it('never removes or demotes the last admin', async () => {
    const demote = await call({ method: 'PATCH', url: `/api/v1/admin/users/${adminId}`, headers: admin, payload: { role: 'member' } })
    expect(demote.statusCode).toBe(409)
    expect(demote.json().error.code).toBe('last_admin')
    expect((await call({ method: 'PATCH', url: `/api/v1/admin/users/${adminId}`, headers: admin, payload: { disabled: true } })).statusCode).toBe(409)
    expect((await call({ method: 'DELETE', url: `/api/v1/admin/users/${adminId}`, headers: admin })).statusCode).toBe(409)

    const second = await call({ method: 'POST', url: '/api/v1/admin/users', headers: admin, payload: { username: 'deputy', password: 'deputy password', role: 'admin' } })
    const deputyId = second.json().id
    const deputy = await login('deputy', 'deputy password')
    // Two admins stepping down at once: the lock lets only one through.
    const results = await Promise.all([[adminId, admin], [deputyId, deputy]].map(([id, headers]) =>
      call({ method: 'PATCH', url: `/api/v1/admin/users/${id}`, headers: headers as typeof admin, payload: { role: 'member' } })))
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const rootStayed = results[0]!.statusCode === 409
    const remaining = await call({ url: '/api/v1/admin/users', headers: rootStayed ? admin : deputy })
    expect(remaining.json().items.filter((user: { role: string }) => user.role === 'admin')).toHaveLength(1)

    // Restore root as the only admin for the remaining tests.
    if (!rootStayed) {
      await call({ method: 'PATCH', url: `/api/v1/admin/users/${adminId}`, headers: deputy, payload: { role: 'admin' } })
      admin = await login('root', 'root password')
    }
    expect((await call({ method: 'DELETE', url: `/api/v1/admin/users/${deputyId}`, headers: admin })).statusCode).toBe(200)
    expect((await call({ url: '/api/v1/auth/me', headers: deputy })).statusCode).toBe(401)
  })

  it('creates and revokes invites', async () => {
    const created = await call({ method: 'POST', url: '/api/v1/admin/invites', headers: admin, payload: { canUpload: true } })
    expect(created.statusCode).toBe(201)
    const invite = created.json()
    expect(invite).toMatchObject({ role: 'member', canUpload: true, usedBy: null })
    expect(new Date(invite.expiresAt).getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000)

    await call({ method: 'POST', url: '/api/v1/auth/register', payload: { inviteCode: invite.code, username: 'newcomer', password: 'newcomer password' } })
    const listed = (await call({ url: '/api/v1/admin/invites', headers: admin })).json().items
    expect(listed).toEqual([expect.objectContaining({ id: invite.id, usedBy: 'newcomer' })])

    const spare = (await call({ method: 'POST', url: '/api/v1/admin/invites', headers: admin, payload: { expiresInDays: null } })).json()
    expect(spare.expiresAt).toBeNull()
    expect((await call({ method: 'DELETE', url: `/api/v1/admin/invites/${spare.id}`, headers: admin })).statusCode).toBe(200)
    const register = await call({ method: 'POST', url: '/api/v1/auth/register', payload: { inviteCode: spare.code, username: 'late', password: 'late password' } })
    expect(register.json().error.code).toBe('invalid_invite')
  })

  it('reads and writes server settings without returning secrets', async () => {
    const initial = await call({ url: '/api/v1/admin/settings', headers: admin })
    expect(initial.json()).toMatchObject({ serverName: 'Squirmy', acoustIdKeySet: false })
    const updated = await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers: admin, payload: { serverName: 'Home', acoustIdKey: 'very-secret-key' } })
    expect(updated.json()).toMatchObject({ serverName: 'Home', acoustIdKeySet: true })
    expect(updated.body).not.toContain('very-secret-key')
    expect((await call({ url: '/api/v1/admin/settings', headers: admin })).body).not.toContain('very-secret-key')
    expect(await getServerSecret('acoustIdKey')).toBe('very-secret-key')
    expect((await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers: admin, payload: { matchAutoAcceptScore: 2 } })).statusCode).toBe(400)
    expect((await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers: admin, payload: { musicBrainzBaseUrl: 'musicbrainz-mirror:5000' } })).statusCode).toBe(400)
    expect((await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers: member, payload: { serverName: 'Mine' } })).statusCode).toBe(403)
    expect((await call({ url: '/api/v1/setup/status' })).json().serverName).toBe('Home')
  })

  it('keeps the wantlist off until an admin turns it on, and tells open clients', async () => {
    const status = async () => SetupStatus.parse((await call({ url: '/api/v1/setup/status' })).json()).wantlistEnabled
    expect((await call({ url: '/api/v1/admin/settings', headers: admin })).json().wantlistEnabled).toBe(false)
    expect(await status()).toBe(false)

    const clientKeys = [queryKeys.setupStatus(), queryKeys.home(), queryKeys.wants()]
    invalidated.mockClear()
    const on = await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers: admin, payload: { wantlistEnabled: true } })
    expect(on.json().wantlistEnabled).toBe(true)
    expect(await status()).toBe(true)
    expect(invalidated).toHaveBeenCalledWith('all', clientKeys)

    // Saving other settings leaves what clients show alone.
    invalidated.mockClear()
    await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers: admin, payload: { wantlistEnabled: true, serverName: 'Home' } })
    expect(invalidated).not.toHaveBeenCalledWith('all', clientKeys)

    await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers: admin, payload: { wantlistEnabled: false } })
    expect(await status()).toBe(false)
    expect(invalidated).toHaveBeenCalledWith('all', clientKeys)
  })

  it('reports queue stats', async () => {
    await enqueue('admin.test', { value: 1 })
    const response = await call({ url: '/api/v1/admin/jobs', headers: admin })
    expect(response.json()).toContainEqual({ name: 'admin.test', queued: 1, active: 0, failed: 0 })
  })

  it('lists directories only, resolving symlinks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'squirmy-fs-'))
    try {
      await mkdir(path.join(root, 'Music', 'Albums'), { recursive: true })
      await mkdir(path.join(root, '.hidden'))
      await writeFile(path.join(root, 'notes.txt'), 'not a directory')
      await symlink(path.join(root, 'Music'), path.join(root, 'Linked'))
      await symlink(path.join(root, 'missing'), path.join(root, 'Broken'))

      const listing = (await call({ url: `/api/v1/admin/fs?path=${encodeURIComponent(path.join(root, 'Linked'))}`, headers: admin })).json()
      const real = listing.path as string
      expect(real.endsWith(path.join(path.basename(root), 'Music'))).toBe(true)
      expect(listing.directories).toEqual([{ name: 'Albums', path: path.join(real, 'Albums') }])

      const top = (await call({ url: `/api/v1/admin/fs?path=${encodeURIComponent(root)}`, headers: admin })).json()
      expect(top.directories.map((entry: { name: string }) => entry.name)).toEqual(['Linked', 'Music'])
      expect(top.parent).toBe(path.dirname(top.path))

      expect((await call({ url: '/api/v1/admin/fs?path=/', headers: admin })).json().parent).toBeNull()
      expect((await call({ url: '/api/v1/admin/fs', headers: admin })).statusCode).toBe(200)
      expect((await call({ url: `/api/v1/admin/fs?path=${encodeURIComponent(path.join(root, 'nope'))}`, headers: admin })).statusCode).toBe(404)
      expect((await call({ url: `/api/v1/admin/fs?path=${encodeURIComponent(path.join(root, 'notes.txt'))}`, headers: admin })).statusCode).toBe(400)
      expect((await call({ url: '/api/v1/admin/fs?path=relative', headers: admin })).statusCode).toBe(400)
      expect((await call({ url: `/api/v1/admin/fs?path=${encodeURIComponent(root)}`, headers: member })).statusCode).toBe(403)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
