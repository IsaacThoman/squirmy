import type { ClientToServerEvents, EngineReport, ServerToClientEvents, SignalReport } from '@squirmy/contracts'

/** Client-to-server events that expect an ack. */
export type AckEvent = 'session:hello' | 'time:sync' | 'session:command' | 'session:detach' | 'session:attach' | 'session:sync' | 'session:jam'
export type AckPayload<E extends AckEvent> = Parameters<ClientToServerEvents[E]>[0]
export type AckReply<E extends AckEvent> = Parameters<Parameters<ClientToServerEvents[E]>[1]>[0]
export type AckCallback<E extends AckEvent> = (error: Error | null, reply?: AckReply<E>) => void

/**
 * The connection `SessionClient` talks through. `createSocketTransport` (from
 * `@squirmy/client-core/socket`) adapts a socket.io-client socket; tests use a fake.
 */
export interface SessionTransport {
  isConnected(): boolean
  /** Called with true on every (re)connect and false on every disconnect. Returns an unsubscribe function. */
  onConnectionChange(listener: (connected: boolean) => void): () => void
  /**
   * Emits `event` and calls `callback` once: with the server's ack, or with an error when
   * none arrives within `timeoutMs`. Only called while connected.
   *
   * The callback must run synchronously when the ack is received, in order with server
   * events (not deferred through a promise): the client relies on seeing a command's ack
   * before the `session:state` that includes it.
   */
  request<E extends AckEvent>(event: E, payload: AckPayload<E>, timeoutMs: number, callback: AckCallback<E>): void
  /** Fire-and-forget engine report. Only called while connected. */
  report(report: EngineReport): void
  /** Fire-and-forget signal path (`session:signal`). Only called while connected, to a server with the `signal` capability. */
  signal(report: SignalReport): void
  /** Subscribes to a server event. Returns an unsubscribe function. */
  on<E extends keyof ServerToClientEvents>(event: E, listener: ServerToClientEvents[E]): () => void
}
