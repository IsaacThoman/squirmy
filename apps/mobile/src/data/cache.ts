import { dehydrate, type Query, type QueryClient, type QueryCacheNotifyEvent } from '@tanstack/react-query';
import Storage from 'expo-sqlite/kv-store';
import { AppState } from 'react-native';
import { accountKey } from '../account/accounts';
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
 * larger: the splash screen waits for the lists alone. Each account has its own pair, so
 * switching to another account and back finds its library still there.
 */
const listsKey = (buster: string) => `squirmy.query-cache.v3.lists:${buster}`;
const pagesKey = (buster: string) => `squirmy.query-cache.v3.pages:${buster}`;
/** One pair for whichever account was signed in, from before there were several. Read once for that account, then moved. */
const sharedKeys = { lists: 'squirmy.query-cache.v2.lists', pages: 'squirmy.query-cache.v2.pages' } as const;
/** The whole cache as one value, from before it was split. It is not read, only removed. */
const oldKey = 'squirmy.query-cache.v1';

// The session and searches go stale at once; everything else opens the app instantly.
const transient = new Set(['me', 'search', 'lyrics']);
const shouldDehydrateQuery = (query: Query) => query.state.status === 'success' && !transient.has(String(query.queryKey[0]));

/** Settles once the saved detail pages are in, so a save made meanwhile keeps them. */
let restoringPages: Promise<void> = Promise.resolve();
/** True while they are being read: until then the pages in memory are only some of those saved. */
let pagesPending = false;
/** Counts removals and switches, so pages still being read for an account that left are dropped. */
let removals = 0;

/** Ties the saved cache to one account on one server; the value also names it, so a mix-up is discarded. */
export const cacheBuster = accountKey;

/**
 * The saved queries of `part` for `buster`; a value for another account, or too old, is
 * removed. Before an account's own value exists, the one value earlier versions shared is
 * read when it is this account's, and moved under its key.
 */
async function readSaved(part: keyof typeof sharedKeys, buster: string): Promise<string[]> {
  const key = part === 'lists' ? listsKey(buster) : pagesKey(buster);
  // The async API of the store behind `localStorage`: the read runs off the JS thread.
  const saved = await Storage.getItemAsync(key);
  if (saved) {
    const lines = decodeSaved(saved, buster, Date.now(), cacheMaxAgeMs);
    if (!lines) void Storage.removeItemAsync(key).catch(() => undefined);
    return lines ?? [];
  }
  const shared = await Storage.getItemAsync(sharedKeys[part]);
  if (!shared) return [];
  const lines = decodeSaved(shared, buster, Date.now(), cacheMaxAgeMs);
  // Another account's, or too old: it would never be read.
  if (!lines) {
    void Storage.removeItemAsync(sharedKeys[part]).catch(() => undefined);
    return [];
  }
  void Storage.setItemAsync(key, shared).then(() => Storage.removeItemAsync(sharedKeys[part])).catch(() => undefined);
  return lines;
}

/**
 * Fills `queryClient` with the saved lists when they belong to `buster`: what the first
 * screen shows. Never rejects, since the splash screen waits for it.
 */
export async function restoreCache(queryClient: QueryClient, buster: string): Promise<void> {
  void Storage.removeItemAsync(oldKey).catch(() => undefined);
  try {
    for (const line of await readSaved('lists', buster)) hydrateSaved(queryClient, line);
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
  pagesPending = true;
  restoringPages = (async () => {
    for (const line of await readSaved('pages', buster)) {
      await nextTask();
      if (removal !== removals) return;
      hydrateSaved(queryClient, line);
    }
  })().catch(() => undefined).finally(() => {
    if (removal === removals) pagesPending = false;
  });
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

/** Stops saving; `flush` first writes what is unsaved, before the account's queries are cleared. */
export type CacheSaver = { stop: () => void; flush: () => void };

/**
 * Saves `queryClient` a while after its data changes, and at once when the app leaves the
 * screen (iOS may end it there).
 */
export function saveCache(queryClient: QueryClient, buster: string): CacheSaver {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** `withPages` false keeps the saved pages: those in memory are only the ones read back so far. */
  const write = (withPages = true) => {
    const timestamp = Date.now();
    const state = withinBudget(dehydrate(queryClient, { shouldDehydrateQuery }), timestamp, { detailMaxAgeMs, maxDetails });
    const { lists, pages } = serialiseQueries(state);
    return Promise.all([
      Storage.setItemAsync(listsKey(buster), encodeSaved({ buster, timestamp }, lists)),
      withPages ? Storage.setItemAsync(pagesKey(buster), encodeSaved({ buster, timestamp }, pages)) : undefined,
    ]);
  };
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    // Once stopped, the queries may already be another account's.
    void restoringPages.then(() => stopped ? undefined : write()).catch(() => undefined);
  };
  const unsubscribe = queryClient.getQueryCache().subscribe(event => {
    if (timer === undefined && changesData(event)) timer = setTimeout(save, saveDelayMs);
  });
  const app = AppState.addEventListener('change', status => {
    if (status !== 'active' && timer !== undefined) save();
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    unsubscribe();
    app.remove();
  };
  return {
    stop,
    // Written as the cache is now, at once: the dehydration happens before the queries are cleared.
    flush: () => {
      if (stopped) return;
      const writing = write(!pagesPending);
      stop();
      void writing.catch(() => undefined);
    },
  };
}

/** Pages still being read are dropped: the queries are about to be cleared for another account. */
export function stopRestoring(): void {
  removals += 1;
  pagesPending = false;
}

/** Removes the library saved for `buster`, when the account is removed from the device. */
export function removeCache(buster: string): void {
  for (const key of [listsKey(buster), pagesKey(buster), oldKey]) void Storage.removeItemAsync(key).catch(() => undefined);
}
