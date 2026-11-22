import { dehydrate, type Query, type QueryClient, type QueryCacheNotifyEvent } from '@tanstack/react-query';
import Storage from 'expo-sqlite/kv-store';
import { AppState } from 'react-native';
import { withinBudget } from './cacheBudget';
import { decodeSaved, encodeSaved, hydrateSaved, serialiseQueries } from './cacheFormat';

/** How long a saved library stays usable; list queries keep their data at least this long. */
export const cacheMaxAgeMs = 7 * 24 * 3600_000;
/** Album, artist, playlist and track pages are kept for a day, and only the most recent of them. */
export const detailMaxAgeMs = 24 * 3600_000;
const maxDetails = 40;
/** Saving serialises the whole cache on the JS thread, so it waits for loading to settle. */
const saveDelayMs = 10_000;
/**
 * The lists every launch shows are kept apart from the detail pages, which can be far
 * larger: the splash screen waits for the lists alone.
 */
const listsKey = 'squirmy.query-cache.v2.lists';
const pagesKey = 'squirmy.query-cache.v2.pages';
/** The whole cache as one value, from before it was split. It is not read, only removed. */
const oldKey = 'squirmy.query-cache.v1';

// The session and searches go stale at once; everything else opens the app instantly.
const transient = new Set(['me', 'search', 'lyrics']);
const shouldDehydrateQuery = (query: Query) => query.state.status === 'success' && !transient.has(String(query.queryKey[0]));

/** Settles once the saved detail pages are in, so a save made meanwhile keeps them. */
let restoringPages: Promise<void> = Promise.resolve();
/** Counts removals, so pages still being read for an account that signed out are dropped. */
let removals = 0;

/** Ties the saved cache to one account on one server; any other account discards it. */
export function cacheBuster(serverUrl: string, userId: string): string {
  return `${serverUrl}|${userId}`;
}

/** The saved queries under `key` for `buster`; a value for another account, or too old, is removed. */
async function readSaved(key: string, buster: string): Promise<string[]> {
  // The async API of the store behind `localStorage`: the read runs off the JS thread.
  const saved = await Storage.getItemAsync(key);
  if (!saved) return [];
  const lines = decodeSaved(saved, buster, Date.now(), cacheMaxAgeMs);
  if (!lines) void Storage.removeItemAsync(key).catch(() => undefined);
  return lines ?? [];
}

/**
 * Fills `queryClient` with the saved lists when they belong to `buster`: what the first
 * screen shows. Never rejects, since the splash screen waits for it.
 */
export async function restoreCache(queryClient: QueryClient, buster: string): Promise<void> {
  void Storage.removeItemAsync(oldKey).catch(() => undefined);
  try {
    for (const line of await readSaved(listsKey, buster)) hydrateSaved(queryClient, line);
  } catch {
    // Nothing saved can be read: the screens load as they do on a first launch.
  }
}

const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Adds the saved album, artist, playlist and track pages, one per task, so touches and
 * frames go on in between. A page loaded meanwhile keeps its newer data.
 */
export function restorePages(queryClient: QueryClient, buster: string): Promise<void> {
  const removal = removals;
  restoringPages = (async () => {
    for (const line of await readSaved(pagesKey, buster)) {
      await nextTask();
      if (removal !== removals) return;
      hydrateSaved(queryClient, line);
    }
  })().catch(() => undefined);
  return restoringPages;
}

/**
 * Data arrived or left. Fetch status changes alone leave nothing new to save, and a query
 * added with its data already is one read back from the saved cache.
 */
function changesData(event: QueryCacheNotifyEvent): boolean {
  if (event.type === 'removed') return true;
  return event.type === 'updated' && event.action.type === 'success';
}

/**
 * Saves `queryClient` a while after its data changes, and at once when the app leaves the
 * screen (iOS may end it there). Returns the unsubscribe function.
 */
export function saveCache(queryClient: QueryClient, buster: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    const timestamp = Date.now();
    const state = withinBudget(dehydrate(queryClient, { shouldDehydrateQuery }), timestamp, { detailMaxAgeMs, maxDetails });
    const { lists, pages } = serialiseQueries(state);
    return Promise.all([
      Storage.setItemAsync(listsKey, encodeSaved({ buster, timestamp }, lists)),
      Storage.setItemAsync(pagesKey, encodeSaved({ buster, timestamp }, pages)),
    ]);
  };
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    void restoringPages.then(write).catch(() => undefined);
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
  removals += 1;
  for (const key of [listsKey, pagesKey, oldKey]) void Storage.removeItemAsync(key).catch(() => undefined);
}
