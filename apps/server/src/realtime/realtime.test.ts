import type { AddressInfo } from 'node:net'
import { queryKeys, type ClientToServerEvents, type EntityChange, type ServerEvent, type ServerToClientEvents } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { io as connect, type Socket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { db } from '../database/client.js'
import { authSessions } from '../database/schema.js'
import { hashToken } from '../lib/crypto.js'
import { useTestDatabase } from '../test/database.js'
import { changeKeys, disconnectSockets, invalidate, publish, publishChanges, startRealtime } from './index.js'
import type { RealtimeSocket } from './types.js'

type Client = Socket<ServerToClientEvents, ClientToServerEvents>

describe('realtime', () => {
  useTestDatabase()
  let app: FastifyInstance
  let url = ''
  let admin = { id: '', token: '' }
  let member = { id: '', token: '' }
  const connected: RealtimeSocket[] = []
  const clients: Client[] = []

  beforeAll(async () => {
    app = await buildApp()
    const realtime = await startRealtime(app)
    realtime.onConnection((socket) => { connected.push(socket) })
    await app.listen({ host: '127.0.0.1', port: 0 })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'admin', password: 'admin password' } })
    admin = { id: setup.json().user.id, token: setup.json().token }
    await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: { authorization: `Bearer ${admin.token}` }, payload: { username: 'member', password: 'member password' } })
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'member', password: 'member password' } })
    member = { id: login.json().user.id, token: login.json().token }
  })
  afterEach(() => { for (const client of clients.splice(0)) client.disconnect() })
  afterAll(async () => { await app.close() })

  function open(options: { token?: string; cookie?: string; origin?: string } = {}): Promise<Client> {
    const headers = { ...(options.cookie && { cookie: options.cookie }), ...(options.origin && { origin: options.origin }) }
    const client: Client = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      auth: options.token ? { token: options.token } : {},
      extraHeaders: Object.keys(headers).length ? headers : undefined,
    })
    clients.push(client)
    return new Promise((resolve, reject) => {
      client.once('connect', () => resolve(client))
      client.once('connect_error', reject)
    })
  }

  const next = <E extends keyof ServerToClientEvents>(client: Client, event: E) =>
    new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve) => {
      client.once(event, ((payload: Parameters<ServerToClientEvents[E]>[0]) => resolve(payload)) as never)
    })

  it('rejects sockets without a valid session', async () => {
    await expect(open()).rejects.toThrow('unauthorized')
    await expect(open({ token: 'not-a-token' })).rejects.toThrow('unauthorized')
  })

  it('accepts the token in auth or in the session cookie, and runs connection handlers', async () => {
    await open({ token: member.token })
    await open({ cookie: `squirmy_session=${admin.token}` })
    await expect.poll(() => connected.length).toBeGreaterThanOrEqual(2)
    const data = connected.map((socket) => socket.data)
    expect(data).toContainEqual(expect.objectContaining({ userId: member.id, role: 'member' }))
    expect(data).toContainEqual(expect.objectContaining({ userId: admin.id, role: 'admin' }))
  })

  it('takes the session cookie only from the app\'s own origin', async () => {
    const cookie = `squirmy_session=${member.token}`
    await open({ cookie, origin: url })
    await open({ cookie })
    await expect(open({ cookie, origin: 'https://sibling.example.com' })).rejects.toThrow('unauthorized')
    await expect(open({ cookie, origin: 'null' })).rejects.toThrow('unauthorized')
    // A bearer token is not sent by the browser on its own, so any origin may use one.
    await open({ token: member.token, origin: 'https://sibling.example.com' })
  })

  it('disconnects a socket when its session expires', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'member', password: 'member password' } })
    const { token } = login.json()
    await db.update(authSessions).set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 1500) }).where(eq(authSessions.tokenHash, hashToken(token)))
    const client = await open({ token })
    const reason = await new Promise<string>((resolve) => client.once('disconnect', resolve))
    expect(reason).toBe('io server disconnect')
  })

  it('delivers invalidations and events to the right rooms through NOTIFY', async () => {
    const memberClient = await open({ token: member.token })
    const adminClient = await open({ token: admin.token })
    const missed: unknown[] = []
    memberClient.on('event', (event) => missed.push(event))

    const toMember = next(memberClient, 'invalidate')
    await invalidate({ user: member.id }, [queryKeys.likes(), queryKeys.playlist('p1')])
    expect(await toMember).toEqual({ keys: [['likes'], ['playlists', 'p1']] })

    const event: ServerEvent = { type: 'scan.progress', rootId: '0190d3a6-0000-7000-8000-000000000000', phase: 'probing', processed: 1, total: 2 }
    const toAdmins = next(adminClient, 'event')
    await publish('admins', event)
    expect(await toAdmins).toEqual(event)

    const everyone = Promise.all([next(memberClient, 'invalidate'), next(adminClient, 'invalidate')])
    await invalidate('all', [queryKeys.home()])
    expect(await everyone).toEqual([{ keys: [['home']] }, { keys: [['home']] }])
    expect(missed).toEqual([])
  })

  it('delivers an event for a user and for admins once to an admin, who is in both rooms', async () => {
    const adminClient = await open({ token: admin.token })
    const memberClient = await open({ token: member.token })
    const received: ServerEvent[] = []
    const toMember: ServerEvent[] = []
    adminClient.on('event', (event) => received.push(event))
    memberClient.on('event', (event) => toMember.push(event))
    const event: ServerEvent = { type: 'import.updated', importId: '0190d3a6-0000-7000-8000-000000000001', status: 'processing' }
    await publish([{ user: admin.id }, 'admins'], event)
    // A marker sent after it: once it arrives, any duplicate would have too.
    const marker: ServerEvent = { ...event, status: 'completed' }
    const markerArrived = new Promise<void>((resolve) => adminClient.on('event', (next) => next.type === 'import.updated' && next.status === 'completed' && resolve()))
    await publish({ user: admin.id }, marker)
    await markerArrived
    expect(received).toEqual([event, marker])
    expect(toMember).toEqual([])
  })

  it('splits invalidations that do not fit in one notification', async () => {
    const client = await open({ token: member.token })
    const keys = Array.from({ length: 300 }, (_, index) => queryKeys.album(`0190d3a6-0000-7000-8000-${String(index).padStart(12, '0')}`))
    const received: (readonly unknown[])[] = []
    // Resolves on the notification that completes the set, however long the round trips
    // through Postgres take; keys that never arrive fail the test at its timeout.
    const all = new Promise<void>((resolve) => client.on('invalidate', (update) => {
      received.push(...update.keys)
      if (received.length >= keys.length) resolve()
    }))
    await invalidate({ user: member.id }, keys)
    await all
    expect(received).toEqual(keys)
  })

  it('delivers changes to the target only, splitting large ones, and drops the cached reads they make stale', async () => {
    const memberClient = await open({ token: member.token })
    const adminClient = await open({ token: admin.token })
    const toAdmin: EntityChange[] = []
    adminClient.on('changes', (update) => toAdmin.push(...update.changes))
    const id = (n: number) => `0190d3a6-0000-7000-8000-${String(n).padStart(12, '0')}`

    const patched = next(memberClient, 'changes')
    await publishChanges({ user: member.id }, [{ kind: 'patch', entity: 'track', id: id(1), fields: { liked: true } }])
    expect(await patched).toEqual({ changes: [{ kind: 'patch', entity: 'track', id: id(1), fields: { liked: true } }] })

    // Availability of a whole box set reaches everyone, cut to fit in notifications.
    const tracks = Array.from({ length: 300 }, (_, index) => ({ id: id(index), availability: 'server' as const }))
    const received: string[] = []
    const all = new Promise<void>((resolve) => memberClient.on('changes', (update) => {
      for (const change of update.changes) if (change.kind === 'availability') received.push(...change.tracks.map((track) => track.id))
      if (received.length >= tracks.length) resolve()
    }))
    await publishChanges('all', [{ kind: 'availability', tracks, albums: [] }])
    await all
    expect(received).toEqual(tracks.map((track) => track.id))
    // The admin never saw the member's patch.
    expect(toAdmin.some((change) => change.kind === 'patch')).toBe(false)
  })

  it('names the cached reads a change makes stale', () => {
    expect(changeKeys([{ kind: 'deleted', entity: 'playlist', ids: ['p1'] }])).toEqual([queryKeys.playlist('p1'), queryKeys.playlists()])
    expect(changeKeys([{ kind: 'updated', entity: 'album', ids: ['a1'] }])).toEqual([queryKeys.album('a1')])
    const availability = changeKeys([{ kind: 'availability', tracks: [], albums: [] }]).map((key) => key[0])
    expect(availability).toEqual(expect.arrayContaining(['album', 'artist', 'library', 'home', 'playlists']))
    expect(availability).not.toContain('search')
  })

  it('answers time:sync with the server clock', async () => {
    const client = await open({ token: member.token })
    const before = Date.now()
    const reply = await client.emitWithAck('time:sync', 1234)
    expect(reply.clientTime).toBe(1234)
    expect(reply.serverTime).toBeGreaterThanOrEqual(before)
    expect(reply.serverTime).toBeLessThanOrEqual(Date.now())
  })

  it('disconnects the sockets of a revoked session', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'member', password: 'member password' } })
    const other = await open({ token: member.token })
    const leaving = await open({ token: login.json().token })
    const closed = new Promise((resolve) => leaving.once('disconnect', resolve))
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { authorization: `Bearer ${login.json().token}` } })
    await closed
    expect(other.connected).toBe(true)

    const all = new Promise((resolve) => other.once('disconnect', resolve))
    await disconnectSockets(member.id)
    await all
  })
})
