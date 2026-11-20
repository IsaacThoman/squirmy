import {
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
  if (!parsed.success || !Number.isFinite(input.now)) return session
  let serial = 0
  const context: Context = { now: input.now, deviceId: input.deviceId, nextId: () => `${input.commandId}.${(serial++).toString(36)}` }
  const next = apply(session, parsed.data, context)
  if (next !== session && next.playing && next.activeDeviceId === null && input.deviceId) {
    return { ...next, activeDeviceId: input.deviceId }
  }
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
    case 'setShuffle': {
      if (command.value === s.shuffle) return s
      if (command.value) {
        return { ...s, shuffle: true, playOrder: s.queue.map(entry => entry.id), queue: shuffleEntries(s.queue, command.seed) }
      }
      const order = new Map(s.playOrder.map((id, index) => [id, index]))
      const rank = (entry: QueueEntry) => order.get(entry.id) ?? order.size
      return { ...s, shuffle: false, playOrder: [], queue: [...s.queue].sort((a, b) => rank(a) - rank(b)) }
    }
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
      const upcomingIds = new Set(upcoming.map(entry => entry.id))
      return {
        ...startEntry(s, start, now, true),
        queue: upcoming,
        shuffle,
        playOrder: shuffle ? entries.filter(entry => upcomingIds.has(entry.id)).map(entry => entry.id) : [],
        playedInCycle: [],
        context: command.context ?? null,
      }
    }
    case 'enqueue': {
      const entries = command.tracks.map(seed => toEntry(seed, context.nextId()))
      const ids = entries.map(entry => entry.id)
      const first = command.placement === 'next'
      return {
        ...s,
        queue: first ? [...entries, ...s.queue] : [...s.queue, ...entries],
        playOrder: !s.shuffle ? s.playOrder : first ? [...ids, ...s.playOrder] : [...s.playOrder, ...ids],
      }
    }
    case 'playQueueEntry': {
      const entry = s.queue.find(item => item.id === command.entryId)
        ?? s.autoplayQueue.find(item => item.id === command.entryId)
      if (!entry || entry.state === 'failed') return s
      const matches = (id: string) => id === entry.id
      return {
        ...startEntry(s, entry, now, true),
        queue: remove(s.queue, item => matches(item.id)),
        playOrder: remove(s.playOrder, matches),
        autoplayQueue: remove(s.autoplayQueue, item => matches(item.id)),
      }
    }
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
      return { ...s, queue, autoplayQueue, playOrder: s.shuffle && queue !== s.queue ? queue.map(entry => entry.id) : s.playOrder }
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
    case 'setAutoplayQueue': {
      if (!command.tracks.length && !s.autoplayQueue.length) return s
      return { ...s, autoplayQueue: command.tracks.map(seed => toEntry(seed, context.nextId())) }
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
  const queued = s.queue.findIndex(isPlayable)
  if (queued >= 0) {
    const passed = new Set(s.queue.slice(0, queued + 1).map(entry => entry.id))
    return {
      ...startEntry(s, s.queue[queued]!, now, playing),
      queue: s.queue.slice(queued + 1),
      playOrder: remove(s.playOrder, id => passed.has(id)),
    }
  }
  const queue = s.queue.length ? [] : s.queue
  const playOrder = s.playOrder.length ? [] : s.playOrder

  if (s.repeat === 'all') {
    const played = s.current && isPlayable(s.current) ? [...s.playedInCycle, s.current] : s.playedInCycle
    const cycle = played.filter(isPlayable).map(entry => ({ ...entry, id: nextId() }))
    const [first, ...rest] = cycle
    if (first) {
      return {
        ...startEntry(s, first, now, playing),
        queue: rest,
        playOrder: s.shuffle ? rest.map(entry => entry.id) : [],
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

function previous(s: Session, now: number): Session {
  const index = s.history.findLastIndex(isPlayable)
  if (!s.current && index < 0) return s
  if (s.current && (index < 0 || positionAt(s, now) >= PREVIOUS_RESTART_MS)) {
    return s.current.state === 'preparing' ? s : { ...s, positionMs: 0, anchorAt: now }
  }
  const entry = s.history[index]!
  const back = s.current && isPlayable(s.current) ? [s.current] : []
  return {
    ...s,
    current: entry,
    positionMs: 0,
    anchorAt: now,
    stalled: isPreparing(entry),
    queue: [...back, ...s.queue],
    playOrder: s.shuffle ? [...back.map(item => item.id), ...s.playOrder] : s.playOrder,
    history: s.history.slice(0, index),
    playedInCycle: remove(s.playedInCycle, item => item.id === entry.id),
  }
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
