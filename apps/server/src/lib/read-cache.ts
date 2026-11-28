/**
 * In-process cache of hot JSON reads (Home, library lists, album, artist and playlist
 * pages), so revisiting a screen costs a map lookup instead of a dozen queries.
 *
 * Correctness comes from the realtime invalidations, the same ones that tell clients to
 * refetch (`realtime/index.ts` calls `dropCachedReads` for every `invalidate`, locally at
 * once and again when the NOTIFY arrives, so changes made by a separate worker reach this
 * process too). Each entry names the query-key roots it depends on; an invalidation for
 * one of those roots drops it: for one user's entries when it targets that user, for
 * everyone's when it targets all users or admins. A key root this file does not know drops
 * everything it targets, so a new kind of invalidation can only make the cache forget
 * more. Entries also expire after five minutes, which bounds staleness from the changes
 * nothing announces (another user's plays reordering an artist's top tracks, a provider
 * miss expiring).
 *
 * Everything is keyed per user: library membership and playability become per user, and
 * pages carry the user's likes. A read that overlaps an invalidation is not stored, so a
 * result computed from data older than the invalidation is never kept.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getConfig } from '../config.js'
import { weakEtag } from './conditional.js'

/** The first element of a `queryKeys` key: what changed. */
export type CacheTag =
  | 'home' | 'library' | 'album' | 'artist' | 'track' | 'search' | 'likes' | 'playlists' | 'history' | 'wants'

/** Key roots that never change what a cached read returns. */
const unrelated = new Set(['admin', 'settings', 'scrobbling', 'me', 'lyrics', 'uploads'])
const known = new Set<string>(['home', 'library', 'album', 'artist', 'track', 'search', 'likes', 'playlists', 'history', 'wants'])

const ttlMs = 5 * 60_000
/** A dropped entry that was read this recently is computed again in the background. */
const rewarmWithinMs = 15 * 60_000
/** Invalidations arrive in bursts (a scan sends them every half second); rewarm after the burst. */
const rewarmDelayMs = 2_000

type Compute = () => Promise<unknown>

type Entry = {
  userId: string
  tags: readonly CacheTag[]
  artistId?: string
  /** The ids the body names, so a catalog change is checked without scanning every body. */
  ids: ReadonlySet<string>
  body: string
  etag: string
  expiresAt: number
  readAt: number
  rewarm?: Compute
}

/** Insertion order is recency order: a hit is moved to the end, eviction takes the front. */
const entries = new Map<string, Entry>()
let storedBytes = 0
/** Bumped by every drop, so a read that overlapped one knows not to store its result. */
let globalGeneration = 0
const userGenerations = new Map<string, number>()
export type CatalogStubChanges = { entities: Set<string>; discographies: Set<string> }
type Flight = { pending: Promise<{ body: string; etag: string }>; catalogChanges: CatalogStubChanges }
const inFlight = new Map<string, Flight>()
const rewarmTimers = new Map<string, NodeJS.Timeout>()

function maxBytes() {
  const config = getConfig()
  return (config.SQUIRMY_READ_CACHE_MB ?? (config.NODE_ENV === 'test' ? 0 : 64)) * 1024 * 1024
}

const generationOf = (userId: string) => `${globalGeneration}:${userGenerations.get(userId) ?? 0}`
const artistRead = /\|\/api\/v1\/artists\/([^/?]+)(\/releases)?(?:\?|$)/
const quotedId = /"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g
const idsIn = (body: string): ReadonlySet<string> => new Set(Array.from(body.matchAll(quotedId), (match) => match[1]!))

function remove(key: string) {
  const entry = entries.get(key)
  if (!entry) return
  entries.delete(key)
  storedBytes -= entry.body.length
}

function store(key: string, entry: Entry) {
  remove(key)
  const limit = maxBytes()
  if (entry.body.length > limit / 8) return
  entries.set(key, entry)
  storedBytes += entry.body.length
  for (const [oldest] of entries) {
    if (storedBytes <= limit) break
    remove(oldest)
  }
}

async function load(key: string, userId: string, tags: readonly CacheTag[], compute: Compute, rewarm: boolean) {
  const generation = generationOf(userId)
  const flightKey = `${generation}|${key}`
  const existing = inFlight.get(flightKey)
  if (existing) return existing.pending
  const catalogChanges: CatalogStubChanges = { entities: new Set(), discographies: new Set() }
  const pending = (async () => {
    const result = await compute()
    const body = JSON.stringify(result)
    const etag = weakEtag(body)
    const artist = artistRead.exec(key)
    // Artist detail supplies the resolved id when the URL named a redirect.
    const artistId = artist && !artist[2] ? (result as { id: string }).id : artist?.[1]
    const ids = idsIn(body)
    if (generationOf(userId) === generation && !showsCatalogChanges(ids, artistId, catalogChanges)) {
      const now = Date.now()
      store(key, { userId, tags, artistId, ids, body, etag, expiresAt: now + ttlMs, readAt: now, rewarm: rewarm ? compute : undefined })
    }
    return { body, etag }
  })().finally(() => inFlight.delete(flightKey))
  inFlight.set(flightKey, { pending, catalogChanges })
  return pending
}

export type CachedRead = {
  /** The user the answer is for. */
  userId: string
  /** What the answer depends on; an invalidation of any of these drops it. */
  tags: readonly CacheTag[]
  /** Compute it again in the background after an invalidation, when it was read recently. */
  rewarm?: boolean
}

/**
 * Answers a GET from the cache, or computes, stores and sends it. The body is the
 * `JSON.stringify` of what `compute` returns, as Fastify would have sent it. The key is the
 * request's URL, so every query string is its own entry.
 */
export async function cachedRead(request: FastifyRequest, reply: FastifyReply, read: CachedRead, compute: Compute) {
  if (maxBytes() === 0) return compute()
  const key = `${read.userId}|${request.url}`
  const now = Date.now()
  const hit = entries.get(key)
  let answer: { body: string; etag: string }
  if (hit && hit.expiresAt > now) {
    entries.delete(key)
    entries.set(key, hit)
    hit.readAt = now
    answer = hit
  } else {
    answer = await load(key, read.userId, read.tags, compute, read.rewarm ?? false)
  }
  return reply.header('etag', answer.etag).type('application/json; charset=utf-8').send(answer.body)
}

type Target = { user: string } | 'admins' | 'all'

function scheduleRewarm(key: string, entry: Entry) {
  if (!entry.rewarm || Date.now() - entry.readAt > rewarmWithinMs) return
  clearTimeout(rewarmTimers.get(key))
  rewarmTimers.set(key, setTimeout(() => {
    rewarmTimers.delete(key)
    if (entries.has(key) || maxBytes() === 0) return
    void load(key, entry.userId, entry.tags, entry.rewarm!, true)
      .then(() => { const stored = entries.get(key); if (stored) stored.readAt = entry.readAt })
      .catch(() => {})
  }, rewarmDelayMs).unref())
}

function showsCatalogChanges(ids: ReadonlySet<string>, artistId: string | undefined, { entities, discographies }: CatalogStubChanges) {
  if (artistId && discographies.has(artistId)) return true
  const [fewer, more] = entities.size <= ids.size ? [entities, ids] : [ids, entities]
  for (const id of fewer) if (more.has(id)) return true
  return false
}

/** Drops reads that show an edited entity or list new/changed releases for a credited artist. */
export function dropCatalogStubReads(changes: CatalogStubChanges) {
  const { entities, discographies } = changes
  if (entities.size + discographies.size === 0) return
  for (const { catalogChanges } of inFlight.values()) {
    for (const id of entities) catalogChanges.entities.add(id)
    for (const id of discographies) catalogChanges.discographies.add(id)
  }
  for (const [key, entry] of entries) {
    if (!showsCatalogChanges(entry.ids, entry.artistId, changes)) continue
    remove(key)
    scheduleRewarm(key, entry)
  }
}

/**
 * Drops the cached reads an invalidation makes stale. Called by `realtime` for every
 * `invalidate(target, keys)`, in the process that sent it and in the API process that
 * receives the NOTIFY.
 */
export function dropCachedReads(target: Target | readonly Target[], keys: readonly (readonly unknown[])[]) {
  const roots = new Set(keys.map((key) => String(key[0])).filter((root) => !unrelated.has(root)))
  if (roots.size === 0) return
  const everything = [...roots].some((root) => !known.has(root))
  const targets: readonly Target[] = Array.isArray(target) ? target : [target as Target]
  const global = targets.some((one) => one === 'all' || one === 'admins')
  const users = new Set(targets.flatMap((one) => typeof one === 'object' ? [one.user] : []))
  if (global) globalGeneration++
  for (const user of users) userGenerations.set(user, (userGenerations.get(user) ?? 0) + 1)
  for (const [key, entry] of entries) {
    if (!global && !users.has(entry.userId)) continue
    if (!everything && !entry.tags.some((tag) => roots.has(tag))) continue
    remove(key)
    scheduleRewarm(key, entry)
  }
}

/** Forgets everything. Tests use it between cases. */
export function clearReadCache() {
  entries.clear()
  storedBytes = 0
  globalGeneration++
  for (const timer of rewarmTimers.values()) clearTimeout(timer)
  rewarmTimers.clear()
}

/** Entry count and size, for tests and diagnostics. */
export function readCacheStats() {
  return { entries: entries.size, bytes: storedBytes }
}
