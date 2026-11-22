import { createContext, useContext, useSyncExternalStore } from 'react';
import type { StreamingCache } from './manager';
import { defaultLimitBytes } from './model';

type Value = {
  /** Null while signed out. */
  cache: StreamingCache | null;
  limitBytes: number;
  setLimit: (bytes: number) => void;
};

export const StreamingCacheContext = createContext<Value>({ cache: null, limitBytes: defaultLimitBytes, setLimit: () => undefined });

const noSubscription = () => () => undefined;
const noVersion = () => 0;

export function useStreamingCache(): StreamingCache | null {
  return useContext(StreamingCacheContext).cache;
}

/** Re-renders when a cached file arrives or goes. */
export function useCacheFilesVersion(): number {
  const cache = useStreamingCache();
  return useSyncExternalStore(cache?.subscribe ?? noSubscription, cache?.getFilesVersion ?? noVersion);
}

/** Whether the track has a cached file; re-renders only when that changes. */
export function useCached(trackId: string | undefined): boolean {
  const cache = useStreamingCache();
  return useSyncExternalStore(cache?.subscribe ?? noSubscription, () => Boolean(trackId && cache?.has(trackId)));
}

/** The local copy of a cover, when one was kept with a cached track. */
export function useCachedArtwork(artworkId: string | undefined): string | null {
  const cache = useStreamingCache();
  return useSyncExternalStore(cache?.subscribe ?? noSubscription, () => artworkId ? cache?.artworkUri(artworkId) ?? null : null);
}
