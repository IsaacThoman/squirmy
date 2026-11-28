import { once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { PlaybackControl } from '@squirmy/contracts'
import { Aedes } from 'aedes'
import { connectAsync } from 'mqtt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { io, type Socket } from 'socket.io-client'
import { buildApp } from '../../app.js'
import { startRealtime } from '../../realtime/index.js'
import { signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum } from '../../test/factories.js'
import { sessionsModule } from '../sessions/index.js'
import { getSnapshot, playingDevices } from '../sessions/service.js'
import { MqttBridge } from './mqtt.js'

describe('MQTT bridge', () => {
  useTestDatabase()
  let app: Awaited<ReturnType<typeof buildApp>>
  let serverUrl: string
  let socket: Socket | undefined
  beforeAll(async () => {
    app = await buildApp()
    const realtime = await startRealtime(app)
    await sessionsModule.realtime!(realtime)
    serverUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  })
  afterAll(async () => {
    socket?.disconnect()
    await sessionsModule.stop?.()
    await app.close()
  })

  it('retains discovery and track state and applies non-retained control to the active device', async () => {
    const broker = await Aedes.createBroker()
    const server = createServer(broker.handle)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`
    const bridge = new MqttBridge({ url, topicPrefix: 'squirmy-test' })
    const client = await connectAsync(url)
    try {
      const user = await signIn()
      const { tracks } = await createAlbum({ owned: true })
      const deviceId = 'test-speaker'
      socket = io(serverUrl, { auth: { token: user.headers.authorization.slice('Bearer '.length) }, transports: ['websocket'] })
      await once(socket, 'connect')
      const hello = await socket.emitWithAck('session:hello', { device: { id: deviceId, name: 'Speaker', kind: 'web' }, canPlay: true })
      expect(hello.snapshot.state.playing).toBe(false)
      const ack = await socket.emitWithAck('session:command', {
        commandId: 'play-song', command: { type: 'playTracks', tracks: [{ trackId: tracks[0]!.recordingId }] },
      })
      expect(ack.ok).toBe(true)
      const topic = `squirmy-test/${user.id}/${Buffer.from(deviceId).toString('base64url')}`
      await viWait(async () => {
        await bridge.refresh(playingDevices())
        expect((await getSnapshot(user.id)).state.playing).toBe(true)
        expect(playingDevices()).toHaveLength(1)
      })
      const payloads = new Map<string, { payload: string; retained: boolean }>()
      client.on('message', (channel, data, packet) => payloads.set(channel, { payload: data.toString(), retained: packet.retain }))
      await client.subscribeAsync([`${topic}/state`, 'homeassistant/sensor/+/config'])
      await viWait(async () => {
        await bridge.refresh(playingDevices())
        const payload = payloads.get(`${topic}/state`)
        expect(payload).toBeDefined()
        expect(JSON.parse(payload!.payload)).toMatchObject({ state: 'playing', deviceId, title: tracks[0]!.title })
        expect([...payloads.keys()].some(channel => channel.startsWith('homeassistant/sensor/'))).toBe(true)
      })
      await client.unsubscribeAsync(`${topic}/state`)
      payloads.delete(`${topic}/state`)
      await client.subscribeAsync(`${topic}/state`)
      await viWait(() => expect(payloads.get(`${topic}/state`)?.retained).toBe(true))
      await client.publishAsync(`${topic}/command`, JSON.stringify(PlaybackControl.parse({ type: 'pause' })))
      await viWait(async () => expect((await getSnapshot(user.id)).state.playing).toBe(false))
      await client.publishAsync(`${topic}/command`, JSON.stringify({ type: 'volume', value: 0.4 }))
      await viWait(async () => expect((await getSnapshot(user.id)).state.volumes[deviceId]).toBe(0.4))
    } finally {
      await bridge.stop()
      await client.endAsync()
      await new Promise<void>(resolve => broker.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

const viWait = async (work: () => unknown | Promise<unknown>) => {
  const expires = Date.now() + 5000
  for (;;) {
    try {
      await work()
      return
    } catch (error) {
      if (Date.now() >= expires) throw error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}
