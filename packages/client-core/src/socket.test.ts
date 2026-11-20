import type { ClientToServerEvents, EngineReport, ServerToClientEvents } from '@squirmy/contracts'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from 'socket.io'
import { io } from 'socket.io-client'
import { afterEach, describe, expect, it } from 'vitest'
import { createInitialSession, splitSession } from './session/reducer.js'
import { createSocketTransport } from './socket.js'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo()
})

async function start() {
  const http = createServer()
  const server = new Server<ClientToServerEvents, ServerToClientEvents>(http)
  const reports: EngineReport[] = []
  server.on('connection', socket => {
    socket.on('time:sync', (clientTime, ack) => ack({ clientTime, serverTime: 42 }))
    socket.on('session:command', (_envelope, ack) => {
      ack({ ok: true, version: 2 })
      socket.emit('session:state', { version: 2, state: splitSession(createInitialSession()).state })
    })
    socket.on('session:report', report => void reports.push(report))
    // Never acked, to exercise the timeout.
    socket.on('session:hello', () => undefined)
  })
  await new Promise<void>(resolve => http.listen(0, resolve))
  cleanup.push(() => {
    void server.close()
  })
  return { url: `http://localhost:${(http.address() as AddressInfo).port}`, reports }
}

describe.each(['websocket', 'polling'])('createSocketTransport over %s', mode => {
  it('connects, acks in order with events, reports and times out', async () => {
    const { url, reports } = await start()
    const socket = io(url, { transports: [mode], forceNew: true })
    cleanup.push(() => socket.close())
    const transport = createSocketTransport(socket)

    await new Promise<void>(resolve => {
      const off = transport.onConnectionChange(connected => connected && (off(), resolve()))
    })
    expect(transport.isConnected()).toBe(true)

    const clock = await new Promise(resolve => transport.request('time:sync', 7, 1000, (error, reply) => resolve({ error, reply })))
    expect(clock).toEqual({ error: null, reply: { clientTime: 7, serverTime: 42 } })

    const order: string[] = []
    const stateArrived = new Promise<void>(resolve => {
      transport.on('session:state', () => {
        order.push('state')
        resolve()
      })
    })
    transport.request('session:command', { commandId: 'c1', command: { type: 'pause' } }, 1000, (_error, ack) => {
      order.push(`ack ${JSON.stringify(ack)}`)
    })
    await stateArrived
    expect(order).toEqual(['ack {"ok":true,"version":2}', 'state'])

    transport.report({ entryId: 'e', status: 'playing', positionMs: 1, at: 2 })
    const timedOut = await new Promise<Error | null>(resolve => transport.request(
      'session:hello',
      { device: { id: 'device-01', name: 'Test', kind: 'other' }, canPlay: false },
      100,
      error => resolve(error),
    ))
    expect(timedOut).toBeInstanceOf(Error)
    expect(reports).toEqual([{ entryId: 'e', status: 'playing', positionMs: 1, at: 2 }])

    const disconnected = new Promise<boolean>(resolve => transport.onConnectionChange(resolve))
    socket.disconnect()
    expect(await disconnected).toBe(false)
  })
})
