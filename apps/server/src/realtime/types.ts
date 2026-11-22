import type { ClientToServerEvents, ServerToClientEvents } from '@squirmy/contracts'
import type { Server, Socket } from 'socket.io'
import type { UserRole } from '../database/schema.js'

/** Set on every socket once its session token has been verified. `expiresAt` is the session's expiry then, in epoch ms. */
export type SocketData = { userId: string; role: UserRole; authSessionId: string; expiresAt: number }

export type RealtimeServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>
export type RealtimeSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>

/** Who an event goes to. */
export type RealtimeTarget = { user: string } | 'admins' | 'all'

/** What a module receives in its `realtime` hook. */
export interface Realtime {
  io: RealtimeServer
  /** Runs for every authenticated socket, after it has joined its rooms. */
  onConnection(handler: (socket: RealtimeSocket) => void | Promise<void>): void
}
