import { formatBytes, plural } from '@squirmy/client-core';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { Alert, Platform } from 'react-native';
import { downloadUsage, removeAccountDownloads } from '../downloads/database';
import { useDownloadManager, useDownloadsSummary } from '../downloads/DownloadsProvider';
import { downloadFiles } from '../downloads/files';
import { tapFeedback } from '../library/shared';
import { useStreamingCache } from '../streamingCache/context';
import { cacheUsage, removeStreamingCache } from '../streamingCache/database';
import type { CacheSummary } from '../streamingCache/manager';
import { useAccount } from './AccountProvider';
import { otherAccountsBytes, usageLine, type AccountChoice, type Usage } from './accounts';

const device = Platform.isTV ? 'Apple TV' : Platform.OS === 'ios' ? 'iPhone' : 'phone';
const none: Usage = { bytes: 0, count: 0 };
const noSubscription = () => () => undefined;
const noSummary = (): CacheSummary | null => null;

/** One saved account in Settings → Storage: what it keeps on this device. */
export type AccountStorage = {
  account: AccountChoice;
  /** Its name, as the switcher shows it. */
  title: string;
  downloads: Usage;
  cache: Usage;
  downloadsLine: string;
  cacheLine: string;
  /** Asks, then removes the account's downloads. */
  removeDownloads: () => void;
  /** Asks, then forgets an account that is not in use, with everything it keeps here. Null for the one in use. */
  removeAccount: (() => void) | null;
};

export function accountTitle(account: Pick<AccountChoice, 'user'>): string {
  return account.user.displayName ?? account.user.username;
}

function confirm(title: string, message: string, action: string, perform: () => void) {
  tapFeedback();
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: action, style: 'destructive', onPress: perform },
  ]);
}

/**
 * Each saved account's downloads and streaming cache on this device, the one in use read
 * live from its managers and the others from the indexes, with removing them.
 */
export function useAccountStorage(): AccountStorage[] {
  const { accounts, forget } = useAccount();
  const manager = useDownloadManager();
  const summary = useDownloadsSummary();
  const cache = useStreamingCache();
  const cacheSummary = useSyncExternalStore(cache?.subscribe ?? noSubscription, cache?.summary ?? noSummary);
  // Read again after a removal here; the indexes of accounts not in use change nowhere else.
  const [version, setVersion] = useState(0);
  const stored = useMemo(() => ({
    downloads: Platform.isTV ? new Map<string, Usage>() : downloadUsage(),
    cache: cacheUsage(),
  }), [accounts, version]);

  const removed = useCallback(() => {
    const downloads = Platform.isTV ? new Map<string, Usage>() : downloadUsage();
    const current = accounts.find(account => account.current)?.key;
    if (current) manager?.setOptions({ otherBytes: otherAccountsBytes(downloads, current) });
    setVersion(value => value + 1);
  }, [accounts, manager]);

  return accounts.map(account => {
    const downloads = account.current ? { bytes: summary?.usedBytes ?? 0, count: summary?.count ?? 0 } : stored.downloads.get(account.key) ?? none;
    const cached = account.current && cacheSummary ? { bytes: cacheSummary.usedBytes, count: cacheSummary.count } : stored.cache.get(account.key) ?? none;
    const title = accountTitle(account);
    const removeDownloads = () => confirm(
      `Remove downloads for ${account.server.name}?`,
      `The ${plural(downloads.count, 'song')} (${formatBytes(downloads.bytes)}) ${title} downloaded from ${account.server.name} will be removed from this ${device}. They won’t play without a connection until you download them again.`,
      'Remove Downloads',
      () => {
        if (account.current) manager?.removeAll();
        else removeAccountDownloads(account.key, downloadFiles().remove);
        removed();
      },
    );
    const removeAccount = account.current ? null : () => confirm(
      `Remove ${title} from this ${device}?`,
      `This ${device} forgets ${title} on ${account.server.name}, with its downloads, streaming cache and saved library. You can sign in again at any time.`,
      'Remove Account',
      () => {
        if (!Platform.isTV) removeAccountDownloads(account.key, downloadFiles().remove);
        if (cache) cache.forgetAccount(account.key);
        else removeStreamingCache(account.key);
        forget(account.key);
        removed();
      },
    );
    return {
      account, title, downloads, cache: cached,
      downloadsLine: usageLine(downloads), cacheLine: usageLine(cached),
      removeDownloads, removeAccount,
    };
  });
}
