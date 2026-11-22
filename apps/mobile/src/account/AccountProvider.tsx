import { createApiClient } from '@squirmy/client-core';
import { queryKeys } from '@squirmy/contracts';
import { focusManager, QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type PropsWithChildren,
} from 'react';
import { AppState, Platform } from 'react-native';
import { removeAccountItems } from '../data/accountStorage';
import { cacheBuster, cacheMaxAgeMs, detailMaxAgeMs, removeCache, restoreCache, saveCache } from '../data/cache';
import { useNotice } from '../Notice';
import { reduceAuth, type AuthEvent, type AuthState } from './auth';
import { clientName, fetchWithTimeout, serverFrom, type Server } from './server';
import { clientDevice, keychain, loadAccount, saveAccount } from './storage';

export type Api = ReturnType<typeof createApiClient>;

const requestTimeoutMs = 15_000;
const unsavedNotice = `This ${Platform.OS === 'ios' ? 'iPhone' : 'phone'} couldn’t save your sign-in. You’ll need to sign in again next time.`;

// The app in the background counts as unfocused, so interval refetches pause there.
focusManager.setEventListener(setFocused => {
  const subscription = AppState.addEventListener('change', state => setFocused(state === 'active'));
  return () => subscription.remove();
});

export function createQueryClient() {
  // No refetch on returning to the app: the realtime socket says what changed, and when it
  // was dropped meanwhile, its reconnect refreshes what is on screen.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 30_000, gcTime: cacheMaxAgeMs, refetchOnWindowFocus: false } },
  });
  // Pages of one item pile up as the user browses; they are kept for a shorter time than the lists.
  for (const root of ['album', 'artist', 'track', 'playlists']) queryClient.setQueryDefaults([root], { gcTime: detailMaxAgeMs });
  queryClient.setQueryDefaults(['playlists', 'list'], { gcTime: cacheMaxAgeMs });
  return queryClient;
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
 * Reads the stored session and the saved library, so the first screen shows them at once.
 * The server is not asked here: the `me` query confirms the session in the background, and
 * a 401 from it sends the app to sign-in. An unreachable server leaves the app open
 * offline instead of holding the splash screen until a request times out.
 */
async function restore(queryClient: QueryClient): Promise<AuthEvent> {
  const stored = await loadAccount();
  if (stored.server && stored.token && stored.user) {
    await restoreCache(queryClient, cacheBuster(stored.server.url, stored.user.id));
  }
  return { type: 'restored', ...stored };
}

type AccountContextValue = {
  state: AuthState;
  /** Talks to the chosen server, with the session's token once signed in. */
  api: Api | null;
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
  const server = state.status === 'signIn' || state.status === 'signedIn' ? state.server : null;
  const token = state.status === 'signedIn' ? state.token : null;

  useEffect(() => {
    void restore(queryClient).then(dispatch);
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
  }, [api, buster, queryClient, state, token]);

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
