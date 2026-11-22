import { SessionHello } from '@squirmy/contracts'
import { tokenBucket } from '../../lib/token-bucket.js'
import type { Realtime } from '../../realtime/index.js'
import { applyReport, attach, detach, greet, leave, runCommand, setRealtimeServer } from './service.js'

/**
 * Per-socket budgets. A user's events run one at a time, so one socket flooding them
 * would hold up every device of the user. A person tapping fast stays well inside the
 * command budget; clients report every 10 seconds and on engine changes, and say hello
 * once per connection.
 */
const budgets = {
  command: { capacity: 40, perSecond: 20 },
  report: { capacity: 20, perSecond: 5 },
  hello: { capacity: 5, perSecond: 0.2 },
}

/** Registers the `session:*` socket events. Each socket speaks for one device, named in its hello. */
export function registerSessionSockets(realtime: Realtime): void {
  setRealtimeServer(realtime.io)
  realtime.onConnection((socket) => {
    const { userId } = socket.data
    let deviceId: string | null = null
    const commands = tokenBucket(budgets.command)
    const reports = tokenBucket(budgets.report)
    const hellos = tokenBucket(budgets.hello)

    socket.on('session:hello', (raw, ack) => {
      const hello = SessionHello.safeParse(raw)
      // An unanswered hello times out on the client, which retries.
      if (!hello.success || typeof ack !== 'function' || !hellos.take()) return
      if (deviceId && deviceId !== hello.data.device.id) leave(userId, socket.id, deviceId)
      deviceId = hello.data.device.id
      void greet(userId, socket.id, hello.data, (reply) => {
        ack(reply)
        socket.to(`user:${userId}`).emit('devices', reply.devices)
      })
    })
    socket.on('session:command', (raw, ack) => {
      if (typeof ack !== 'function') return
      if (!commands.take()) return ack({ ok: false, error: 'rate_limited' })
      void runCommand(userId, deviceId, raw, ack)
    })
    // A dropped report costs nothing: the next one carries the same information.
    socket.on('session:report', (raw) => void (reports.take() && applyReport(userId, deviceId, raw)))
    socket.on('session:detach', (raw, ack) => {
      if (typeof ack === 'function') void detach(userId, deviceId, socket.id, raw, ack)
    })
    socket.on('session:attach', (raw, ack) => {
      if (typeof ack === 'function') void attach(userId, deviceId, socket.id, raw, ack)
    })
    socket.on('disconnect', () => {
      if (deviceId) leave(userId, socket.id, deviceId)
    })
  })
}
