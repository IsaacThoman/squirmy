import { queryKeys, type SetupStatus, type User } from '@squirmy/contracts'
import { defaultShouldDehydrateQuery, dehydrate, hydrate, type DehydratedState, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { setupStatusKey } from '@/auth/session'

/**
 * Keeps the query cache in IndexedDB, so a reload paints the last Home, library and album
 * pages at once and refreshes them behind. There is one record per server and user. A record
 * is never shown to anyone else: it is found through the user who saved it, and dropped when
 * they sign out or the server no longer knows their session.
 */

const DATABASE = 'squirmy-cache'
const STORE = 'queries'
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** The most queries a record keeps, newest first. Album and artist pages add up over a week. */
const MAX_QUERIES = 250
const SAVE_DELAY_MS = 1000
/** How long the first render waits for IndexedDB before it goes ahead without the cache. */
const RESTORE_TIMEOUT_MS = 300
/**
 * A record written by another build may hold shapes this one does not read. The URL of this
 * module changes with every build that ships it, so a deploy starts each cache afresh.
 */
const BUILD = import.meta.url

type CacheRecord = {
  build: string
  savedAt: number
  /** Who the record belongs to. Shown while the server confirms the session, never trusted. */
  user: User
  setup: SetupStatus | null
  state: DehydratedState
}

/** What may be written to disk: pages of music, not secrets, admin state, searches, lyrics or signed URLs. */
const persistedRoots = new Set(['home', 'library', 'album', 'artist', 'track', 'likes', 'playlists', 'wants', 'settings', 'history'])
// Under `library` but for admins: the library's scan statistics.
const excluded = new Set(['stats'])

export function isPersisted(key: QueryKey): boolean {
  return typeof key[0] === 'string' && persistedRoots.has(key[0]) && !(typeof key[1] === 'string' && excluded.has(key[1]))
}

/** Paged lists keep their first page; a restored list refetches only that one. */
function firstPageOnly(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('pages' in data) || !('pageParams' in data)) return data
  const { pages, pageParams } = data as { pages: unknown[]; pageParams: unknown[] }
  return { pages: pages.slice(0, 1), pageParams: pageParams.slice(0, 1) }
}

export function snapshot(client: QueryClient): DehydratedState {
  const state = dehydrate(client, { shouldDehydrateQuery: (query: Query) => defaultShouldDehydrateQuery(query) && isPersisted(query.queryKey) })
  const queries = state.queries
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, MAX_QUERIES)
    .map(query => ({ ...query, state: { ...query.state, data: firstPageOnly(query.state.data) } }))
  return { mutations: [], queries }
}

const origin = () => (typeof location === 'undefined' ? '' : location.origin)
const recordKey = (userId: string) => `${origin()}|user:${userId}`
// Which user's record to open on the next start, before the server says who is signed in.
const pointerKey = () => `${origin()}|current`

let opening: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB did not open'))
    request.onblocked = () => reject(new Error('IndexedDB is blocked'))
  })
  opening.catch(() => { opening = undefined })
  return opening
}

async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const database = await open()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode)
    const request = run(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(request ? request.result : undefined)
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

const get = <T>(key: string) => transaction<T>('readonly', store => store.get(key) as IDBRequest<T>)

type Stored = { userId?: string; record?: CacheRecord }

async function readStored(): Promise<Stored> {
  const userId = await get<string>(pointerKey())
  if (!userId) return {}
  const record = await get<CacheRecord>(recordKey(userId))
  if (!record || record.build !== BUILD || Date.now() - record.savedAt > MAX_AGE_MS) return { userId }
  return { userId, record }
}

async function restore(client: QueryClient): Promise<Stored> {
  if (typeof indexedDB === 'undefined') return {}
  const timeout = new Promise<Stored>(resolve => setTimeout(() => resolve({}), RESTORE_TIMEOUT_MS))
  const stored = await Promise.race([readStored().catch((): Stored => ({})), timeout])
  const { record } = stored
  if (!record) return stored
  hydrate(client, record.state)
  // Refetch everything restored as soon as a screen shows it: a stored page is a placeholder, not an answer.
  void client.invalidateQueries({ predicate: query => isPersisted(query.queryKey), refetchType: 'none' })
  client.setQueryData(queryKeys.me(), record.user, { updatedAt: 0 })
  if (record.setup && !record.setup.needsSetup) client.setQueryData(setupStatusKey, record.setup, { updatedAt: 0 })
  return stored
}

/**
 * Fills the cache from the record of whoever used this browser last. The session and setup
 * status come back stale, so the guards render at once and ask the server again; if the
 * session has ended, the persister drops the record and the app shows sign-in.
 */
export async function restoreQueryCache(client: QueryClient): Promise<boolean> {
  return Boolean((await restore(client)).record)
}

/**
 * Restores, but never holds the first render for longer than IndexedDB takes to answer.
 * `warm` runs when someone was signed in here but nothing could be restored (a new build, a
 * week away): their first page is then asked for alongside the session instead of after it.
 */
export async function restoreBeforeRender(client: QueryClient, warm: () => void): Promise<void> {
  const stored = await restore(client).catch((): Stored => ({}))
  if (stored.userId && !stored.record) warm()
}

let stopped = false

async function deleteRecord(userId: string | undefined): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await transaction('readwrite', store => {
    store.delete(pointerKey())
    if (userId) store.delete(recordKey(userId))
  }).catch(() => undefined)
}

/** Deletes the signed-in user's record and stops writing until the page reloads. Call before signing out. */
export function forgetPersistedCache(userId: string | undefined): Promise<void> {
  stopped = true
  return deleteRecord(userId)
}

async function save(client: QueryClient): Promise<void> {
  const user = client.getQueryData<User | null>(queryKeys.me())
  if (stopped || !user) return
  const record: CacheRecord = {
    build: BUILD,
    savedAt: Date.now(),
    user,
    setup: client.getQueryData<SetupStatus>(setupStatusKey) ?? null,
    state: snapshot(client),
  }
  await transaction('readwrite', store => {
    store.put(record, recordKey(user.id))
    store.put(user.id, pointerKey())
  })
}

/** Runs `task` when the page is idle, so writing the cache never delays a click or a frame. */
const whenIdle = (task: () => void) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(task, { timeout: 5000 })
  else setTimeout(task, 0)
}

/**
 * Writes the cache once it has been quiet for a second and the page is idle, and at once
 * when the tab is hidden. When the server reports the session gone (`me` becomes null), the
 * record is deleted instead.
 */
export function startPersisting(client: QueryClient): () => void {
  if (typeof indexedDB === 'undefined') return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let lastUserId = client.getQueryData<User | null>(queryKeys.me())?.id
  const flush = () => {
    clearTimeout(timer)
    if (!pending) return
    pending = false
    void save(client).catch(() => undefined)
  }
  const cancel = () => {
    clearTimeout(timer)
    pending = false
  }
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (stopped || event.type === 'added') return
    if (event.type === 'updated' && event.action.type !== 'success') return
    const key = event.query.queryKey
    if (key.length === 1 && key[0] === queryKeys.me()[0]) {
      const user = client.getQueryData<User | null>(queryKeys.me())
      if (event.query.state.status === 'success' && user === null) {
        cancel()
        void deleteRecord(lastUserId)
        lastUserId = undefined
        return
      }
      if (user) lastUserId = user.id
    }
    if (!isPersisted(key) && key[0] !== queryKeys.me()[0]) return
    pending = true
    clearTimeout(timer)
    timer = setTimeout(() => whenIdle(flush), SAVE_DELAY_MS)
  })
  const hidden = () => { if (document.visibilityState === 'hidden') flush() }
  document.addEventListener('visibilitychange', hidden)
  addEventListener('pagehide', hidden)
  return () => {
    unsubscribe()
    cancel()
    document.removeEventListener('visibilitychange', hidden)
    removeEventListener('pagehide', hidden)
  }
}
