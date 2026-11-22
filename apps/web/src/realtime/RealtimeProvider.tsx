import { RealtimeBatch } from '@squirmy/client-core'
import { queryKeys, type EntityChanges, type ServerEvent } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSocketFactory } from '@/api/services'
import { applyChanges } from './apply-changes'
import { RealtimeContext, type Realtime } from './realtime-context'

/** How long the socket may be down before the shell says so; brief blips stay invisible. */
export const DOWN_AFTER_MS = 3000
/** Retry delay after the server refused the handshake, which socket.io does not retry itself. */
const REFUSED_RETRY_MS = 5000
/**
 * How long invalidations and changes are collected before they are applied: a scan or an
 * album arriving track by track sends many, and each query is refetched once per batch.
 */
export const BATCH_MS = 100

/**
 * One socket.io connection for the signed-in user, authenticated by the session cookie.
 * `invalidate` messages refresh the matching queries and `changes` patch the entities they
 * name where they are cached (see `applyChanges`), both collected for `BATCH_MS` first;
 * `event` messages go to `useServerEvent` subscribers, and the socket itself is shared
 * through the context so the session client can run on the same connection.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const createSocket = useSocketFactory()
  const queryClient = useQueryClient()
  const [socket] = useState(createSocket)
  const [connected, setConnected] = useState(false)
  const [down, setDown] = useState(false)
  const [listeners] = useState(() => new Set<(event: ServerEvent) => void>())

  useEffect(() => {
    const batch = new RealtimeBatch(({ keys, changes }) => {
      // Patches first: a list refetched in the same batch then starts from patched rows.
      if (changes.length > 0) applyChanges(queryClient, changes)
      for (const queryKey of keys.get('refetch') ?? []) void queryClient.invalidateQueries({ queryKey })
    }, BATCH_MS)
    let everConnected = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const recheckSession = () => queryClient.invalidateQueries({ queryKey: queryKeys.me(), exact: true })
    const onConnect = () => {
      setConnected(true)
      setDown(false)
      // Anything could have changed while the connection was down.
      if (everConnected) {
        batch.clear()
        void queryClient.invalidateQueries()
      }
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
    const onInvalidate = ({ keys }: { keys: readonly (readonly unknown[])[] }) => batch.invalidate(keys)
    const onChanges = ({ changes }: EntityChanges) => batch.change(changes)
    const onEvent = (event: ServerEvent) => {
      for (const listener of [...listeners]) listener(event)
    }
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    socket.on('invalidate', onInvalidate)
    socket.on('changes', onChanges)
    socket.on('event', onEvent)
    socket.connect()
    return () => {
      clearTimeout(retry)
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)
      socket.off('invalidate', onInvalidate)
      socket.off('changes', onChanges)
      socket.off('event', onEvent)
      batch.clear()
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
