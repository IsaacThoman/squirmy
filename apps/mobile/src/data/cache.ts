import { dehydrate, type Query, type QueryClient, type QueryCacheNotifyEvent } from '@tanstack/react-query';
import { persistQueryClientRestore, type PersistedClient, type Persister } from '@tanstack/react-query-persist-client';
import Storage from 'expo-sqlite/kv-store';
import { AppState } from 'react-native';
import { withinBudget } from './cacheBudget';

/** How long a saved library stays usable; list queries keep their data at least this long. */
export const cacheMaxAgeMs = 7 * 24 * 3600_000;
/** Album, artist, playlist and track pages are kept for a day, and only the most recent of them. */
export const detailMaxAgeMs = 24 * 3600_000;
const maxDetails = 40;
/** Saving serialises the whole cache on the JS thread, so it waits for loading to settle. */
const saveDelayMs = 10_000;
const key = 'squirmy.query-cache.v1';

// The async API of the store behind `localStorage`: reads and writes run off the JS thread.
const persister: Persister = {
  persistClient: client => Storage.setItemAsync(key, JSON.stringify(client)),
  restoreClient: async () => {
    const json = await Storage.getItemAsync(key);
    return json ? JSON.parse(json) as PersistedClient : undefined;
  },
  removeClient: () => Storage.removeItemAsync(key).then(() => undefined),
};

// The session and searches go stale at once; everything else opens the app instantly.
const transient = new Set(['me', 'search', 'lyrics']);
const shouldDehydrateQuery = (query: Query) => query.state.status === 'success' && !transient.has(String(query.queryKey[0]));

/** Ties the saved cache to one account on one server; any other account discards it. */
export function cacheBuster(serverUrl: string, userId: string): string {
  return `${serverUrl}|${userId}`;
}

/** Fills `queryClient` from the saved cache when it belongs to `buster`. */
export function restoreCache(queryClient: QueryClient, buster: string): Promise<void> {
  return persistQueryClientRestore({ queryClient, persister, buster, maxAge: cacheMaxAgeMs }).catch(() => undefined);
}

/** Data arrived or left. Fetch status changes alone leave nothing new to save. */
function changesData(event: QueryCacheNotifyEvent): boolean {
  if (event.type === 'removed') return true;
  if (event.type === 'added') return event.query.state.status === 'success';
  return event.type === 'updated' && event.action.type === 'success';
}

/**
 * Saves `queryClient` a while after its data changes, and at once when the app leaves the
 * screen (iOS may end it there). Returns the unsubscribe function.
 */
export function saveCache(queryClient: QueryClient, buster: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    const clientState = withinBudget(dehydrate(queryClient, { shouldDehydrateQuery }), now, { detailMaxAgeMs, maxDetails });
    void Promise.resolve(persister.persistClient({ buster, timestamp: now, clientState })).catch(() => undefined);
  };
  const unsubscribe = queryClient.getQueryCache().subscribe(event => {
    if (timer === undefined && changesData(event)) timer = setTimeout(save, saveDelayMs);
  });
  const app = AppState.addEventListener('change', status => {
    if (status !== 'active' && timer !== undefined) save();
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
    app.remove();
  };
}

export function removeCache(): void {
  void Promise.resolve(persister.removeClient()).catch(() => undefined);
}
