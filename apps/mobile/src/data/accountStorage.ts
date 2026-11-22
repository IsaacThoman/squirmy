import 'expo-sqlite/localStorage/install';

import Storage from 'expo-sqlite/kv-store';

/** Things kept for one account (a server and user) in app storage, and the device's own settings. */
type ItemName = 'likes' | 'session' | 'sessionQueue' | 'downloadCap';
const accountNames: readonly ItemName[] = ['likes', 'session', 'sessionQueue'];

/** JSON kept for one account, or for the device as `account`. Reads that fail return null; writes that fail are dropped. */
export function accountItem<T>(name: ItemName, account: string) {
  const key = `squirmy.${name}.v1:${account}`;
  return {
    read(): T | null {
      try {
        const json = globalThis.localStorage?.getItem(key);
        return json ? JSON.parse(json) as T : null;
      } catch {
        return null;
      }
    },
    write(value: T): void {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
      } catch {
        // Kept in memory for this launch only.
      }
    },
    /** As `write`, with the write itself off the JS thread (the same store, through its async API). */
    writeAsync(value: T): void {
      try {
        void Storage.setItemAsync(key, JSON.stringify(value)).catch(() => undefined);
      } catch {
        // Kept in memory for this launch only.
      }
    },
  };
}

/** Removes everything `accountItem` kept for `account`, on sign-out. */
export function removeAccountItems(account: string): void {
  for (const name of accountNames) {
    try {
      globalThis.localStorage?.removeItem(`squirmy.${name}.v1:${account}`);
    } catch {
      // Nothing to remove.
    }
  }
}
