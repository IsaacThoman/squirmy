import { z } from 'zod'
import { ClientDevice } from './auth.js'
import { Id } from './common.js'

/**
 * Playback session protocol.
 *
 * Each user has exactly one session, held by the server. Every connected client is a
 * controller; at most one of them, the active device, outputs audio. Clients send
 * commands, the server applies them with the shared reducer in @squirmy/client-core,
 * bumps `version`, and broadcasts. Clients run the same reducer optimistically.
 *
 * Position is never streamed. While `playing && !stalled`, the position at server time
 * `t` is `positionMs + (t - anchorAt)`, capped at the current entry's duration when that
 * is known (non-zero). Use `positionAt` from client-core rather than computing it.
 *
 * Entry ids are derived from the id of the command that created the entry
 * (`<commandId>.<n>`), so the server and a client running the same command on the same
 * state allocate the same ids, and a client's optimistic ids survive rebasing.
 */

export const RepeatMode = z.enum(['off', 'all', 'one'])
export type RepeatMode = z.infer<typeof RepeatMode>

/**
 * `preparing`: an on-demand track whose file is still being fetched. While the current
 * entry is preparing the session is stalled at position 0.
 * `failed`: it could not be fetched. A failed entry never becomes current; playback skips it.
 */
export const QueueEntryState = z.enum(['ready', 'preparing', 'failed'])
export type QueueEntryState = z.infer<typeof QueueEntryState>

export const QueueEntry = z.object({
  /**
   * Assigned by the reducer as `<commandId>.<n>`. Unique among `current`, `queue`,
   * `autoplayQueue` and `history`. A repeated track gets a fresh id each time it plays.
   */
  id: z.string(),
  trackId: Id,
  albumId: Id.nullable(),
  durationMs: z.number().int().nonnegative(),
  state: QueueEntryState,
})
export type QueueEntry = z.infer<typeof QueueEntry>

/**
 * What a client sends when it adds tracks; the reducer turns each into a QueueEntry.
 * `state` defaults to `ready`; send `preparing` for `on_demand` tracks.
 */
export const QueueSeed = z.object({
  trackId: Id,
  albumId: Id.nullable().optional(),
  durationMs: z.number().int().nonnegative(),
  state: z.enum(['ready', 'preparing']).optional(),
})
export type QueueSeed = z.infer<typeof QueueSeed>

export const PlaybackContext = z.object({
  type: z.enum(['album', 'playlist', 'artist', 'liked', 'search', 'radio', 'history', 'other']),
  id: z.string().nullable(),
  title: z.string().nullable(),
})
export type PlaybackContext = z.infer<typeof PlaybackContext>

/** The small, frequently changing half of the session. */
export const SessionState = z.object({
  current: QueueEntry.nullable(),
  /** Desired state. The active device makes it so. */
  playing: z.boolean(),
  positionMs: z.number().nonnegative(),
  /** Server epoch milliseconds at which `positionMs` was true. */
  anchorAt: z.number(),
  /** The active device is buffering, or the current entry is preparing. Time does not advance. */
  stalled: z.boolean(),
  activeDeviceId: z.string().nullable(),
  shuffle: z.boolean(),
  repeat: RepeatMode,
  autoplay: z.boolean(),
  context: PlaybackContext.nullable(),
  /** Per-device volume, 0..1, keyed by device id. */
  volumes: z.record(z.string(), z.number().min(0).max(1)),
})
export type SessionState = z.infer<typeof SessionState>

/** The large, rarely changing half. Sent only when `queueVersion` changes. */
export const SessionQueue = z.object({
  /** Up next, in play order. */
  queue: z.array(QueueEntry),
  /** Most recent last. Bounded. */
  history: z.array(QueueEntry),
  /** Server-suggested tracks played after the queue runs out when `autoplay` is on. */
  autoplayQueue: z.array(QueueEntry),
  /** Entry ids in their original collection order, kept so shuffle can be undone. */
  playOrder: z.array(z.string()),
  /** Entries played in the current repeat-all cycle, oldest first. Bounded. */
  playedInCycle: z.array(QueueEntry),
})
export type SessionQueue = z.infer<typeof SessionQueue>

export const SessionSnapshot = z.object({
  version: z.number().int(),
  queueVersion: z.number().int(),
  state: SessionState,
  queue: SessionQueue,
})
export type SessionSnapshot = z.infer<typeof SessionSnapshot>

const seeds = z.array(QueueSeed).min(1).max(5000)

/**
 * Commands any of the user's clients may send. Semantics, as implemented by
 * `reduceSession` in client-core:
 *
 * - `play`: resume; from 0 when paused at the end. With no current entry, starts the
 *   queue (or the autoplay queue).
 * - `next`: start the next playable entry: the queue, then a new repeat-all cycle, then
 *   the autoplay queue (when `autoplay`). With none, pause at the end of the current one.
 * - `previous`: restart the current entry when 3 s or more in (or with no history);
 *   otherwise step back through history, putting the current entry back at the front of
 *   the queue.
 * - `setShuffle`: on shuffles the queue with `seed` and remembers the collection order in
 *   `playOrder`; off restores that order.
 * - `playTracks`: replace the queue with `tracks` and start playing. `startIndex` indexes
 *   `tracks`; when omitted, the first track, or with shuffle the first of the shuffled
 *   order. Without shuffle the tracks before the start are not queued.
 * - `enqueue`: `next` inserts before the queue, `last` appends.
 * - `playQueueEntry`: play an entry of the queue or the autoplay queue now; the entries
 *   before it stay queued.
 * - `moveInQueue`: move an entry within its list (queue or autoplay queue). With shuffle
 *   on, the queue's new order becomes the order shuffle-off restores.
 */
export const SessionCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('next') }),
  z.object({ type: z.literal('previous') }),
  z.object({ type: z.literal('seek'), positionMs: z.number().nonnegative() }),
  z.object({ type: z.literal('setShuffle'), value: z.boolean(), seed: z.number().int() }),
  z.object({ type: z.literal('setRepeat'), value: RepeatMode }),
  z.object({ type: z.literal('setAutoplay'), value: z.boolean() }),
  z.object({
    type: z.literal('playTracks'),
    tracks: seeds,
    startIndex: z.number().int().min(0).optional(),
    shuffle: z.boolean().optional(),
    seed: z.number().int(),
    context: PlaybackContext.nullable().optional(),
  }),
  z.object({ type: z.literal('enqueue'), tracks: seeds, placement: z.enum(['next', 'last']) }),
  z.object({ type: z.literal('playQueueEntry'), entryId: z.string() }),
  z.object({ type: z.literal('removeFromQueue'), entryId: z.string() }),
  z.object({ type: z.literal('moveInQueue'), entryId: z.string(), toIndex: z.number().int().min(0) }),
  z.object({ type: z.literal('clearQueue') }),
  z.object({ type: z.literal('clearHistory') }),
  /** Makes `deviceId` the active device. Playback continues there from the current position. */
  z.object({ type: z.literal('transfer'), deviceId: z.string(), play: z.boolean().optional() }),
  z.object({ type: z.literal('setVolume'), deviceId: z.string(), value: z.number().min(0).max(1) }),
  /**
   * Active device only: the current entry finished naturally and the device has advanced.
   * Ignored unless `entryId` is the current entry, so replays are harmless. With repeat
   * one, the track restarts under a fresh entry id.
   */
  z.object({ type: z.literal('trackEnded'), entryId: z.string() }),
])
export type SessionCommand = z.infer<typeof SessionCommand>

/** Commands only the server issues. They go through the same reducer. */
export const ServerSessionCommand = z.discriminatedUnion('type', [
  /**
   * Updates every entry of the track. `ready` un-stalls a preparing current entry;
   * `failed` on the current entry advances to the next playable one.
   */
  z.object({ type: z.literal('setEntryState'), trackId: Id, state: QueueEntryState }),
  z.object({ type: z.literal('setAutoplayQueue'), tracks: z.array(QueueSeed) }),
  /** The active device disconnected and did not return within the grace period. */
  z.object({ type: z.literal('deviceLost'), deviceId: z.string() }),
  /**
   * Engine report from the active device, already validated. Apply it with
   * `now = report.at` (clamped to the server clock) so the anchor matches the engine.
   */
  z.object({
    type: z.literal('syncPosition'),
    entryId: z.string(),
    positionMs: z.number().nonnegative(),
    stalled: z.boolean(),
  }),
])
export type ServerSessionCommand = z.infer<typeof ServerSessionCommand>

/** Ground truth from the active device's audio engine. */
export const EngineReport = z.object({
  entryId: z.string(),
  status: z.enum(['playing', 'paused', 'buffering', 'error']),
  positionMs: z.number().nonnegative(),
  /** Sender's estimate of server time when the position was read. */
  at: z.number(),
})
export type EngineReport = z.infer<typeof EngineReport>

export const DeviceInfo = z.object({
  id: z.string(),
  name: z.string(),
  kind: ClientDevice.shape.kind,
  canPlay: z.boolean(),
  isActive: z.boolean(),
})
export type DeviceInfo = z.infer<typeof DeviceInfo>

export const SessionHello = z.object({ device: ClientDevice, canPlay: z.boolean() })
export type SessionHello = z.infer<typeof SessionHello>

export const SessionHelloAck = z.object({
  serverTime: z.number(),
  snapshot: SessionSnapshot,
  devices: z.array(DeviceInfo),
})
export type SessionHelloAck = z.infer<typeof SessionHelloAck>

/**
 * `commandId` is unique per user. Clients re-send unacknowledged commands after a
 * reconnect, so the server remembers recent command ids per session and acks a duplicate
 * with the current version without applying it again. It passes `commandId` to the
 * reducer, which derives new entry ids from it.
 */
export const CommandEnvelope = z.object({ commandId: z.string().min(1).max(64), command: SessionCommand })
export type CommandEnvelope = z.infer<typeof CommandEnvelope>

/**
 * `version` is the session version that includes the command (the current version for a
 * no-op or a duplicate). The server acks before it broadcasts the resulting update, so a
 * client that receives `session:state` at version v has already received the ack of
 * every command of its own that v includes.
 */
export const CommandAck = z.union([
  z.object({ ok: z.literal(true), version: z.number().int() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type CommandAck = z.infer<typeof CommandAck>

/** Pushed to clients so open screens refresh without polling. */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scan.progress'),
    rootId: Id,
    phase: z.enum(['discovering', 'probing', 'matching', 'idle']),
    processed: z.number().int(),
    total: z.number().int(),
  }),
  z.object({
    type: z.literal('acquisition.updated'),
    jobId: Id,
    trackId: Id.nullable(),
    status: z.string(),
  }),
  z.object({ type: z.literal('import.updated'), importId: Id, status: z.string() }),
])
export type ServerEvent = z.infer<typeof ServerEvent>

/** socket.io event maps. Use these to type both ends. */
export interface ClientToServerEvents {
  'session:hello': (hello: SessionHello, ack: (reply: SessionHelloAck) => void) => void
  'time:sync': (clientTime: number, ack: (reply: { clientTime: number; serverTime: number }) => void) => void
  'session:command': (envelope: CommandEnvelope, ack: (reply: CommandAck) => void) => void
  'session:report': (report: EngineReport) => void
}

/**
 * Every session change emits `session:state`. When the queue half also changed,
 * `session:queue` with the same `version` is emitted first; clients hold it until the
 * matching `session:state` arrives.
 */
export interface ServerToClientEvents {
  'session:state': (update: { version: number; state: SessionState }) => void
  'session:queue': (update: { version: number; queueVersion: number; queue: SessionQueue }) => void
  devices: (devices: DeviceInfo[]) => void
  /** TanStack Query keys to invalidate. See `queryKeys`. */
  invalidate: (update: { keys: readonly (readonly unknown[])[] }) => void
  event: (event: ServerEvent) => void
}

/**
 * Query keys shared by the clients and by server-side invalidations. Keys are prefix
 * matched, so invalidating `queryKeys.playlists()` also refreshes each playlist.
 */
export const queryKeys = {
  me: () => ['me'] as const,
  home: () => ['home'] as const,
  libraryAlbums: () => ['library', 'albums'] as const,
  libraryArtists: () => ['library', 'artists'] as const,
  libraryTracks: () => ['library', 'tracks'] as const,
  library: () => ['library'] as const,
  album: (id: string) => ['album', id] as const,
  artist: (id: string) => ['artist', id] as const,
  track: (id: string) => ['track', id] as const,
  lyrics: (id: string) => ['lyrics', id] as const,
  likes: () => ['likes'] as const,
  playlists: () => ['playlists'] as const,
  playlist: (id: string) => ['playlists', id] as const,
  history: () => ['history'] as const,
  wants: () => ['wants'] as const,
  search: () => ['search'] as const,
  settings: () => ['settings'] as const,
  admin: () => ['admin'] as const,
  adminRoots: () => ['admin', 'roots'] as const,
  adminJobs: () => ['admin', 'jobs'] as const,
  adminReviews: () => ['admin', 'reviews'] as const,
  adminUsers: () => ['admin', 'users'] as const,
  adminOrganize: () => ['admin', 'organize'] as const,
} as const
