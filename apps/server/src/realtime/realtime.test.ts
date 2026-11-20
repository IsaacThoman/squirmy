import type { AddressInfo } from 'node:net'
import { queryKeys, type ClientToServerEvents, type ServerEvent, type ServerToClientEvents } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { io as connect, type Socket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { useTestDatabase } from '../test/database.js'
import { disconnectSockets, invalidate, publish, startRealtime } from './index.js'
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

  function open(options: { token?: string; cookie?: string } = {}): Promise<Client> {
    const client: Client = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      auth: options.token ? { token: options.token } : {},
      extraHeaders: options.cookie ? { cookie: options.cookie } : undefined,
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
