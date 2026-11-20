import type { ClientToServerEvents, ServerToClientEvents } from '@squirmy/contracts'
import type { Socket } from 'socket.io-client'
import type { AckCallback, AckEvent, AckPayload, AckReply, SessionTransport } from './session/transport.js'

/** A socket.io-client socket typed with the session protocol. */
export type SquirmySocket = Socket<ServerToClientEvents, ClientToServerEvents>

/**
 * Adapts a socket.io-client socket to `SessionTransport`. The caller creates and
 * connects the socket (with `auth: { token }` for native clients) and owns its lifetime.
 */
export function createSocketTransport(socket: SquirmySocket): SessionTransport {
  return {
    isConnected: () => socket.connected,
    onConnectionChange(listener) {
      const up = () => listener(true)
      const down = () => listener(false)
      socket.on('connect', up)
      socket.on('disconnect', down)
      return () => {
        socket.off('connect', up)
        socket.off('disconnect', down)
      }
    },
    request<E extends AckEvent>(event: E, payload: AckPayload<E>, timeoutMs: number, callback: AckCallback<E>) {
      // socket.io's typings cannot follow a generic event name through `emit`. A plain
      // callback (not `emitWithAck`) runs in order with the events that follow the ack.
      const timed = socket.timeout(timeoutMs) as unknown as {
        emit(event: E, payload: AckPayload<E>, ack: (error: Error | null, reply: AckReply<E>) => void): void
      }
      timed.emit(event, payload, (error, reply) => (error ? callback(error) : callback(null, reply)))
    },
    report: report => void socket.emit('session:report', report),
    on(event, listener) {
      socket.on(event, listener as never)
      return () => void socket.off(event, listener as never)
    },
  }
}
