import { queryKeys, type ServerEvent } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSocketFactory } from '@/api/services'
import { RealtimeContext, type Realtime } from './realtime-context'

/** How long the socket may be down before the shell says so; brief blips stay invisible. */
export const DOWN_AFTER_MS = 3000
/** Retry delay after the server refused the handshake, which socket.io does not retry itself. */
const REFUSED_RETRY_MS = 5000

/**
 * One socket.io connection for the signed-in user, authenticated by the session cookie.
 * `invalidate` messages refresh the matching queries, `event` messages go to
 * `useServerEvent` subscribers, and the socket itself is shared through the context so the
 * session client can run on the same connection.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const createSocket = useSocketFactory()
  const queryClient = useQueryClient()
  const [socket] = useState(createSocket)
  const [connected, setConnected] = useState(false)
  const [down, setDown] = useState(false)
  const [listeners] = useState(() => new Set<(event: ServerEvent) => void>())

  useEffect(() => {
    let everConnected = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const recheckSession = () => queryClient.invalidateQueries({ queryKey: queryKeys.me(), exact: true })
    const onConnect = () => {
      setConnected(true)
      setDown(false)
      // Anything could have changed while the connection was down.
      if (everConnected) void queryClient.invalidateQueries()
      everConnected = true
    }
    const onDisconnect = (reason: string) => {
      setConnected(false)
      // The server closes sockets whose session changed (role, password, disabled). Recheck
      // the session; reconnecting then either succeeds or is refused and signs out.
      if (reason === 'io server disconnect') {
        void recheckSession()
        socket.connect()
      }
    }
    const onConnectError = () => {
      if (socket.active) return
      void recheckSession()
      retry = setTimeout(() => socket.connect(), REFUSED_RETRY_MS)
    }
    const onInvalidate = ({ keys }: { keys: readonly (readonly unknown[])[] }) => {
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey })
    }
    const onEvent = (event: ServerEvent) => {
      for (const listener of [...listeners]) listener(event)
    }
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    socket.on('invalidate', onInvalidate)
    socket.on('event', onEvent)
    socket.connect()
    return () => {
      clearTimeout(retry)
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)
      socket.off('invalidate', onInvalidate)
      socket.off('event', onEvent)
      socket.disconnect()
    }
  }, [socket, queryClient, listeners])

  useEffect(() => {
    if (connected) return
    const timer = setTimeout(() => setDown(true), DOWN_AFTER_MS)
    return () => clearTimeout(timer)
  }, [connected])

  const value = useMemo<Realtime>(() => ({
    socket,
    connected,
    down,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }), [socket, connected, down, listeners])

  return <RealtimeContext value={value}>{children}</RealtimeContext>
}
