import type { SquirmySocket } from '@squirmy/client-core/socket';
import { queryKeys } from '@squirmy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { io } from 'socket.io-client';
import { useAccount } from '../account/AccountProvider';
import { socketAddress } from '../account/address';
import { Echoes } from './echoes';
import { offlineAt, type SocketLink } from './reachability';
import { refreshAfterReconnect } from './reconnect';

type Keys = readonly (readonly unknown[])[];
/** `own`: the echo of a change this device made, whose result it already shows. */
type InvalidateListener = (keys: Keys, info: { own: boolean }) => void;

type Realtime = {
  /** The signed-in user's socket, shared with the session client. Null while signed out. */
  socket: SquirmySocket | null;
  /**
   * The socket has been down for a few seconds and no request since was answered; only
   * downloads play. False while signed out.
   */
  offline: boolean;
  /** Calls `listener` with the keys of every `invalidate` the server sends. */
  onInvalidate: (listener: InvalidateListener) => () => void;
  /**
   * A request this device sends will make the server invalidate `key`. Its echo only marks
   * the cached data stale: the caller has already updated it.
   */
  expectEcho: (key: readonly unknown[]) => void;
};

/** Retry delay after the server refused the handshake, which socket.io does not retry itself. */
const refusedRetryMs = 5000;
/** The server pings every 25 seconds; a socket silent for longer was suspended with the app. */
const staleAfterMs = 30_000;

const RealtimeContext = createContext<Realtime>({
  socket: null, offline: false, onInvalidate: () => () => undefined, expectEcho: () => undefined,
});

/**
 * One socket.io connection while signed in, authenticated with the session token.
 * `invalidate` messages refresh the matching queries; a reconnect refreshes what is on
 * screen, since messages may have been missed meanwhile. The connection is renewed when the app returns from being suspended and when
 * the network changes, since iOS drops sockets silently in both cases. While it stays
 * down the app is offline, unless the server answers requests meanwhile (`offlineAt`):
 * a cold start's first connection can take seconds while requests already succeed.
 */
export function RealtimeProvider({ children }: PropsWithChildren) {
  const { state, reach } = useAccount();
  const queryClient = useQueryClient();
  const serverUrl = state.status === 'signedIn' ? state.server.url : null;
  const token = state.status === 'signedIn' ? state.token : null;
  const [socket, setSocket] = useState<SquirmySocket | null>(null);
  const [offline, setOffline] = useState(false);
  const [listeners] = useState(() => new Set<InvalidateListener>());
  const [echoes] = useState(() => new Echoes());

  useEffect(() => {
    if (!serverUrl || !token) return;
    const { origin, path } = socketAddress(serverUrl);
    // WebSocket first; long-polling when it cannot open, e.g. behind a proxy that does not
    // pass on the upgrade. The web app gets the same fallback from socket.io's defaults.
    const next: SquirmySocket = io(origin, {
      path, auth: { token }, transports: ['websocket', 'polling'], tryAllTransports: true, autoConnect: false,
    });
    let link: SocketLink = { connected: false, downSince: Date.now(), everConnected: false };
    let lastHeard = Date.now();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let goingOffline: ReturnType<typeof setTimeout> | undefined;
    const heard = () => { lastHeard = Date.now(); };
    // Runs whenever the socket or a request says something new, and again when the wait runs out.
    const updateOffline = () => {
      clearTimeout(goingOffline);
      const at = offlineAt(link, reach);
      const wait = at === null ? null : at - Date.now();
      setOffline(wait !== null && wait <= 0);
      if (wait !== null && wait > 0) goingOffline = setTimeout(updateOffline, wait);
    };
    // A refused handshake usually means the session ended; asking for `me` lets a 401 sign out.
    const recheckSession = () => void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
    const renew = () => {
      next.disconnect();
      next.connect();
    };

    next.on('connect', () => {
      heard();
      if (link.everConnected) void refreshAfterReconnect(queryClient);
      link = { ...link, connected: true, everConnected: true };
      updateOffline();
    });
    next.on('disconnect', reason => {
      link = { ...link, connected: false, downSince: Date.now() };
      updateOffline();
      if (reason === 'io server disconnect') {
        recheckSession();
        next.connect();
      }
    });
    next.on('connect_error', () => {
      if (next.active) return;
      recheckSession();
      clearTimeout(retry);
      retry = setTimeout(() => next.connect(), refusedRetryMs);
    });
    next.on('invalidate', ({ keys }) => {
      const own = echoes.isOwn(keys);
      // Stale either way, so the next screen to show the data refetches it; only another
      // device's change is refetched at once.
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey, refetchType: own ? 'none' : 'active' });
      for (const listener of [...listeners]) listener(keys, { own });
    });
    next.io.on('ping', heard);

    const app = AppState.addEventListener('change', status => {
      if (status !== 'active') return;
      if (!next.connected) next.connect();
      else if (Date.now() - lastHeard > staleAfterMs) renew();
    });
    let networkType: Network.NetworkStateType | undefined;
    const network = Network.addNetworkStateListener(({ type, isConnected }) => {
      const changed = networkType !== undefined && type !== networkType;
      networkType = type;
      if (!isConnected) return;
      if (!next.connected) next.connect();
      else if (changed) renew();
    });

    const answers = reach.subscribe(updateOffline);
    updateOffline();
    next.connect();
    setSocket(next);
    return () => {
      clearTimeout(retry);
      clearTimeout(goingOffline);
      setOffline(false);
      answers();
      app.remove();
      network.remove();
      next.removeAllListeners();
      next.io.off('ping', heard);
      next.disconnect();
      setSocket(null);
    };
  }, [echoes, listeners, queryClient, reach, serverUrl, token]);

  const value = useMemo<Realtime>(() => ({
    socket,
    offline,
    onInvalidate: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    expectEcho: echoes.expect,
  }), [echoes, listeners, offline, socket]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): Realtime {
  return useContext(RealtimeContext);
}
