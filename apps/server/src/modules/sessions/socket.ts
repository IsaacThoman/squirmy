import { SessionHello } from '@squirmy/contracts'
import type { Realtime } from '../../realtime/index.js'
import { applyReport, greet, leave, runCommand, setRealtimeServer } from './service.js'

/** Registers the `session:*` socket events. Each socket speaks for one device, named in its hello. */
export function registerSessionSockets(realtime: Realtime): void {
  setRealtimeServer(realtime.io)
  realtime.onConnection((socket) => {
    const { userId } = socket.data
    let deviceId: string | null = null

    socket.on('session:hello', (raw, ack) => {
      const hello = SessionHello.safeParse(raw)
      if (!hello.success || typeof ack !== 'function') return
      if (deviceId && deviceId !== hello.data.device.id) leave(userId, socket.id, deviceId)
      deviceId = hello.data.device.id
      void greet(userId, socket.id, hello.data, (reply) => {
        ack(reply)
        socket.to(`user:${userId}`).emit('devices', reply.devices)
      })
    })
    socket.on('session:command', (raw, ack) => {
      if (typeof ack === 'function') void runCommand(userId, deviceId, raw, ack)
    })
    socket.on('session:report', (raw) => void applyReport(userId, deviceId, raw))
    socket.on('disconnect', () => {
      if (deviceId) leave(userId, socket.id, deviceId)
    })
  })
}
