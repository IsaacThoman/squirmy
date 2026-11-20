import 'expo-sqlite/localStorage/install';

import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { persistQueryClientRestore, persistQueryClientSubscribe } from '@tanstack/react-query-persist-client';
import type { Query, QueryClient } from '@tanstack/react-query';

/** How long a saved library stays usable; queries keep their data at least this long. */
export const cacheMaxAgeMs = 7 * 24 * 3600_000;

const persister = createAsyncStoragePersister({
  storage: globalThis.localStorage,
  key: 'squirmy.query-cache.v1',
  throttleTime: 2000,
});

// The session and searches go stale at once; everything else opens the app instantly.
const transient = new Set(['me', 'search', 'lyrics']);
const dehydrateOptions = {
  shouldDehydrateQuery: (query: Query) => query.state.status === 'success' && !transient.has(String(query.queryKey[0])),
};

/** Ties the saved cache to one account on one server; any other account discards it. */
export function cacheBuster(serverUrl: string, userId: string): string {
  return `${serverUrl}|${userId}`;
}

/** Fills `queryClient` from the saved cache when it belongs to `buster`. */
export function restoreCache(queryClient: QueryClient, buster: string): Promise<void> {
  return persistQueryClientRestore({ queryClient, persister, buster, maxAge: cacheMaxAgeMs }).catch(() => undefined);
}

/** Saves `queryClient` as it changes. Returns the unsubscribe function. */
export function saveCache(queryClient: QueryClient, buster: string): () => void {
  return persistQueryClientSubscribe({ queryClient, persister, buster, dehydrateOptions });
}

export function removeCache(): void {
  void Promise.resolve(persister.removeClient()).catch(() => undefined);
}
