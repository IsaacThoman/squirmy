import { changedEntityKey, type ChangedEntity, type EntityChange, type EntityFields } from '@squirmy/contracts'
import { clearTimer, setTimer } from './timers.js'

type QueryKey = readonly unknown[]

/** New field values by entity id. */
export type EntityPatches = ReadonlyMap<string, Readonly<Record<string, unknown>>>

/**
 * A copy of `data` in which every object whose `id` has an entry in `patches` gets those
 * of its fields it already carries set to the new values. Unchanged parts keep their
 * identity, and the same `data` comes back when nothing matched, so a cache can tell which
 * answers to write back. Ids are UUIDs, unique across entity types, so one walk updates an
 * entity everywhere it shows: album pages, lists, playlists, search results.
 */
export function patchEntities<T>(data: T, patches: EntityPatches): T {
  if (patches.size === 0) return data
  return walk(data, patches)
}

function walk<T>(data: T, patches: EntityPatches): T {
  if (Array.isArray(data)) {
    let next: unknown[] | null = null
    for (let index = 0; index < data.length; index++) {
      const item: unknown = data[index]
      const patched = walk(item, patches)
      if (patched !== item) (next ??= [...data])[index] = patched
    }
    return (next ?? data) as T
  }
  if (!data || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  let next: Record<string, unknown> | null = null
  const patch = typeof record.id === 'string' ? patches.get(record.id) : undefined
  if (patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (key in record && record[key] !== value) (next ??= { ...record })[key] = value
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (!value || typeof value !== 'object') continue
    const patched = walk(value, patches)
    if (patched !== value) (next ??= { ...record })[key] = patched
  }
  return (next ?? data) as T
}

/** What a client does with a batch of `changes`. */
export type ChangePlan = {
  /** Values to set on every cached copy of each entity. */
  patches: Map<string, Record<string, unknown>>
  /** Entities' own queries to fetch again (`updated`). */
  refetch: QueryKey[]
  /** Entities' own queries whose entity is gone (`deleted`). */
  gone: QueryKey[]
  /** The per-viewer fields each `patch` set, for state a client keeps outside its cache. */
  fields: { entity: ChangedEntity; id: string; fields: EntityFields }[]
}

/**
 * Turns changes into cache work. Later changes to the same field win, as they were sent in
 * order. An entity that is gone is not also refetched.
 */
export function planChanges(changes: readonly EntityChange[]): ChangePlan {
  const patches = new Map<string, Record<string, unknown>>()
  const refetch = new Map<string, QueryKey>()
  const gone = new Map<string, QueryKey>()
  const fields: ChangePlan['fields'] = []
  const set = (id: string, values: Record<string, unknown>) => patches.set(id, { ...patches.get(id), ...values })
  for (const change of changes) {
    if (change.kind === 'availability') {
      for (const track of change.tracks) set(track.id, { availability: track.availability })
      for (const { id, ...values } of change.albums) set(id, values)
    } else if (change.kind === 'patch') {
      set(change.id, change.fields)
      fields.push({ entity: change.entity, id: change.id, fields: change.fields })
    } else {
      for (const id of change.ids) {
        const key = changedEntityKey(change.entity, id)
        const hash = JSON.stringify(key)
        if (change.kind === 'deleted') {
          gone.set(hash, key)
          refetch.delete(hash)
        } else if (!gone.has(hash)) {
          refetch.set(hash, key)
        }
      }
    }
  }
  return { patches, refetch: [...refetch.values()], gone: [...gone.values()], fields }
}

/**
 * The keys without repeats and without those a shorter key in the list already covers
 * (keys match by prefix, so `['library']` covers `['library', 'albums']`).
 */
export function coverKeys(keys: readonly QueryKey[]): QueryKey[] {
  const unique = new Map(keys.map((key) => [JSON.stringify(key), key]))
  const sorted = [...unique.values()].sort((a, b) => a.length - b.length)
  const kept: QueryKey[] = []
  for (const key of sorted) {
    if (!kept.some((shorter) => shorter.every((part, index) => JSON.stringify(part) === JSON.stringify(key[index])))) kept.push(key)
  }
  return kept
}

/**
 * Collects what the socket says over a short window and hands it over at once, so a burst
 * (a scan, an album arriving track by track) costs one pass over the cache and one refetch
 * per query rather than one per message.
 */
export class RealtimeBatch<Tag extends string = 'refetch'> {
  private keys = new Map<Tag, QueryKey[]>()
  private changes: EntityChange[] = []
  private timer: unknown

  constructor(
    private readonly flush: (batch: { keys: ReadonlyMap<Tag, QueryKey[]>; changes: EntityChange[] }) => void,
    private readonly delayMs = 100,
  ) {}

  /** Query keys to invalidate, under a tag the flush tells apart (how eagerly to refetch them). */
  invalidate(keys: readonly QueryKey[], tag: Tag = 'refetch' as Tag) {
    this.keys.set(tag, [...this.keys.get(tag) ?? [], ...keys])
    this.schedule()
  }

  change(changes: readonly EntityChange[]) {
    this.changes.push(...changes)
    this.schedule()
  }

  /** Hands over what is waiting now. */
  run() {
    clearTimer(this.timer)
    this.timer = undefined
    if (this.keys.size === 0 && this.changes.length === 0) return
    const keys = new Map([...this.keys].map(([tag, list]) => [tag, coverKeys(list)] as const))
    const changes = this.changes
    this.keys = new Map()
    this.changes = []
    this.flush({ keys, changes })
  }

  /** Drops what is waiting, for a socket that is going away. */
  clear() {
    clearTimer(this.timer)
    this.timer = undefined
    this.keys = new Map()
    this.changes = []
  }

  private schedule() {
    this.timer ??= setTimer(() => this.run(), this.delayMs)
  }
}
