import { SessionHello } from '@squirmy/contracts'
import { tokenBucket } from '../../lib/token-bucket.js'
import type { Realtime } from '../../realtime/index.js'
import { applyReport, applySignal, attach, detach, emitDevices, greet, leave, noteSeen, runCommand, setRealtimeServer, sync } from './service.js'

/**
 * Per-socket budgets. A user's events run one at a time, so one socket flooding them
 * would hold up every device of the user. A person tapping fast stays well inside the
 * command budget; clients report every 10 seconds and on engine changes, and say hello
 * once per connection, and say what they play once or twice a track. Detaching and attaching share one budget: each writes to the
 * database and copies a whole session, and a person moves a device now and then. A sync
 * sends a whole session, like a hello, and is only asked for when queue operations did
 * not apply, which should be rare.
 */
const budgets = {
  command: { capacity: 40, perSecond: 20 },
  report: { capacity: 20, perSecond: 5 },
  signal: { capacity: 10, perSecond: 1 },
  hello: { capacity: 5, perSecond: 0.2 },
  move: { capacity: 10, perSecond: 0.5 },
  sync: { capacity: 5, perSecond: 0.2 },
}

/** Registers the `session:*` socket events. Each socket speaks for one device, named in its hello. */
export function registerSessionSockets(realtime: Realtime): void {
  setRealtimeServer(realtime.io)
  realtime.onConnection((socket) => {
    const { userId } = socket.data
    let deviceId: string | null = null
    const commands = tokenBucket(budgets.command)
    const reports = tokenBucket(budgets.report)
    const signals = tokenBucket(budgets.signal)
    const hellos = tokenBucket(budgets.hello)
    const moves = tokenBucket(budgets.move)
    const syncs = tokenBucket(budgets.sync)

    socket.on('session:hello', (raw, ack) => {
      const hello = SessionHello.safeParse(raw)
      // An unanswered hello times out on the client, which retries.
      if (!hello.success || typeof ack !== 'function' || !hellos.take()) return
      if (deviceId && deviceId !== hello.data.device.id) leave(userId, socket.id, deviceId)
      deviceId = hello.data.device.id
      void greet(userId, socket.id, hello.data, (reply) => {
        ack(reply)
        emitDevices(userId, socket.id)
      })
    })
    socket.on('session:command', (raw, ack) => {
      if (typeof ack !== 'function') return
      if (!commands.take()) return ack({ ok: false, error: 'rate_limited' })
      noteSeen(userId, deviceId)
      void runCommand(userId, deviceId, raw, ack)
    })
    // A dropped report costs nothing: the next one carries the same information.
    socket.on('session:report', (raw) => {
      if (!reports.take()) return
      noteSeen(userId, deviceId)
      void applyReport(userId, deviceId, raw)
    })
    // Sent when what the device plays changes, at most a few times a track: past the budget, dropped.
    socket.on('session:signal', (raw) => {
      if (!signals.take()) return
      noteSeen(userId, deviceId)
      void applySignal(userId, deviceId, raw)
    })
    // Answered rather than dropped, unlike a hello: the client would otherwise wait out its timeout.
    socket.on('session:detach', (raw, ack) => {
      if (typeof ack !== 'function') return
      if (!moves.take()) return ack({ ok: false, error: 'rate_limited' })
      noteSeen(userId, deviceId)
      void detach(userId, deviceId, socket.id, raw, ack)
    })
    socket.on('session:attach', (raw, ack) => {
      if (typeof ack !== 'function') return
      if (!moves.take()) return ack({ ok: false, error: 'rate_limited' })
      noteSeen(userId, deviceId)
      void attach(userId, deviceId, socket.id, raw, ack)
    })
    // Refused rather than dropped: the client tries again a few seconds later.
    socket.on('session:sync', (_raw, ack) => {
      if (typeof ack !== 'function') return
      if (!syncs.take()) return ack({ ok: false, error: 'rate_limited' })
      noteSeen(userId, deviceId)
      void sync(userId, deviceId, ack)
    })
    // An answer to the heartbeat is the device saying it is there. Without it a tab left
    // open and untouched would be listed as "Active 6 min ago", which reads as gone.
    socket.conn.on('heartbeat', () => noteSeen(userId, deviceId))
    socket.on('disconnect', () => {
      if (deviceId) leave(userId, socket.id, deviceId)
    })
  })
}
