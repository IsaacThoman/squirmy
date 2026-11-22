import { queryKeys, type User } from '@squirmy/contracts'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { album, home, summary } from '@/fixtures/catalog'
import { currentUser, users } from '@/fixtures/server'

type Request = { result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void; onerror?: () => void; onblocked?: () => void }
type Transaction = { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => unknown }

/** Just enough IndexedDB for the persister: one store, get, put and delete, completing asynchronously like the real one. */
function fakeIndexedDB() {
  const data = new Map<string, unknown>()
  const done = (run: () => unknown): Request => ({ result: run() })
  const database = {
    createObjectStore: () => {},
    transaction: () => {
      const tx: Transaction = {
        objectStore: () => ({
          get: (key: string) => done(() => structuredClone(data.get(key))),
          put: (value: unknown, key: string) => done(() => void data.set(key, structuredClone(value))),
          delete: (key: string) => done(() => void data.delete(key)),
        }),
      }
      setTimeout(() => tx.oncomplete?.())
      return tx
    },
  }
  return {
    data,
    indexedDB: {
      open: () => {
        const request: Request = {}
        setTimeout(() => {
          request.result = database
          request.onupgradeneeded?.()
          request.onsuccess?.()
        })
        return request
      },
    },
  }
}

let storage: ReturnType<typeof fakeIndexedDB>
// The persister keeps its database and stopped state per page load; each test is a new page.
const load = () => import('./persist')

const user: User = currentUser
const recordKey = (id: string) => `${location.origin}|user:${id}`
const pointerKey = `${location.origin}|current`

function signedIn(client: QueryClient, who: User = user) {
  client.setQueryData(queryKeys.me(), who)
  client.setQueryData(['setup-status'], { needsSetup: false, version: 'test', serverName: 'Squirmy', registrationRequiresInvite: true })
}

const hide = () => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.resetModules()
  storage = fakeIndexedDB()
  vi.stubGlobal('indexedDB', storage.indexedDB)
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

describe('isPersisted', () => {
  it('keeps pages of music and leaves out the session, searches, lyrics and admin state', async () => {
    const { isPersisted } = await load()
    for (const key of [queryKeys.home(), [...queryKeys.libraryAlbums(), { sort: 'recent' }], queryKeys.album('a'), queryKeys.artist('b'), queryKeys.playlists(), queryKeys.wants(), [...queryKeys.likes(), 'track']]) {
      expect(isPersisted(key), JSON.stringify(key)).toBe(true)
    }
    for (const key of [queryKeys.me(), [...queryKeys.search(), 'library', 'x'], queryKeys.lyrics('t'), queryKeys.adminUsers(), [...queryKeys.library(), 'stats'], ['app-passwords'], ['imports'], ['setup-status']]) {
      expect(isPersisted(key), JSON.stringify(key)).toBe(false)
    }
  })
})

describe('the persisted cache', () => {
  it('restores the pages of the last session, stale, and the session to check again', async () => {
    const { startPersisting } = await load()
    const before = new QueryClient()
    signedIn(before)
    before.setQueryData(queryKeys.home(), home)
    before.setQueryData(queryKeys.album(album('blue-hour').id), album('blue-hour'))
    before.setQueryData([...queryKeys.libraryAlbums(), { sort: 'recent' }], { pages: [{ items: [summary(album('blue-hour'))], nextCursor: 'c' }, { items: [], nextCursor: null }], pageParams: [undefined, 'c'] })
    before.setQueryData([...queryKeys.search(), 'library', 'blue'], { artists: [], albums: [], tracks: [], provider: null })
    before.setQueryData(queryKeys.lyrics('t'), { trackId: 't', synced: null, plain: 'la', instrumental: false, source: 'x' })
    startPersisting(before)
    before.setQueryData(queryKeys.home(), home)
    hide()
    await vi.waitFor(() => expect(storage.data.get(pointerKey)).toBe(user.id))

    vi.resetModules()
    const after = new QueryClient()
    expect(await (await load()).restoreQueryCache(after)).toBe(true)
    expect(after.getQueryData(queryKeys.home())).toEqual(home)
    expect(after.getQueryData(queryKeys.album(album('blue-hour').id))).toEqual(album('blue-hour'))
    expect(after.getQueryData<{ pages: unknown[] }>([...queryKeys.libraryAlbums(), { sort: 'recent' }])?.pages).toHaveLength(1)
    expect(after.getQueryData([...queryKeys.search(), 'library', 'blue'])).toBeUndefined()
    expect(after.getQueryData(queryKeys.lyrics('t'))).toBeUndefined()
    expect(after.getQueryData(queryKeys.me())).toEqual(user)
    expect(after.getQueryState(queryKeys.me())?.dataUpdatedAt).toBe(0)
    expect(after.getQueryState(queryKeys.home())?.isInvalidated).toBe(true)
  })

  it('restores nothing from another build, or from more than a week ago', async () => {
    storage.data.set(pointerKey, user.id)
    storage.data.set(recordKey(user.id), { build: 'another build', savedAt: Date.now(), user, setup: null, state: { mutations: [], queries: [] } })
    expect(await (await load()).restoreQueryCache(new QueryClient())).toBe(false)

    const { MAX_AGE_MS, restoreQueryCache, startPersisting } = await load()
    const client = new QueryClient()
    signedIn(client)
    startPersisting(client)
    client.setQueryData(queryKeys.home(), home)
    hide()
    await vi.waitFor(() => expect(storage.data.get(recordKey(user.id))).toMatchObject({ user }))
    const record = storage.data.get(recordKey(user.id)) as { savedAt: number }
    record.savedAt = Date.now() - MAX_AGE_MS - 1
    expect(await restoreQueryCache(new QueryClient())).toBe(false)
  })

  it('opens only the record of whoever used the browser last', async () => {
    const { startPersisting } = await load()
    const client = new QueryClient()
    signedIn(client)
    startPersisting(client)
    client.setQueryData(queryKeys.home(), home)
    hide()
    await vi.waitFor(() => expect(storage.data.has(recordKey(user.id))).toBe(true))
    storage.data.set(pointerKey, users[1]!.id)
    vi.resetModules()
    const next = new QueryClient()
    expect(await (await load()).restoreQueryCache(next)).toBe(false)
    expect(next.getQueryData(queryKeys.home())).toBeUndefined()
  })

  it('deletes the record when the server says the session is gone', async () => {
    const { startPersisting } = await load()
    const client = new QueryClient()
    signedIn(client)
    startPersisting(client)
    client.setQueryData(queryKeys.home(), home)
    hide()
    await vi.waitFor(() => expect(storage.data.has(recordKey(user.id))).toBe(true))
    client.setQueryData(queryKeys.me(), null)
    await vi.waitFor(() => expect(storage.data.size).toBe(0))
  })

  it('deletes the record on sign-out and writes nothing after it', async () => {
    const { forgetPersistedCache, startPersisting } = await load()
    const client = new QueryClient()
    signedIn(client)
    startPersisting(client)
    client.setQueryData(queryKeys.home(), home)
    hide()
    await vi.waitFor(() => expect(storage.data.has(recordKey(user.id))).toBe(true))
    await forgetPersistedCache(user.id)
    client.setQueryData(queryKeys.home(), { sections: [] })
    hide()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(storage.data.size).toBe(0)
  })
})
