import type { SquirmySocket } from '@squirmy/client-core/socket'
import type { ServerEvent } from '@squirmy/contracts'
import { createContext, useContext, useEffect, useRef } from 'react'

export type Realtime = {
  /** The user's socket, for the session client to share. Null outside the signed-in routes. */
  socket: SquirmySocket | null
  connected: boolean
  /** Disconnected for longer than a brief blip. */
  down: boolean
  subscribe: (listener: (event: ServerEvent) => void) => () => void
}

const offline: Realtime = { socket: null, connected: false, down: false, subscribe: () => () => {} }

export const RealtimeContext = createContext<Realtime>(offline)

export function useRealtime(): Realtime {
  return useContext(RealtimeContext)
}

/** Calls `listener` for every server event of `type` while the component is mounted. */
export function useServerEvent<T extends ServerEvent['type']>(type: T, listener: (event: Extract<ServerEvent, { type: T }>) => void) {
  const { subscribe } = useRealtime()
  const latest = useRef(listener)
  useEffect(() => { latest.current = listener })
  useEffect(() => subscribe(event => {
    if (event.type === type) latest.current(event as Extract<ServerEvent, { type: T }>)
  }), [subscribe, type])
}
