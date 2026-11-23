import { RealtimeBatch } from '@squirmy/client-core'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, queryKeys, type EntityChanges, type ServerEvent } from '@squirmy/contracts'
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

/** A socket that has heard no ping for this long is dead, whatever it believes: the server pings every few seconds. */
export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS

/**
 * One socket.io connection for the signed-in user, authenticated by the session cookie.
 * `invalidate` messages refresh the matching queries and `changes` patch the entities they
 * name where they are cached (see `applyChanges`), both collected for `BATCH_MS` first;
 * `event` messages go to `useServerEvent` subscribers, and the socket itself is shared
 * through the context so the session client can run on the same connection.
 *
 * The socket is also what lists this tab among the user's devices (see "Presence" in the
 * session contract), so it follows the page's lifecycle: closed at once when the page goes
 * away or the browser freezes it, rather than left for the server to notice the silence,
 * and opened again when the page comes back. A tab that is only hidden stays connected
 * and answers the server's pings from the socket's message handler, which browsers do not
 * throttle the way they throttle timers, so it stays listed while it can still play.
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
    // Closed (tab closed, navigated away, or into the back/forward cache) or frozen to save
    // power: the page can answer nothing until it is back, so it leaves the list now.
    let parked = false
    const park = () => {
      parked = true
      socket.disconnect()
    }
    const unpark = () => {
      if (!parked) return
      parked = false
      socket.connect()
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) unpark()
    }
    // After a laptop sleeps, the socket can believe it is open long after the server closed
    // it; socket.io's own check runs on a timer that a sleeping or hidden page runs late.
    let lastHeard = Date.now()
    const heard = () => {
      lastHeard = Date.now()
    }
    const recheck = () => {
      if (document.visibilityState !== 'visible' || !socket.connected || Date.now() - lastHeard <= STALE_AFTER_MS) return
      socket.disconnect()
      socket.connect()
    }
    socket.on('connect', onConnect)
    socket.on('connect', heard)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    socket.on('invalidate', onInvalidate)
    socket.on('changes', onChanges)
    socket.on('event', onEvent)
    socket.io.on('ping', heard)
    addEventListener('pagehide', park)
    addEventListener('pageshow', onPageShow)
    document.addEventListener('freeze', park)
    document.addEventListener('resume', unpark)
    document.addEventListener('visibilitychange', recheck)
    addEventListener('online', recheck)
    socket.connect()
    return () => {
      clearTimeout(retry)
      removeEventListener('pagehide', park)
      removeEventListener('pageshow', onPageShow)
      document.removeEventListener('freeze', park)
      document.removeEventListener('resume', unpark)
      document.removeEventListener('visibilitychange', recheck)
      removeEventListener('online', recheck)
      socket.io.off('ping', heard)
      socket.off('connect', heard)
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
