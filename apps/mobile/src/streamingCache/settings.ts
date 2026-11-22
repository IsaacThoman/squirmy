import { useContext, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { formatBytes } from '../downloads/model';
import { tapFeedback } from '../library/shared';
import { StreamingCacheContext } from './context';
import type { CacheSummary } from './manager';

export { limitOptions } from './model';

const device = Platform.OS === 'ios' ? 'iPhone' : 'phone';

export const cacheNote = `Keeps the songs you played most recently, and the next ones in your queue, on this ${device}. They start at once, play without a connection and use no data the second time. The oldest are removed to stay under the limit. Downloads are separate and never removed.`;

const nothing: CacheSummary = { usedBytes: 0, count: 0 };
const noSubscription = () => () => undefined;
const noSummary = () => nothing;

/** Settings → Storage: the streaming cache's size limit, what it holds now, and Clear. */
export function useStorageSection() {
  const { cache, limitBytes, setLimit } = useContext(StreamingCacheContext);
  const summary = useSyncExternalStore(cache?.subscribe ?? noSubscription, cache?.summary ?? noSummary);
  return {
    limitBytes,
    setLimit,
    used: summary.count ? `${summary.count} ${summary.count === 1 ? 'song' : 'songs'} · ${formatBytes(summary.usedBytes)}` : 'Nothing yet',
    empty: !summary.count,
    clear: () => {
      tapFeedback();
      cache?.clear();
    },
  };
}
