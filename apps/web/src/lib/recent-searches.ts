import {
  addRecentSearch, parseRecentSearches, recentSearchesStorageKey, removeRecentSearch, type RecentSearch,
} from '@squirmy/client-core'
import { useCallback, useMemo, useSyncExternalStore } from 'react'

/**
 * Results opened or played from Search, kept in this browser per user
 * (`localStorage`, `squirmy.search.recent.<user id>`) and shared by its tabs. Storage is
 * optional: where it is refused the list lives for the page's life.
 */
const listeners = new Set<() => void>()
const memory = new Map<string, string>()

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return memory.get(key) ?? null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    if (value === null) memory.delete(key)
    else memory.set(key, value)
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // Another tab's change.
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(recentSearchesStorageKey(''))) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useRecentSearches(userId: string) {
  const key = recentSearchesStorageKey(userId)
  const json = useSyncExternalStore(subscribe, () => read(key), () => null)
  const list = useMemo(() => parseRecentSearches(json), [json])
  const add = useCallback((entry: RecentSearch) => write(key, JSON.stringify(addRecentSearch(parseRecentSearches(read(key)), entry))), [key])
  const remove = useCallback((entryKey: string) => write(key, JSON.stringify(removeRecentSearch(parseRecentSearches(read(key)), entryKey))), [key])
  const clear = useCallback(() => write(key, null), [key])
  return { list, add, remove, clear }
}
