import type { SquirmySocket } from '@squirmy/client-core/socket';
import { queryKeys } from '@squirmy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { io } from 'socket.io-client';
import { useAccount } from '../account/AccountProvider';
import { socketAddress } from '../account/address';

type Keys = readonly (readonly unknown[])[];

type Realtime = {
  /** The signed-in user's socket, shared with the session client. Null while signed out. */
  socket: SquirmySocket | null;
  /** Calls `listener` with the keys of every `invalidate` the server sends. */
  onInvalidate: (listener: (keys: Keys) => void) => () => void;
};

/** Retry delay after the server refused the handshake, which socket.io does not retry itself. */
const refusedRetryMs = 5000;
/** The server pings every 25 seconds; a socket silent for longer was suspended with the app. */
const staleAfterMs = 30_000;

const RealtimeContext = createContext<Realtime>({ socket: null, onInvalidate: () => () => undefined });

/**
 * One socket.io connection while signed in, authenticated with the session token.
 * `invalidate` messages refresh the matching queries; every reconnect refreshes all of
 * them. The connection is renewed when the app returns from being suspended and when
 * the network changes, since iOS drops sockets silently in both cases.
 */
export function RealtimeProvider({ children }: PropsWithChildren) {
  const { state } = useAccount();
  const queryClient = useQueryClient();
  const serverUrl = state.status === 'signedIn' ? state.server.url : null;
  const token = state.status === 'signedIn' ? state.token : null;
  const [socket, setSocket] = useState<SquirmySocket | null>(null);
  const [listeners] = useState(() => new Set<(keys: Keys) => void>());

  useEffect(() => {
    if (!serverUrl || !token) return;
    const { origin, path } = socketAddress(serverUrl);
    const next: SquirmySocket = io(origin, { path, auth: { token }, transports: ['websocket'], autoConnect: false });
    let everConnected = false;
    let lastHeard = Date.now();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const heard = () => { lastHeard = Date.now(); };
    // A refused handshake usually means the session ended; asking for `me` lets a 401 sign out.
    const recheckSession = () => void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
    const renew = () => {
      next.disconnect();
      next.connect();
    };

    next.on('connect', () => {
      heard();
      if (everConnected) void queryClient.invalidateQueries();
      everConnected = true;
    });
    next.on('disconnect', reason => {
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
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
      for (const listener of [...listeners]) listener(keys);
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

    next.connect();
    setSocket(next);
    return () => {
      clearTimeout(retry);
      app.remove();
      network.remove();
      next.removeAllListeners();
      next.io.off('ping', heard);
      next.disconnect();
      setSocket(null);
    };
  }, [listeners, queryClient, serverUrl, token]);

  const value = useMemo<Realtime>(() => ({
    socket,
    onInvalidate: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }), [listeners, socket]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): Realtime {
  return useContext(RealtimeContext);
}
