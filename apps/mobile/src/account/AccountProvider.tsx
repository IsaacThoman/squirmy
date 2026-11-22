import { ApiError, createApiClient } from '@squirmy/client-core';
import { queryKeys } from '@squirmy/contracts';
import { focusManager, QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type PropsWithChildren,
} from 'react';
import { AppState, Platform } from 'react-native';
import { removeAccountItems } from '../data/accountStorage';
import { cacheBuster, cacheMaxAgeMs, removeCache, restoreCache, saveCache } from '../data/cache';
import { useNotice } from '../Notice';
import { reduceAuth, type AuthEvent, type AuthState } from './auth';
import { clientName, fetchWithTimeout, serverFrom, type Server } from './server';
import { clientDevice, keychain, loadAccount, saveAccount } from './storage';

export type Api = ReturnType<typeof createApiClient>;

/** How long launch waits for the server to confirm the stored session before trusting it. */
const restoreTimeoutMs = 3000;
const requestTimeoutMs = 15_000;
const unsavedNotice = `This ${Platform.OS === 'ios' ? 'iPhone' : 'phone'} couldn’t save your sign-in. You’ll need to sign in again next time.`;

// Refetch on returning to the app, the native counterpart of a browser tab regaining focus.
focusManager.setEventListener(setFocused => {
  const subscription = AppState.addEventListener('change', state => setFocused(state === 'active'));
  return () => subscription.remove();
});

export function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000, gcTime: cacheMaxAgeMs } } });
}

function apiFor(server: Server, token: string | null, timeoutMs: number, onUnauthorized?: () => void): Api {
  return createApiClient({
    baseUrl: server.url,
    getToken: () => token,
    client: clientName,
    fetch: fetchWithTimeout(timeoutMs),
    validate: __DEV__,
    onUnauthorized,
  });
}

/**
 * Reads the stored session and, when there is one, asks the server whether it still
 * holds. An unreachable server keeps the stored user so the app opens offline. The saved
 * library is loaded meanwhile, so the first screen shows it at once.
 */
async function restore(queryClient: QueryClient): Promise<{ event: AuthEvent; offline: boolean }> {
  const stored = await loadAccount();
  if (!stored.server || !stored.token) return { event: { type: 'restored', ...stored }, offline: false };
  if (stored.user) await restoreCache(queryClient, cacheBuster(stored.server.url, stored.user.id));
  try {
    const user = await apiFor(stored.server, stored.token, restoreTimeoutMs).auth.me();
    return { event: { type: 'restored', ...stored, user }, offline: false };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { event: { type: 'restored', server: stored.server, token: null, user: null, expired: true }, offline: false };
    }
    return { event: { type: 'restored', ...stored }, offline: true };
  }
}

type AccountContextValue = {
  state: AuthState;
  /** Talks to the chosen server, with the session's token once signed in. */
  api: Api | null;
  /** Launch could not reach the server, so the app opened from what it had saved. */
  startedOffline: boolean;
  connect: (server: Server) => void;
  signIn: (username: string, password: string) => Promise<void>;
  register: (inviteCode: string, username: string, password: string) => Promise<void>;
  signOut: () => void;
  switchServer: () => void;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reduceAuth, { status: 'restoring' });
  const [startedOffline, setStartedOffline] = useState(false);
  const server = state.status === 'signIn' || state.status === 'signedIn' ? state.server : null;
  const token = state.status === 'signedIn' ? state.token : null;

  useEffect(() => {
    void restore(queryClient).then(({ event, offline }) => {
      setStartedOffline(offline);
      dispatch(event);
    });
  }, [queryClient]);

  // A keychain that refuses keeps the session for this launch only. Say so once, when signed in.
  const notify = useNotice();
  const [unsaved, setUnsaved] = useState(keychain.refused);
  const told = useRef(false);
  useEffect(() => keychain.onRefused(() => setUnsaved(true)), []);
  useEffect(() => {
    if (!unsaved || state.status !== 'signedIn' || told.current) return;
    told.current = true;
    notify(unsavedNotice);
  }, [notify, state.status, unsaved]);

  const buster = state.status === 'signedIn' ? cacheBuster(state.server.url, state.user.id) : null;
  useEffect(() => buster ? saveCache(queryClient, buster) : undefined, [buster, queryClient]);

  useEffect(() => {
    if (state.status === 'restoring') return;
    void saveAccount(server, state.status === 'signedIn' ? { token: state.token, user: state.user } : undefined);
  }, [state]);

  const api = useMemo(() => server && apiFor(server, token, requestTimeoutMs,
    token ? () => dispatch({ type: 'unauthorized', token }) : undefined), [server, token]);

  // Keeps the user fresh and notices a revoked session (a 401 signs out through `onUnauthorized`).
  const me = useQuery({
    queryKey: ['me', server?.url, token],
    queryFn: () => api!.auth.me(),
    enabled: Boolean(token && api),
    refetchInterval: 5 * 60_000,
  });
  useEffect(() => {
    if (me.data) dispatch({ type: 'userLoaded', user: me.data });
  }, [me.data]);

  // The server may have been updated or renamed since it was saved; what it says now is shown.
  // Under the shared key, so the server can refresh it when an admin changes what it reports.
  const status = useQuery({
    queryKey: [...queryKeys.setupStatus(), server?.url],
    queryFn: () => api!.auth.setupStatus(),
    enabled: Boolean(api),
  });
  useEffect(() => {
    if (status.data && server) dispatch({ type: 'serverLoaded', server: serverFrom(server.url, status.data) });
  }, [server, status.data]);

  const value = useMemo<AccountContextValue>(() => {
    const leave = (event: AuthEvent) => {
      // Best effort: the server may be unreachable, and the token is dropped here either way.
      if (token) void api?.auth.logout().catch(() => undefined);
      queryClient.clear();
      removeCache();
      if (buster) removeAccountItems(buster);
      dispatch(event);
    };
    return {
      state,
      api,
      startedOffline,
      connect: next => dispatch({ type: 'connected', server: next }),
      signIn: async (username, password) => {
        const response = await api!.auth.login({ username: username.trim(), password, device: await clientDevice() });
        // Whatever is cached may belong to whoever signed in before.
        queryClient.clear();
        dispatch({ type: 'signedIn', token: response.token, user: response.user });
      },
      register: async (inviteCode, username, password) => {
        const response = await api!.auth.register({
          inviteCode: inviteCode.trim() || undefined, username: username.trim(), password, device: await clientDevice(),
        });
        queryClient.clear();
        dispatch({ type: 'signedIn', token: response.token, user: response.user });
      },
      signOut: () => leave({ type: 'signedOut' }),
      switchServer: () => leave({ type: 'switchServer' }),
    };
  }, [api, buster, queryClient, startedOffline, state, token]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const account = useContext(AccountContext);
  if (!account) throw new Error('useAccount must be used inside AccountProvider');
  return account;
}

/** The API client while signed in, otherwise null (so queries stay disabled while signing out). */
export function useSignedInApi(): Api | null {
  const { state, api } = useAccount();
  return state.status === 'signedIn' ? api : null;
}

/** Whether the signed-in server has the wantlist on. While it is off nothing in the app mentions it. */
export function useWantlistEnabled(): boolean {
  const { state } = useAccount();
  return state.status === 'signedIn' && state.server.wantlistEnabled;
}

/** The server's root URL, or an empty string before one is chosen. */
export function useServerUrl(): string {
  const { state } = useAccount();
  return state.status === 'signIn' || state.status === 'signedIn' ? state.server.url : '';
}

/** The signed-in server and user as one key, for what the app keeps per account; null while signed out. */
export function useAccountKey(): string | null {
  const { state } = useAccount();
  return state.status === 'signedIn' ? cacheBuster(state.server.url, state.user.id) : null;
}
