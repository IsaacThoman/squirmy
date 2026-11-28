import { ApiError, createApiClient } from '@squirmy/client-core';
import { queryKeys } from '@squirmy/contracts';
import { focusManager, QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type PropsWithChildren,
} from 'react';
import { AppState, Platform } from 'react-native';
import { removeAccountItems } from '../data/accountStorage';
import {
  cacheMaxAgeMs, detailMaxAgeMs, removeCache, restoreCache, restorePages, saveCache, stopRestoring, type CacheSaver,
} from '../data/cache';
import { HttpReach } from '../data/reachability';
import { announce } from '../inlineFeedback';
import { accountKey, type AccountChoice, type AccountStore } from './accounts';
import { reduceAuth, type AuthEvent, type AuthState } from './auth';
import { clientName, fetchWithTimeout, serverFrom, type Server } from './server';
import { clientDevice, createAccountStore, keychain, rememberUsername } from './storage';

export type Api = ReturnType<typeof createApiClient>;

const requestTimeoutMs = 15_000;
/** Said on the account sheet (and sign-in) while the keychain refuses to keep the session. */
export const unsavedSignIn = `This ${Platform.isTV ? 'Apple TV' : Platform.OS === 'ios' ? 'iPhone' : 'phone'} couldn’t save your sign-in. You’ll need to sign in again next time.`;

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

function apiFor(serverUrl: string, token: string | null, timeoutMs: number, onUnauthorized?: () => void, reach?: HttpReach): Api {
  const fetch = fetchWithTimeout(timeoutMs);
  return createApiClient({
    baseUrl: serverUrl,
    getToken: () => token,
    client: clientName,
    fetch: reach ? reach.watch(fetch) : fetch,
    onUnauthorized,
  });
}

/**
 * Reads the stored session and the saved lists, so the first screen shows them at once.
 * The server is not asked here: the `me` query confirms the session in the background, and
 * a 401 from it sends the app to sign-in. An unreachable server leaves the app open
 * offline instead of holding the splash screen until a request times out.
 */
async function restore(queryClient: QueryClient, store: AccountStore): Promise<AuthEvent> {
  const stored = await store.load();
  if (!stored.server || !stored.token) return { type: 'restored', ...stored };
  if (stored.user) {
    await restoreCache(queryClient, accountKey(stored.server.url, stored.user.id));
    return { type: 'restored', ...stored };
  }
  // A session saved without its user (by an early version) has to ask the server once.
  try {
    return { type: 'restored', ...stored, user: await apiFor(stored.server.url, stored.token, requestTimeoutMs).auth.me() };
  } catch (error) {
    return { type: 'restored', server: stored.server, token: null, user: null, expired: error instanceof ApiError && error.status === 401 };
  }
}

type AccountContextValue = {
  state: AuthState;
  /** Talks to the chosen server, with the session's token once signed in. */
  api: Api | null;
  /** What came of the requests `api` sent, so an answered request counts as the server being there. */
  reach: HttpReach;
  /** The keychain refused to keep the session: the next launch will need a sign-in. */
  unsaved: boolean;
  /** The accounts signed in to on this device, the one in use first. */
  accounts: AccountChoice[];
  connect: (server: Server) => void;
  signIn: (username: string, password: string) => Promise<void>;
  register: (inviteCode: string, username: string, password: string) => Promise<void>;
  /**
   * Signs out of the account in use: its token goes and the server is told. What it keeps on
   * the device (downloads, the streaming cache, the saved library) stays for its next sign-in.
   */
  signOut: () => void;
  /** Goes to Connect, to sign in to another server or as someone else. The account in use stays signed in. */
  addAccount: () => void;
  /** Opens a saved account: at once while it is signed in, otherwise at its sign-in. */
  switchTo: (key: string) => Promise<void>;
  /**
   * Forgets a saved account other than the one in use: its token, its saved library and
   * queued hearts. `useAccountStorage().removeAccount` also removes its files.
   */
  forget: (key: string) => void;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const [store] = useState(createAccountStore);
  const accounts = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [state, dispatch] = useReducer(reduceAuth, { status: 'restoring' });
  const [reach] = useState(() => new HttpReach());
  const server = state.status === 'signIn' || state.status === 'signedIn' ? state.server : null;
  const token = state.status === 'signedIn' ? state.token : null;

  useEffect(() => {
    void restore(queryClient, store).then(dispatch);
  }, [queryClient, store]);

  // A keychain that refuses keeps the session for this launch only. The account sheet says so
  // (and sign-in, if it happens there); VoiceOver hears it once, when it happens.
  const [unsaved, setUnsaved] = useState(keychain.refused);
  const told = useRef(false);
  useEffect(() => keychain.onRefused(() => setUnsaved(true)), []);
  useEffect(() => {
    if (!unsaved || (state.status !== 'signedIn' && state.status !== 'signIn') || told.current) return;
    told.current = true;
    announce(unsavedSignIn);
  }, [state.status, unsaved]);

  const buster = state.status === 'signedIn' ? accountKey(state.server.url, state.user.id) : null;
  const busterRef = useRef(buster);
  busterRef.current = buster;
  const saver = useRef<CacheSaver | null>(null);
  /** A switch under way: a second tap meanwhile would read two accounts' libraries into one cache. */
  const switching = useRef(false);
  useEffect(() => {
    if (!buster) return;
    const next = saveCache(queryClient, buster);
    saver.current = next;
    return () => {
      next.stop();
      if (saver.current === next) saver.current = null;
    };
  }, [buster, queryClient]);
  // The saved album, artist, playlist and track pages are read once the first screen is up,
  // so they never hold the splash screen. Once each time an account opens.
  const pagesRead = useRef<string | null>(null);
  useEffect(() => {
    if (!buster || pagesRead.current === buster) return;
    pagesRead.current = buster;
    void restorePages(queryClient, buster);
  }, [buster, queryClient]);

  useEffect(() => store.follow(state), [state, store]);

  // Keyed on the URL, not the server object: a rename or update must not replace the client,
  // since playback and downloads are built on it.
  const serverUrl = server?.url ?? null;
  const api = useMemo(() => serverUrl === null ? null : apiFor(serverUrl, token, requestTimeoutMs, token ? () => {
    // The server no longer takes this token: it is dropped, and the account waits for its sign-in.
    const key = busterRef.current;
    if (key && store.token(key) === token) store.signOut(key);
    dispatch({ type: 'unauthorized', token });
  } : undefined, reach), [reach, serverUrl, store, token]);

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
    // What is unsaved of the account's library is written under its key before the queries are
    // cleared, so they never mix with the next account's.
    const release = () => {
      saver.current?.flush();
      stopRestoring();
      queryClient.clear();
    };
    // Whatever is cached may belong to whoever signed in before; the account's own saved library comes back.
    const open = async (user: { id: string }) => {
      stopRestoring();
      queryClient.clear();
      if (server) await restoreCache(queryClient, accountKey(server.url, user.id));
    };
    return {
      state,
      api,
      reach,
      unsaved,
      accounts,
      connect: next => dispatch({ type: 'connected', server: next }),
      signIn: async (username, password) => {
        const response = await api!.auth.login({ username: username.trim(), password, device: await clientDevice(server?.supportsTvDevices) });
        await open(response.user);
        dispatch({ type: 'signedIn', token: response.token, user: response.user });
      },
      register: async (inviteCode, username, password) => {
        const response = await api!.auth.register({
          inviteCode: inviteCode.trim() || undefined, username: username.trim(), password, device: await clientDevice(server?.supportsTvDevices),
        });
        await open(response.user);
        dispatch({ type: 'signedIn', token: response.token, user: response.user });
      },
      signOut: () => {
        // Best effort: the server may be unreachable, and the token is dropped here either way.
        if (token) void api?.auth.logout().catch(() => undefined);
        if (buster) store.signOut(buster);
        release();
        dispatch({ type: 'signedOut' });
      },
      addAccount: () => {
        if (buster) release();
        dispatch({ type: 'switchServer' });
      },
      switchTo: async key => {
        const account = store.account(key);
        if (!account || key === buster || switching.current) return;
        switching.current = true;
        const next = store.token(key);
        if (buster) release();
        // Every screen and the player close first, so nothing asks either server meanwhile.
        dispatch({ type: 'switching' });
        if (next) await restoreCache(queryClient, key);
        else rememberUsername(account.server.url, account.user.username);
        switching.current = false;
        dispatch({ type: 'restored', server: account.server, token: next, user: next ? account.user : null });
      },
      forget: key => {
        const account = store.account(key);
        if (!account || key === buster) return;
        const saved = store.token(key);
        if (saved) void apiFor(account.server.url, saved, requestTimeoutMs).auth.logout().catch(() => undefined);
        store.remove(key);
        removeCache(key);
        removeAccountItems(key);
      },
    };
  }, [accounts, api, buster, queryClient, reach, server, state, store, token, unsaved]);

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
  return state.status === 'signedIn' ? accountKey(state.server.url, state.user.id) : null;
}
