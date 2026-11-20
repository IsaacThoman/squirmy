import { ApiError, createApiClient } from '@squirmy/client-core';
import { focusManager, QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext, useContext, useEffect, useMemo, useReducer, type PropsWithChildren,
} from 'react';
import { AppState } from 'react-native';
import { reduceAuth, type AuthEvent, type AuthState } from './auth';
import { clientName, fetchWithTimeout, type Server } from './server';
import { clientDevice, loadAccount, saveAccount } from './storage';

export type Api = ReturnType<typeof createApiClient>;

/** How long launch waits for the server to confirm the stored session before trusting it. */
const restoreTimeoutMs = 3000;
const requestTimeoutMs = 15_000;

// Refetch on returning to the app, the native counterpart of a browser tab regaining focus.
focusManager.setEventListener(setFocused => {
  const subscription = AppState.addEventListener('change', state => setFocused(state === 'active'));
  return () => subscription.remove();
});

export function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });
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
 * holds. An unreachable server keeps the stored user so the app opens offline.
 */
async function restore(): Promise<AuthEvent> {
  const stored = await loadAccount();
  if (!stored.server || !stored.token) return { type: 'restored', ...stored };
  try {
    const user = await apiFor(stored.server, stored.token, restoreTimeoutMs).auth.me();
    return { type: 'restored', ...stored, user };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { type: 'restored', server: stored.server, token: null, user: null, expired: true };
    }
    return { type: 'restored', ...stored };
  }
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
    void restore().then(dispatch);
  }, []);

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

  const value = useMemo<AccountContextValue>(() => {
    const leave = (event: AuthEvent) => {
      // Best effort: the server may be unreachable, and the token is dropped here either way.
      if (token) void api?.auth.logout().catch(() => undefined);
      queryClient.clear();
      dispatch(event);
    };
    return {
      state,
      api,
      connect: next => dispatch({ type: 'connected', server: next }),
      signIn: async (username, password) => {
        const response = await api!.auth.login({ username: username.trim(), password, device: await clientDevice() });
        dispatch({ type: 'signedIn', token: response.token, user: response.user });
      },
      register: async (inviteCode, username, password) => {
        const response = await api!.auth.register({
          inviteCode: inviteCode.trim() || undefined, username: username.trim(), password, device: await clientDevice(),
        });
        dispatch({ type: 'signedIn', token: response.token, user: response.user });
      },
      signOut: () => leave({ type: 'signedOut' }),
      switchServer: () => leave({ type: 'switchServer' }),
    };
  }, [api, queryClient, state, token]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const account = useContext(AccountContext);
  if (!account) throw new Error('useAccount must be used inside AccountProvider');
  return account;
}
