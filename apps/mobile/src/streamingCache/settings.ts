import { useContext, useSyncExternalStore } from 'react';
import { Alert, Platform } from 'react-native';
import { formatBytes, plural } from '@squirmy/client-core';
import { tapFeedback } from '../library/shared';
import { StreamingCacheContext } from './context';
import { clearCacheMessage } from './model';
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
    used: summary.count ? `${plural(summary.count, 'song')} · ${formatBytes(summary.usedBytes)}` : 'Nothing yet',
    empty: !summary.count,
    // One tap would empty what plays offline, so it asks first, as Sign out does.
    clear: () => {
      tapFeedback();
      Alert.alert('Clear streaming cache?', clearCacheMessage(summary, device), [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear Cache', style: 'destructive', onPress: () => cache?.clear() },
      ]);
    },
  };
}
