import {
  QUEUE_LIMIT,
  type QueueEntry,
  type QueueSeed,
  ServerSessionCommand,
  SessionCommand,
  type SessionQueue,
  type SessionState,
} from '@squirmy/contracts'
import { z } from 'zod'

/** Most entries kept in `history`. */
export const HISTORY_LIMIT = 50
/** Most entries kept in `playedInCycle`; matches the largest `playTracks`. */
export const CYCLE_LIMIT = 5000
/** `previous` restarts the current entry when at least this far in. */
export const PREVIOUS_RESTART_MS = 3000
/**
 * Ids of entries that left the session may linger in `playOrder` (see the contract); once
 * it holds this many more than the session has entries, it is pruned.
 */
const PLAY_ORDER_SLACK = 200

/** The whole session as the reducer sees it: both halves of the wire format, flattened. */
export type Session = SessionState & SessionQueue

/** Anything the reducer accepts: a client command or a server-only command. */
export type AnySessionCommand = SessionCommand | ServerSessionCommand

export type SessionInput = {
  command: AnySessionCommand
  /** Server epoch milliseconds at which the command takes effect. */
  now: number
  /**
   * Id of the command (the envelope's `commandId`, or a fresh id for server commands).
   * Entries the command creates get ids `<commandId>.<n>`, so the same command on the
   * same state always yields the same result.
   */
  commandId: string
  /**
   * The device that sent the command. When the command starts playback while no device
   * is active, this device becomes active. Pass it only for devices that can play.
   * `trackEnded` from a device other than the active one is ignored.
   */
  deviceId?: string
}

const AnyCommand = z.union([SessionCommand, ServerSessionCommand])

/** An empty, paused session with no active device. */
export function createInitialSession(): Session {
  return {
    current: null,
    playing: false,
    positionMs: 0,
    anchorAt: 0,
    stalled: false,
    activeDeviceId: null,
    shuffle: false,
    repeat: 'off',
    autoplay: true,
    context: null,
    volumes: {},
    queue: [],
    history: [],
    autoplayQueue: [],
    playOrder: [],
    playedInCycle: [],
  }
}

/** Splits a session into its wire halves. */
export function splitSession(session: Session): { state: SessionState; queue: SessionQueue } {
  const { queue, history, autoplayQueue, playOrder, playedInCycle, ...state } = session
  return { state, queue: { queue, history, autoplayQueue, playOrder, playedInCycle } }
}

/** Joins the wire halves back into a session. */
export function joinSession(state: SessionState, queue: SessionQueue): Session {
  return { ...state, ...queue }
}

/**
 * True when the queue half differs, i.e. the server must bump `queueVersion` and emit
 * `session:queue`. The reducer keeps unchanged lists by identity, so this is cheap.
 */
export function queueChanged(previous: Session, next: Session): boolean {
  return previous.queue !== next.queue
    || previous.history !== next.history
    || previous.autoplayQueue !== next.autoplayQueue
    || previous.playOrder !== next.playOrder
    || previous.playedInCycle !== next.playedInCycle
}

/**
 * Position of the current entry at server time `now`, in milliseconds. Advances only
 * while `playing && !stalled`, and is capped at the entry's duration when it is known.
 */
export function positionAt(session: SessionState, now: number): number {
  if (!session.current) return 0
  const elapsed = session.playing && !session.stalled ? Math.max(0, now - session.anchorAt) : 0
  return capPosition(session.current, session.positionMs + elapsed)
}

/** A random seed for `setShuffle` and `playTracks`. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31)
}

/**
 * Applies one command. Pure and deterministic. Returns the same object when the command
 * is invalid, unknown or changes nothing, so callers can detect no-ops by identity.
 */
export function reduceSession(session: Session, input: SessionInput): Session {
  const parsed = AnyCommand.safeParse(input.command)
  if (!parsed.success) return session
  return reduceParsedSession(session, { ...input, command: parsed.data })
}

/**
 * `reduceSession` for a command that was already validated. A client replays its unsent
 * commands on every update; validating a 5,000-track `playTracks` each time is what made
 * that slow.
 */
export function reduceParsedSession(session: Session, input: SessionInput): Session {
  if (!Number.isFinite(input.now)) return session
  let serial = 0
  const context: Context = { now: input.now, deviceId: input.deviceId, nextId: () => `${input.commandId}.${(serial++).toString(36)}` }
  let next = apply(session, input.command, context)
  if (next === session) return session
  if (next.playOrder.length > next.queue.length + next.playedInCycle.length + 1 + PLAY_ORDER_SLACK) next = prunePlayOrder(next)
  if (next.playing && next.activeDeviceId === null && input.deviceId) return { ...next, activeDeviceId: input.deviceId }
  return next
}

type Context = { now: number; deviceId: string | undefined; nextId: () => string }

function apply(s: Session, command: AnySessionCommand, context: Context): Session {
  const { now } = context
  switch (command.type) {
    case 'play': {
      if (!s.current || s.current.state === 'failed') return advance(s, context, 'manual')
      if (s.playing) return s
      const atEnd = s.current.durationMs > 0 && s.positionMs >= s.current.durationMs
      return { ...s, playing: true, positionMs: atEnd ? 0 : s.positionMs, anchorAt: now }
    }
    case 'pause':
      return s.playing ? { ...reanchor(s, now), playing: false } : s
    case 'next':
      return advance(s, context, 'manual')
    case 'previous':
      return previous(s, now)
    case 'seek':
      if (!s.current || s.current.state === 'preparing') return s
      return { ...s, positionMs: capPosition(s.current, command.positionMs), anchorAt: now }
    case 'setShuffle':
      if (command.value === s.shuffle) return s
      return command.value ? shuffleOn(s, command.seed) : shuffleOff(s, context)
    case 'setRepeat':
      return command.value === s.repeat ? s : { ...s, repeat: command.value }
    case 'setAutoplay':
      return command.value === s.autoplay ? s : { ...s, autoplay: command.value }
    case 'playTracks': {
      const entries = command.tracks.map(seed => toEntry(seed, context.nextId()))
      const shuffle = command.shuffle ?? s.shuffle
      const order = shuffle ? shuffleEntries(entries, command.seed) : entries
      const start = command.startIndex === undefined ? order[0]! : entries[Math.min(command.startIndex, entries.length - 1)]!
      const at = order.indexOf(start)
      const upcoming = shuffle ? [...order.slice(at + 1), ...order.slice(0, at)] : order.slice(at + 1)
      return {
        ...startEntry(s, start, now, true),
        queue: upcoming,
        shuffle,
        playOrder: shuffle ? entries.map(entry => entry.id) : [],
        // Started from the middle of a collection, the tracks before the start lie behind
        // it as if skipped: previous steps back to them and repeat all comes round to them.
        playedInCycle: shuffle ? [] : order.slice(0, at),
        // Suggestions follow what plays: those made for the old queue would come back
        // after the new one, often repeating its tracks. The server suggests afresh.
        autoplayQueue: s.autoplayQueue.length ? [] : s.autoplayQueue,
        context: command.context ?? null,
      }
    }
    case 'enqueue': {
      // Refused whole rather than cut short, so the client and the server agree on it.
      if (s.queue.length + command.tracks.length > QUEUE_LIMIT) return s
      const entries = command.tracks.map(seed => ({ ...toEntry(seed, context.nextId()), queued: true }))
      const ids = entries.map(entry => entry.id)
      const first = command.placement === 'next'
      return {
        ...s,
        queue: first ? [...entries, ...s.queue] : [...s.queue, ...entries],
        playOrder: !s.shuffle ? s.playOrder : first ? [...ids, ...s.playOrder] : [...s.playOrder, ...ids],
      }
    }
    case 'playQueueEntry':
      return jump(s, command.entryId, now)
    case 'removeFromQueue': {
      const queue = remove(s.queue, item => item.id === command.entryId)
      const autoplayQueue = remove(s.autoplayQueue, item => item.id === command.entryId)
      if (queue === s.queue && autoplayQueue === s.autoplayQueue) return s
      return { ...s, queue, autoplayQueue, playOrder: remove(s.playOrder, id => id === command.entryId) }
    }
    case 'moveInQueue': {
      const queue = moveEntry(s.queue, command.entryId, command.toIndex)
      const autoplayQueue = moveEntry(s.autoplayQueue, command.entryId, command.toIndex)
      if (queue === s.queue && autoplayQueue === s.autoplayQueue) return s
      if (!s.shuffle || queue === s.queue) return { ...s, queue, autoplayQueue }
      // The queue's new order is the one shuffle-off restores, all of it after the current entry.
      const queued = new Set(queue.map(entry => entry.id))
      return { ...s, queue, autoplayQueue, playOrder: [...s.playOrder.filter(id => !queued.has(id)), ...queue.map(entry => entry.id)] }
    }
    case 'clearQueue':
      return s.queue.length || s.playOrder.length ? { ...s, queue: [], playOrder: [] } : s
    case 'clearHistory':
      return s.history.length ? { ...s, history: [] } : s
    case 'transfer': {
      const playing = (command.play ?? s.playing) && s.current !== null && s.current.state !== 'failed'
      if (command.deviceId === s.activeDeviceId && playing === s.playing) return s
      return { ...reanchor(s, now), activeDeviceId: command.deviceId, playing, stalled: isPreparing(s.current) }
    }
    case 'setVolume':
      if (s.volumes[command.deviceId] === command.value) return s
      return { ...s, volumes: { ...s.volumes, [command.deviceId]: command.value } }
    case 'trackEnded':
      if (!s.current || command.entryId !== s.current.id) return s
      if (context.deviceId && s.activeDeviceId && context.deviceId !== s.activeDeviceId) return s
      return advance(s, context, 'ended')
    case 'setEntryState':
      return setEntryState(s, command.trackId, command.state, context)
    case 'updateTracks':
      return updateTracks(s, command)
    case 'setAutoplayQueue': {
      if (!command.tracks.length && !s.autoplayQueue.length) return s
      return { ...s, autoplayQueue: command.tracks.slice(0, QUEUE_LIMIT).map(seed => toEntry(seed, context.nextId())) }
    }
    case 'deviceLost':
      if (s.activeDeviceId !== command.deviceId) return s
      return { ...reanchor(s, now), playing: false, activeDeviceId: null, stalled: isPreparing(s.current) }
    case 'syncPosition':
      if (!s.current || s.current.id !== command.entryId || s.current.state === 'preparing') return s
      return { ...s, positionMs: capPosition(s.current, command.positionMs), anchorAt: now, stalled: command.stalled }
  }
}

/**
 * Why playback moves on: `manual` (next, or play with nothing current), `ended` (the
 * current entry finished; honors repeat one) or `failed` (the current entry cannot be
 * fetched; keeps the play/pause state).
 */
type AdvanceReason = 'manual' | 'ended' | 'failed'

function advance(s: Session, context: Context, reason: AdvanceReason): Session {
  const { now, nextId } = context
  const playing = reason === 'failed' ? s.playing : true

  if (reason === 'ended' && s.repeat === 'one' && s.current && isPlayable(s.current)) {
    const again = { ...s.current, id: nextId() }
    return {
      ...s,
      current: again,
      positionMs: 0,
      anchorAt: now,
      stalled: isPreparing(again),
      history: [...s.history, s.current].slice(-HISTORY_LIMIT),
    }
  }

  // Failed entries at the front of a list are dropped on the way past.
  // Ids stay in playOrder as the entries go behind the current one: shuffle-off needs to
  // know where the current entry is in the collection.
  const queued = s.queue.findIndex(isPlayable)
  if (queued >= 0) return { ...startEntry(s, s.queue[queued]!, now, playing), queue: s.queue.slice(queued + 1) }
  const queue = s.queue.length ? [] : s.queue
  const playOrder = s.playOrder.length ? [] : s.playOrder

  if (s.repeat === 'all') {
    // The collection comes round again; what was added with Play next is not part of it.
    const played = s.current && isPlayable(s.current) ? [...s.playedInCycle, s.current] : s.playedInCycle
    const again = played.filter(entry => isPlayable(entry) && !entry.queued)
    const cycle = again.map(entry => ({ ...entry, id: nextId() }))
    const [first, ...rest] = cycle
    if (first) {
      const rank = ranks(s.playOrder)
      const order = again.map((entry, index) => ({ id: cycle[index]!.id, rank: rank.get(entry.id) ?? rank.size }))
      return {
        ...startEntry(s, first, now, playing),
        queue: rest,
        playOrder: s.shuffle ? order.sort((a, b) => a.rank - b.rank).map(item => item.id) : [],
        playedInCycle: [],
      }
    }
  }

  if (s.autoplay) {
    const suggested = s.autoplayQueue.findIndex(isPlayable)
    if (suggested >= 0) {
      return {
        ...startEntry(s, s.autoplayQueue[suggested]!, now, playing),
        queue,
        playOrder,
        autoplayQueue: s.autoplayQueue.slice(suggested + 1),
      }
    }
  }

  if (!s.current) return s
  if (isPreparing(s.current)) return { ...s, queue, playOrder, playing: false }
  const positionMs = reason === 'failed' ? 0 : s.current.durationMs || positionAt(s, now)
  return { ...s, queue, playOrder, playing: false, positionMs, anchorAt: now, stalled: false }
}

/**
 * Steps back through what lies behind the current entry in this cycle. `history` reaches
 * further, into whatever played before the collection started, which is not where back
 * should go; it is only the record of what was heard.
 */
function previous(s: Session, now: number): Session {
  const index = s.playedInCycle.findLastIndex(isPlayable)
  if (!s.current && index < 0) return s
  if (s.current && (index < 0 || positionAt(s, now) >= PREVIOUS_RESTART_MS)) {
    return s.current.state === 'preparing' ? s : { ...s, positionMs: 0, anchorAt: now }
  }
  const entry = s.playedInCycle[index]!
  const back = s.current && isPlayable(s.current) ? s.current : null
  return {
    ...s,
    current: entry,
    positionMs: 0,
    anchorAt: now,
    stalled: isPreparing(entry),
    queue: back ? [back, ...s.queue] : s.queue,
    playOrder: s.shuffle && back && !s.playOrder.includes(back.id) ? [back.id, ...s.playOrder] : s.playOrder,
    playedInCycle: s.playedInCycle.slice(0, index),
    // Entry ids are unique outside playedInCycle: one heard before is current again.
    history: remove(s.history, item => item.id === entry.id),
  }
}

/**
 * Plays an entry of the queue or the autoplay queue now, skipping what lies between: the
 * queue's entries go behind the current one, unplayed, so previous and repeat all still
 * reach them, except those added with Play next, which stay queued. Suggestions skipped
 * past are dropped.
 */
function jump(s: Session, entryId: string, now: number): Session {
  const inQueue = s.queue.findIndex(item => item.id === entryId)
  const inAutoplay = inQueue < 0 ? s.autoplayQueue.findIndex(item => item.id === entryId) : -1
  const entry = inQueue >= 0 ? s.queue[inQueue] : s.autoplayQueue[inAutoplay]
  if (!entry || entry.state === 'failed') return s
  const skipped = inQueue >= 0 ? s.queue.slice(0, inQueue) : s.queue
  const kept = skipped.filter(item => item.queued)
  const passed = skipped.filter(item => !item.queued && isPlayable(item))
  const started = startEntry(s, entry, now, true)
  return {
    ...started,
    queue: inQueue >= 0 ? [...kept, ...s.queue.slice(inQueue + 1)] : kept.length === s.queue.length ? s.queue : kept,
    playedInCycle: passed.length ? [...started.playedInCycle, ...passed].slice(-CYCLE_LIMIT) : started.playedInCycle,
    autoplayQueue: inAutoplay >= 0 ? s.autoplayQueue.slice(inAutoplay + 1) : s.autoplayQueue,
  }
}

/**
 * Shuffles what is still to come of the collection: the queue's entries, and those behind
 * the current one that were skipped rather than heard (started after, or jumped past).
 * Entries added with Play next keep their places. `playOrder` takes the collection order:
 * what lies behind, the current entry, then the queue.
 */
function shuffleOn(s: Session, seed: number): Session {
  const heard = new Set(s.history.map(entry => entry.id))
  const unheard = s.playedInCycle.filter(entry => !entry.queued && isPlayable(entry) && !heard.has(entry.id))
  const pulled = new Set(unheard.map(entry => entry.id))
  const behind = s.playedInCycle.filter(entry => !entry.queued)
  const order = [...behind, ...(s.current && !s.current.queued ? [s.current] : []), ...s.queue].map(entry => entry.id)
  return {
    ...s,
    shuffle: true,
    playOrder: [...new Set(order)],
    queue: fillSlots(s.queue, shuffleEntries([...unheard, ...s.queue.filter(entry => !entry.queued)], seed)),
    playedInCycle: pulled.size ? remove(s.playedInCycle, entry => pulled.has(entry.id)) : s.playedInCycle,
  }
}

/**
 * Puts the collection back in order around the current entry, as streaming apps do: what
 * comes before it lies behind it, unplayed, and what comes after is queued, including
 * entries heard while shuffled. Entries added with Play next keep their places. When the
 * current entry is not one of the collection's, only the queue is put back in order.
 */
function shuffleOff(s: Session, context: Context): Session {
  const rank = ranks(s.playOrder)
  const at = s.current ? rank.get(s.current.id) : undefined
  const sorted = (entries: QueueEntry[]) => [...entries].sort((a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size))
  const queueEntries = s.queue.filter(entry => !entry.queued)
  if (at === undefined) return { ...s, shuffle: false, playOrder: [], queue: fillSlots(s.queue, sorted(queueEntries)) }
  const ranked = (entry: QueueEntry) => !entry.queued && rank.has(entry.id) && isPlayable(entry)
  const behindRanked = s.playedInCycle.filter(ranked)
  const fromBehind = new Set(behindRanked.map(entry => entry.id))
  const collection = sorted([...behindRanked, ...queueEntries])
  const isBefore = (entry: QueueEntry) => (rank.get(entry.id) ?? rank.size) < at
  // An entry coming back from behind may be in history, so it is queued under a fresh id.
  const after = collection.filter(entry => !isBefore(entry)).map(entry => (fromBehind.has(entry.id) ? { ...entry, id: context.nextId() } : entry))
  return {
    ...s,
    shuffle: false,
    playOrder: [],
    queue: fillSlots(s.queue, after),
    playedInCycle: [...s.playedInCycle.filter(entry => !ranked(entry)), ...collection.filter(isBefore)].slice(-CYCLE_LIMIT),
  }
}

/**
 * The queue with its collection entries replaced by `entries`, in order, and those added
 * with Play next left where they are. Entries beyond the collection's places follow its
 * last one (the end, when it has none); places beyond `entries` close up.
 */
function fillSlots(queue: QueueEntry[], entries: QueueEntry[]): QueueEntry[] {
  const result: QueueEntry[] = []
  let used = 0
  let lastPlace = -1
  for (const entry of queue) {
    if (entry.queued) result.push(entry)
    else if (used < entries.length) {
      result.push(entries[used++]!)
      lastPlace = result.length - 1
    }
  }
  if (used < entries.length) {
    const at = lastPlace >= 0 ? lastPlace + 1 : result.length
    result.splice(at, 0, ...entries.slice(used))
  }
  return result
}

function ranks(order: readonly string[]): Map<string, number> {
  return new Map(order.map((id, index) => [id, index]))
}

/** `playOrder` without the ids of entries no longer behind, current or queued. */
function prunePlayOrder(s: Session): Session {
  const live = new Set([...s.playedInCycle, ...s.queue, ...(s.current ? [s.current] : [])].map(entry => entry.id))
  return { ...s, playOrder: s.playOrder.filter(id => live.has(id)) }
}

/** Follows catalog changes of tracks and albums into every entry. */
function updateTracks(s: Session, command: Extract<ServerSessionCommand, { type: 'updateTracks' }>): Session {
  const tracks = new Map(command.tracks.map(item => [item.trackId, item]))
  const albums = new Map((command.albums ?? []).map(item => [item.albumId, item.id]))
  const update = (entry: QueueEntry): QueueEntry => {
    const track = tracks.get(entry.trackId)
    const trackId = track?.id ?? entry.trackId
    const durationMs = track?.durationMs ?? entry.durationMs
    const albumId = entry.albumId === null ? null : albums.get(entry.albumId) ?? entry.albumId
    if (trackId === entry.trackId && durationMs === entry.durationMs && albumId === entry.albumId) return entry
    return { ...entry, trackId, durationMs, albumId }
  }
  const current = s.current && update(s.current)
  const next: Session = {
    ...s,
    current,
    queue: mapEntries(s.queue, update),
    history: mapEntries(s.history, update),
    autoplayQueue: mapEntries(s.autoplayQueue, update),
    playedInCycle: mapEntries(s.playedInCycle, update),
  }
  if (current === s.current) return queueChanged(s, next) ? next : s
  // A shorter length than the position the session holds is the end.
  return { ...next, positionMs: current ? capPosition(current, s.positionMs) : s.positionMs }
}

function setEntryState(s: Session, trackId: string, state: QueueEntry['state'], context: Context): Session {
  const update = (entry: QueueEntry) => entry.trackId === trackId && entry.state !== state ? { ...entry, state } : entry
  // A current entry that is ready has its file and may be playing it: a late failure is
  // for its future plays, never a reason to cut it off.
  const current = s.current && (state === 'failed' && s.current.state === 'ready' ? s.current : update(s.current))
  const next: Session = {
    ...s,
    current,
    queue: mapEntries(s.queue, update),
    history: mapEntries(s.history, update),
    autoplayQueue: mapEntries(s.autoplayQueue, update),
    playedInCycle: mapEntries(s.playedInCycle, update),
  }
  if (current === s.current && !queueChanged(s, next)) return s
  if (!current || current === s.current) return next
  if (state === 'failed') return advance(next, context, 'failed')
  if (state === 'preparing' || s.current?.state === 'preparing') {
    return { ...next, positionMs: 0, anchorAt: context.now, stalled: state === 'preparing' }
  }
  return next
}

function startEntry(s: Session, entry: QueueEntry, now: number, playing: boolean): Session {
  const finished = s.current && isPlayable(s.current) ? s.current : null
  return {
    ...s,
    current: entry,
    playing,
    positionMs: 0,
    anchorAt: now,
    stalled: isPreparing(entry),
    history: finished ? [...s.history, finished].slice(-HISTORY_LIMIT) : s.history,
    playedInCycle: finished ? [...s.playedInCycle, finished].slice(-CYCLE_LIMIT) : s.playedInCycle,
  }
}

function reanchor(s: Session, now: number): Session {
  return { ...s, positionMs: positionAt(s, now), anchorAt: now }
}

function capPosition(entry: QueueEntry, positionMs: number): number {
  return entry.durationMs > 0 ? Math.min(entry.durationMs, positionMs) : positionMs
}

function toEntry(seed: QueueSeed, id: string): QueueEntry {
  return { id, trackId: seed.trackId, albumId: seed.albumId ?? null, durationMs: seed.durationMs, state: seed.state ?? 'ready' }
}

function isPlayable(entry: QueueEntry): boolean {
  return entry.state !== 'failed'
}

function isPreparing(entry: QueueEntry | null): boolean {
  return entry?.state === 'preparing'
}

/** Like `filter` with the predicate negated, but returns `list` itself when nothing matches. */
function remove<T>(list: T[], match: (item: T) => boolean): T[] {
  const kept = list.filter(item => !match(item))
  return kept.length === list.length ? list : kept
}

/** Like `map`, but returns `list` itself when no item changed. */
function mapEntries(list: QueueEntry[], update: (entry: QueueEntry) => QueueEntry): QueueEntry[] {
  let changed = false
  const mapped = list.map(entry => {
    const next = update(entry)
    if (next !== entry) changed = true
    return next
  })
  return changed ? mapped : list
}

function moveEntry(entries: QueueEntry[], id: string, toIndex: number): QueueEntry[] {
  const from = entries.findIndex(entry => entry.id === id)
  if (from < 0) return entries
  const destination = Math.min(toIndex, entries.length - 1)
  if (from === destination) return entries
  const result = [...entries]
  const [entry] = result.splice(from, 1)
  result.splice(destination, 0, entry!)
  return result
}

/** Seeded Fisher-Yates with an LCG. Never returns the input order for two or more entries. */
function shuffleEntries<T>(entries: readonly T[], seed: number): T[] {
  const result = [...entries]
  let state = seed >>> 0
  for (let end = result.length - 1; end > 0; end -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const index = Math.floor(state / 4294967296 * (end + 1))
    const entry = result[end]!
    result[end] = result[index]!
    result[index] = entry
  }
  if (result.length > 1 && result.every((value, index) => value === entries[index])) {
    return [...result.slice(1), result[0]!]
  }
  return result
}
