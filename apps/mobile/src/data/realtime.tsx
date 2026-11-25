import { planChanges, RealtimeBatch, type ChangePlan } from '@squirmy/client-core';
import type { SquirmySocket } from '@squirmy/client-core/socket';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, queryKeys, type EntityChange, type ServerEvent } from '@squirmy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { io } from 'socket.io-client';
import { useAccount } from '../account/AccountProvider';
import { socketAddress } from '../account/address';
import { applyChanges } from './changes';
import { Echoes } from './echoes';
import { BackgroundPresence } from './presence';
import { offlineAt, type SocketLink } from './reachability';
import { refreshAfterReconnect } from './reconnect';
import { scanRoots, scanTotal, type ScanProgress, type ScanRoots } from './scanProgress';

type Keys = readonly (readonly unknown[])[];
/** `own`: the echo of a change this device made, whose result it already shows. */
type InvalidateListener = (keys: Keys, info: { own: boolean }) => void;
/** Called after the cache took the changes in, with what they set. */
type ChangesListener = (plan: ChangePlan, info: { own: boolean }) => void;

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
  /** Calls `listener` for every batch of `changes` the server sends, once the cache has them. */
  onChanges: (listener: ChangesListener) => () => void;
  /**
   * A request this device sends will make the server invalidate `key`. Its echo only marks
   * the cached data stale: the caller has already updated it.
   */
  expectEcho: (key: readonly unknown[]) => void;
  /**
   * Whether this phone plays the session now. In the background the socket stays open only
   * while it does (see `BackgroundPresence`).
   */
  setPlayingHere: (playing: boolean) => void;
};

/** Retry delay after the server refused the handshake, which socket.io does not retry itself. */
const refusedRetryMs = 5000;
/** The server pings every few seconds; a socket that heard none for longer than it waits for an answer was suspended with the app. */
const staleAfterMs = HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS;

const RealtimeContext = createContext<Realtime>({
  socket: null, offline: false, onInvalidate: () => () => undefined, onChanges: () => () => undefined, expectEcho: () => undefined, setPlayingHere: () => undefined,
});

/** How long invalidations are collected, so a burst refetches each query once. */
const batchMs = 100;

/**
 * One socket.io connection while signed in, authenticated with the session token.
 * `invalidate` messages refresh the matching queries (collected for `batchMs`), and
 * `changes` patch the entities they name where they are cached; a reconnect refreshes what is on
 * screen, since messages may have been missed meanwhile. The connection is renewed when the app returns from being suspended and when
 * the network changes, since iOS drops sockets silently in both cases. While it stays
 * down the app is offline, unless the server answers requests meanwhile (`offlineAt`):
 * a cold start's first connection can take seconds while requests already succeed. In the
 * background with nothing playing here it is closed on purpose (`BackgroundPresence`),
 * which is not offline.
 */
export function RealtimeProvider({ children }: PropsWithChildren) {
  const { state, reach } = useAccount();
  const queryClient = useQueryClient();
  const serverUrl = state.status === 'signedIn' ? state.server.url : null;
  const token = state.status === 'signedIn' ? state.token : null;
  const [socket, setSocket] = useState<SquirmySocket | null>(null);
  const [offline, setOffline] = useState(false);
  const [listeners] = useState(() => new Set<InvalidateListener>());
  const [changeListeners] = useState(() => new Set<ChangesListener>());
  const [echoes] = useState(() => new Echoes());
  const playingHere = useRef(false);
  const presence = useRef<BackgroundPresence | null>(null);
  const [setPlayingHere] = useState(() => (playing: boolean) => {
    playingHere.current = playing;
    presence.current?.setPlaying(playing);
  });

  useEffect(() => {
    if (!serverUrl || !token) return;
    const { origin, path } = socketAddress(serverUrl);
    // WebSocket first; long-polling when it cannot open, e.g. behind a proxy that does not
    // pass on the upgrade. The web app gets the same fallback from socket.io's defaults.
    const next: SquirmySocket = io(origin, {
      path, auth: { token }, transports: ['websocket', 'polling'], tryAllTransports: true, autoConnect: false,
    });
    // Stale either way, so the next screen to show the data refetches it; only another
    // device's change is refetched at once.
    const batch = new RealtimeBatch<'own' | 'others'>(({ keys }) => {
      for (const queryKey of keys.get('own') ?? []) void queryClient.invalidateQueries({ queryKey, refetchType: 'none' });
      for (const queryKey of keys.get('others') ?? []) void queryClient.invalidateQueries({ queryKey, refetchType: 'active' });
    }, batchMs);
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
    const parking = new BackgroundPresence(next, AppState.currentState !== 'background');
    parking.setPlaying(playingHere.current);
    presence.current = parking;

    next.on('connect', () => {
      heard();
      if (link.everConnected) {
        batch.clear();
        void refreshAfterReconnect(queryClient);
      }
      link = { ...link, connected: true, everConnected: true };
      updateOffline();
    });
    next.on('disconnect', reason => {
      // Closed on purpose in the background: nobody is looking, and it opens on return.
      if (parking.parked) return;
      link = { ...link, connected: false, downSince: Date.now() };
      updateOffline();
      if (reason === 'io server disconnect') {
        recheckSession();
        next.connect();
      }
    });
    next.on('connect_error', () => {
      if (next.active || parking.parked) return;
      recheckSession();
      clearTimeout(retry);
      retry = setTimeout(() => {
        if (!parking.parked) next.connect();
      }, refusedRetryMs);
    });
    next.on('invalidate', ({ keys }) => {
      const own = echoes.isOwn(keys);
      batch.invalidate(keys, own ? 'own' : 'others');
      for (const listener of [...listeners]) listener(keys, { own });
    });
    next.on('changes', ({ changes }: { changes: EntityChange[] }) => {
      // A like or save made here comes back as a patch of that item.
      const own = echoes.isOwn(changes.flatMap(change => change.kind === 'patch' ? [[change.entity, change.id]] : []));
      const plan = planChanges(changes);
      applyChanges(queryClient, plan, { own });
      for (const listener of [...changeListeners]) listener(plan, { own });
    });
    next.io.on('ping', heard);

    const app = AppState.addEventListener('change', status => {
      if (status === 'background') return parking.setForeground(false);
      if (status !== 'active') return;
      const wasParked = parking.parked;
      // Opens a socket it closed; one closed otherwise is opened, or renewed, here.
      parking.setForeground(true);
      if (wasParked) return;
      if (!next.connected) next.connect();
      else if (Date.now() - lastHeard > staleAfterMs) renew();
    });
    let networkType: Network.NetworkStateType | undefined;
    const network = Network.addNetworkStateListener(({ type, isConnected }) => {
      const changed = networkType !== undefined && type !== networkType;
      networkType = type;
      if (!isConnected || parking.parked) return;
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
      batch.clear();
      parking.dispose();
      presence.current = null;
      app.remove();
      network.remove();
      next.removeAllListeners();
      next.io.off('ping', heard);
      next.disconnect();
      setSocket(null);
    };
  }, [changeListeners, echoes, listeners, queryClient, reach, serverUrl, token]);

  const value = useMemo<Realtime>(() => ({
    socket,
    offline,
    onInvalidate: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onChanges: listener => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    expectEcho: echoes.expect,
    setPlayingHere,
  }), [changeListeners, echoes, listeners, offline, setPlayingHere, socket]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): Realtime {
  return useContext(RealtimeContext);
}

/**
 * How far the server's scan of its library folders has come, as web's Home shows it. The
 * server tells only admins, so for anyone else this stays null.
 */
export function useScanProgress(): ScanProgress | null {
  const { socket } = useContext(RealtimeContext);
  const [roots, setRoots] = useState<ScanRoots>({});
  useEffect(() => {
    if (!socket) return;
    const onEvent = (event: ServerEvent) => {
      if (event.type === 'scan.progress') setRoots(current => scanRoots(current, event));
    };
    socket.on('event', onEvent);
    return () => { socket.off('event', onEvent); };
  }, [socket]);
  return scanTotal(roots);
}
