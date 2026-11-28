import { z } from 'zod'
import { ClientDevice } from './auth.js'
import { Id } from './common.js'
import { NormalizationMode, PlaybackSource, StreamProfile, TranscodeReason } from './playback.js'
import type { EntityChanges } from './realtime.js'

/**
 * Playback session protocol.
 *
 * Each user has one shared session, held by the server. Every connected client is a
 * controller of it; at most one of them, the active device, outputs audio. Clients send
 * commands, the server applies them with the shared reducer in @squirmy/client-core,
 * bumps `version`, and broadcasts. Clients run the same reducer optimistically.
 *
 * A device may detach from the shared session and play on its own; see "Detaching"
 * further down. Everything else in this file applies to either kind of session.
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

/**
 * Why a track could not be fetched, which decides what a listener is told (`playback.failed`).
 * `unavailable`: the provider does not have it (no free offer, a delivery that was not the
 * track, a recent miss) or this user may not fetch it; playback skips it with a light
 * notice and goes on. `outage`: the provider is failing or could not be reached; the
 * session pauses with the reason. `error`: anything else; skipped, and several in a row
 * pause the session. Servers that do not say why mean `error`.
 */
export const EntryFailure = z.enum(['unavailable', 'outage', 'error'])
export type EntryFailure = z.infer<typeof EntryFailure>

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
  /**
   * Added with `enqueue` (Play next, Add to queue) rather than from what `playTracks`
   * started. Such an entry keeps its place when the queue is shuffled or jumped past, and
   * a repeat-all cycle leaves it out. Absent on every other entry, and from older servers.
   */
  queued: z.boolean().optional(),
  /**
   * In a listening session ("Listen together"), the user who added the entry. The server
   * sets it on the entries it makes while a jam is on; clients never send it. Absent
   * otherwise, and from older servers.
   */
  addedBy: Id.optional(),
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
  /** Set by the server only (see `QueueEntry.addedBy`); the server drops it from what clients send. */
  addedBy: Id.optional(),
})
export type QueueSeed = z.infer<typeof QueueSeed>

/**
 * Where playback was started from. A `playTracks` whose context is an `album`, `playlist`
 * or `artist` (with its id) or `liked` is a play of that collection: the server records it
 * for the Library's "Recently played" (`LibraryItem.playedAt`). So a page sends its own
 * context for Play, Shuffle and its song rows, and a song started anywhere else (Search,
 * Home, a radio, the history) names that place instead, not the song's album. A `mix` is a
 * mix made for the user, with its id; plays remember their context, which is how Home's Jump
 * back in finds the albums, playlists, artists, mixes and radios the user played from.
 */
export const PlaybackContext = z.object({
  type: z.enum(['album', 'playlist', 'artist', 'liked', 'search', 'radio', 'mix', 'history', 'other']),
  id: z.string().nullable(),
  title: z.string().nullable(),
})
export type PlaybackContext = z.infer<typeof PlaybackContext>

/**
 * Sleep timer.
 *
 * A sleep timer belongs to the session, not to a device: set from any controller, it stops
 * whatever device plays the session, and it stays through a transfer. The server enforces it,
 * so it works while the device that set it sleeps or is gone.
 *
 * - `time`: playback pauses at `endsAt` (server epoch milliseconds). The server pauses the
 *   session then (`endSleepTimer`) and clears the timer, whether or not it was playing.
 *   `durationMs` is the length that was chosen, for display.
 * - `track`: playback stops when the current entry ends naturally (`trackEnded`): the session
 *   moves on to what would play next and pauses on it. Skipping keeps the timer: it stops at
 *   the end of whatever song is playing.
 * - `queue`: the same at the end of the last entry of the queue, before a repeat-all cycle
 *   or the autoplay queue would start.
 *
 * The device that plays fades its own output (never the session's volume) over the last
 * `SLEEP_FADE_MS` before the stop, where it can tell when that is.
 *
 * Servers without the `sleepTimer` capability neither send the field nor accept
 * `setSleepTimer`. Clients that do not know the field ignore it; the server still pauses
 * playback on them.
 */
export const SleepTimer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), endsAt: z.number(), durationMs: z.number().int().positive() }),
  z.object({ kind: z.literal('track') }),
  z.object({ kind: z.literal('queue') }),
])
export type SleepTimer = z.infer<typeof SleepTimer>

/** Longest `time` sleep timer `setSleepTimer` takes. */
export const SLEEP_TIMER_MAX_MS = 24 * 60 * 60_000
/** How long before a sleep timer stops playback the playing device starts fading out. */
export const SLEEP_FADE_MS = 10_000

/** What `setSleepTimer` asks for: a length of time from now, or the end of the song or of the queue. */
export const SleepTimerRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), durationMs: z.number().int().positive().max(SLEEP_TIMER_MAX_MS) }),
  z.object({ kind: z.literal('track') }),
  z.object({ kind: z.literal('queue') }),
])
export type SleepTimerRequest = z.infer<typeof SleepTimerRequest>

/**
 * Listen together (a "jam").
 *
 * A user (the host) opens their shared session to other users of the same server. Each
 * member listens on their own device, in step: the jam is the host's shared session, and
 * every member's shared session follows it. The server copies the host's session into each
 * member's (current entry, position anchor, queue, shuffle, repeat, autoplay, context),
 * keeping what is the member's own: their active device and volumes. Every
 * device plays locally from the same position anchor on the server clock, so they stay
 * together the way a device follows a seek; a member's device also corrects its own drift
 * against the anchor (`JAM_DRIFT_MS`). Plays are recorded for each listener from their own
 * session, with the usual skip and completion rules.
 *
 * - **Who controls what.** The host controls playback: play, pause, seek, skip, what plays
 *   (`playTracks`), shuffle, repeat, autoplay and the queue's order. With `queuePolicy`
 *   `everyone`, members may add to the queue (`enqueue`) and remove what they added; with
 *   `host`, only the host may. Members' other playback commands are refused `jam_host_only`;
 *   `transfer` and `setVolume` stay theirs, within their own devices.
 * - **Sleep timer.** The host's session holds it; when it ends the jam pauses, and with it
 *   every member's session. Members' copies carry none (so their devices do not fade out;
 *   they pause with the jam), a timer a member had set goes when they join, and their
 *   `setSleepTimer` is refused `jam_unsupported`.
 * - **Undo.** The host's undo stack holds the host's own queue edits, and undoing one changes
 *   the jam for everyone. Members' edits are not kept on it, and a member's `undo` is refused
 *   `jam_host_only`. Joining empties the member's own stack, whose edits were to the queue the
 *   jam replaces.
 * - **Queue diffs and signal path.** Each member's session counts its own versions, so
 *   `session:queueOps` and `session:sync` work on it as on any session; a member's device that
 *   does not accept queue operations gets the whole queue. Each listener's active device
 *   reports its own signal path, kept on and shown in that listener's session alone.
 * - **A song a member cannot play.** The playback descriptor of an entry may be refused for a
 *   member (explicit content off for them, `explicit_not_allowed`): their device sits it out,
 *   silent, and plays along again when the jam moves on. It does not skip or pause, which
 *   are the host's, and the server records no play of it for them.
 * - **Track ends.** Any listener's `trackEnded` near the end of the jam's current entry
 *   advances the jam, so the first device to finish moves everyone on.
 * - **Joining.** By the jam's `id`, which the invite link carries: any signed-in user of the
 *   server with the link may join, up to `JAM_MEMBER_LIMIT`. Joining replaces what the
 *   member's shared session held, and makes the joining device active when it can play.
 *   A detached device cannot join (`jam_detached`), and a host cannot join another jam
 *   (`jam_hosting`); a member of another jam leaves it first.
 * - **Leaving.** A member who leaves (or is removed) keeps a paused copy of what was
 *   playing. When the host ends the jam every member's copy pauses the same way.
 * - **Older clients.** Without the `jam` capability a client sees an ordinary session that
 *   other people change; its refused commands are undone as any refused command is.
 */
export const JamQueuePolicy = z.enum(['everyone', 'host'])
export type JamQueuePolicy = z.infer<typeof JamQueuePolicy>

export const JamMember = z.object({
  userId: Id,
  /** The user's display name, else their username. */
  name: z.string(),
  /** Server epoch milliseconds. */
  joinedAt: z.number(),
})
export type JamMember = z.infer<typeof JamMember>

export const JamInfo = z.object({
  /** Random and unguessable: the invite link carries it. */
  id: z.string().min(16).max(64),
  hostUserId: Id,
  /** The host first, then members in the order they joined. */
  members: z.array(JamMember),
  queuePolicy: JamQueuePolicy,
  /** Server epoch milliseconds. */
  startedAt: z.number(),
  /** Whose session this is: the host's, which is the jam, or a member's, which follows it. */
  role: z.enum(['host', 'member']),
})
export type JamInfo = z.infer<typeof JamInfo>

/** Most people in one jam, the host included. */
export const JAM_MEMBER_LIMIT = 16
/** A member's device further than this from the jam's position seeks back to it. */
export const JAM_DRIFT_MS = 300

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
  /** Absent while no sleep timer is set, and from servers without the `sleepTimer` capability. See "Sleep timer". */
  sleepTimer: SleepTimer.optional(),
  /** Present while the session hosts or follows a jam, on servers with the `jam` capability. See "Listen together". */
  jam: JamInfo.optional(),
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
  /**
   * While shuffled, entry ids in their original collection order, kept so shuffle can be
   * undone: every entry of the queue, and the current entry and those behind it when they
   * came from the same collection. Ids of entries no longer in the session may linger.
   * Empty while not shuffled.
   */
  playOrder: z.array(z.string()),
  /**
   * What lies behind the current entry in the current repeat-all cycle, oldest first:
   * entries played, and those of the collection the session started after or skipped
   * past. `previous` steps back through it, and repeat all plays it again. Bounded.
   */
  playedInCycle: z.array(QueueEntry),
})
export type SessionQueue = z.infer<typeof SessionQueue>

/**
 * Which session a snapshot is of: the user's shared one, or the own session of a detached
 * device, which only that device sees and controls.
 */
export const SessionScope = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shared') }),
  z.object({ type: z.literal('device'), deviceId: z.string() }),
])
export type SessionScope = z.infer<typeof SessionScope>

export const SessionSnapshot = z.object({
  version: z.number().int(),
  queueVersion: z.number().int(),
  state: SessionState,
  queue: SessionQueue,
  /**
   * Absent from servers that cannot detach devices, where every session is the shared one.
   * Each session counts its own `version` and `queueVersion`.
   */
  scope: SessionScope.optional(),
})
export type SessionSnapshot = z.infer<typeof SessionSnapshot>

/**
 * Queue diffs.
 *
 * A client that says `accepts: ['queueOps']` in its hello, on a server with the `queueOps`
 * capability, gets most queue changes as `session:queueOps` instead of `session:queue`: a
 * few operations on the queue it holds, rather than the whole queue again (a track end on
 * a 10,000-entry queue is a few hundred bytes instead of megabytes). The full queue still
 * comes as `session:queue`, a checkpoint, when the operations would be large (a new
 * `playTracks`, a reshuffle), and in every hello and move answer. Every other client gets
 * `session:queue` as before.
 *
 * Operations name the lists of `SessionQueue` and apply in order, each to the list as the
 * operations before it left it. Lists they do not name are unchanged. An entry inserted or
 * patched is either a whole entry or `{ ref: id }`: the entry with that id the client
 * already holds (in any list of the base queue, or inlined by an earlier operation of the
 * same message, which wins). `playOrder` holds ids, so its insertions are strings.
 *
 * - `splice`: at `at`, remove `remove` items and insert `insert`.
 * - `removeIds`: remove every item whose id is in `ids`.
 * - `permute`: reorder `from.length` items starting at `at`: the item now at `at + i` is the
 *   one that was at `at + from[i]`.
 * - `patch`: replace the entry at `at` (same id, another state or track).
 *
 * A client applies them to the queue of version `baseQueueVersion`. When it does not hold
 * that version, the `scope` is not the session it holds, a ref is unknown, an operation
 * does not fit the list, or the lengths afterwards differ from `lengths`, it asks for the
 * whole queue with `session:sync` and keeps applying `session:state` meanwhile.
 */
export const QueueListName = z.enum(['queue', 'history', 'autoplayQueue', 'playOrder', 'playedInCycle'])
export type QueueListName = z.infer<typeof QueueListName>

/** An entry the client already holds, by id. */
export const QueueEntryRef = z.object({ ref: z.string() })
export type QueueEntryRef = z.infer<typeof QueueEntryRef>

/** An item a queue operation inserts: an entry or a ref for the entry lists, an id for `playOrder`. */
export const QueueOpItem = z.union([QueueEntry, QueueEntryRef, z.string()])
export type QueueOpItem = z.infer<typeof QueueOpItem>

const index = z.number().int().nonnegative()

export const QueueOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('splice'), list: QueueListName, at: index, remove: index, insert: z.array(QueueOpItem) }),
  z.object({ op: z.literal('removeIds'), list: QueueListName, ids: z.array(z.string()) }),
  z.object({ op: z.literal('permute'), list: QueueListName, at: index, from: z.array(index) }),
  z.object({ op: z.literal('patch'), list: QueueListName, at: index, entry: z.union([QueueEntry, QueueEntryRef]) }),
])
export type QueueOp = z.infer<typeof QueueOp>

/** The lengths of the five lists, for checking a diff. */
export const QueueLengths = z.object({
  queue: index,
  history: index,
  autoplayQueue: index,
  playOrder: index,
  playedInCycle: index,
})
export type QueueLengths = z.infer<typeof QueueLengths>

/** `session:queueOps`: the queue of `queueVersion`, as operations on that of `baseQueueVersion`. See "Queue diffs". */
export const SessionQueueOps = z.object({
  version: z.number().int(),
  queueVersion: z.number().int(),
  baseQueueVersion: z.number().int(),
  scope: SessionScope,
  lengths: QueueLengths,
  ops: z.array(QueueOp),
})
export type SessionQueueOps = z.infer<typeof SessionQueueOps>

/**
 * Answer to `session:sync`: the session as it is now, with the whole queue. Errors:
 * `hello_required`, `rate_limited`, `internal_error`.
 */
export const SessionSyncAck = z.union([
  z.object({ ok: z.literal(true), snapshot: SessionSnapshot }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type SessionSyncAck = z.infer<typeof SessionSyncAck>

/** Most tracks one `playTracks` or `enqueue` carries. */
export const COMMAND_TRACK_LIMIT = 5000

/**
 * Most entries `queue` grows to. The session lives in the server's memory and is sent
 * whole on every queue change, so it has to stay small enough to copy and send often.
 * `enqueue` past it is refused (`queue_full`); `previous` may still put the few entries
 * of `history` back in front of a full queue.
 */
export const QUEUE_LIMIT = 10_000

const seeds = z.array(QueueSeed).min(1).max(COMMAND_TRACK_LIMIT)

/**
 * Commands any of the user's clients may send. Semantics, as implemented by
 * `reduceSession` in client-core:
 *
 * - `play`: resume; from 0 when paused at the end. With no current entry, starts the
 *   queue (or the autoplay queue).
 * - `next`: start the next playable entry: the queue, then a new repeat-all cycle (of
 *   `playedInCycle` and the current entry, without `queued` ones), then the autoplay queue
 *   (when `autoplay`). With none, pause at the end of the current one.
 * - `previous`: restart the current entry when 3 s or more in (or with nothing behind it
 *   in `playedInCycle`); otherwise step back to the last playable entry there, putting the
 *   current entry back at the front of the queue. It never goes back past the `playTracks`
 *   that started the cycle, into what played before. With `restart: false` it never
 *   restarts: it steps back however far in, and does nothing with nothing to step back to
 *   (a swipe on the mini-player, which shows the song it goes back to).
 * - `setShuffle`: on shuffles the collection's entries still to come with `seed`: those
 *   of the queue, and those behind the current one that were skipped rather than played
 *   (not in `history`). `queued` entries keep their places. The collection order is kept
 *   in `playOrder`. Off restores that order around the current entry: entries that come
 *   before it go behind it, unplayed, and the rest stay queued.
 * - `playTracks`: replace the queue with `tracks` and start playing. `startIndex` indexes
 *   `tracks`; when omitted, the first track, or with shuffle the first of the shuffled
 *   order. Without shuffle the tracks before the start go behind it in `playedInCycle`,
 *   so `previous` and repeat all reach them; with shuffle every other track is queued.
 *   The autoplay queue is emptied, so the server suggests tracks for the new ones.
 *   `startedFrom` says what the listener pressed: `song`, a song of the list by name (its row),
 *   so if that song cannot be had playback stays on it, paused, and says why; `collection`,
 *   the list as a whole (a header's Play or Shuffle, a card's Play, a radio), so playback moves
 *   on to the next song that plays, as streaming apps skip a grayed-out first song. Left out, as
 *   older clients send it, it is `collection`: they keep the behavior they were built for.
 * - `enqueue`: `next` inserts before the queue, `last` appends. The entries are `queued`.
 *   Changes nothing when the queue would grow past `QUEUE_LIMIT`.
 * - `playQueueEntry`: play an entry of the queue or the autoplay queue now, as streaming
 *   apps do: what lies between the current entry and it is skipped. Skipped entries of the
 *   queue go behind the current one in `playedInCycle`, unplayed, except `queued` ones,
 *   which stay at the front of the queue; skipped suggestions of the autoplay queue are
 *   dropped.
 * - `moveInQueue`: move an entry within its list (queue or autoplay queue). With shuffle
 *   on, the queue's new order becomes the order shuffle-off restores.
 * - `undo`: see "Undo" below. Only servers with the `undo` capability accept it; the
 *   reducer leaves the session as it is, and the server's answer brings the change.
 */
export const SessionCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('next') }),
  z.object({ type: z.literal('previous'), restart: z.boolean().optional() }),
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
    startedFrom: z.enum(['song', 'collection']).optional(),
  }),
  z.object({ type: z.literal('enqueue'), tracks: seeds, placement: z.enum(['next', 'last']) }),
  z.object({ type: z.literal('playQueueEntry'), entryId: z.string() }),
  z.object({ type: z.literal('removeFromQueue'), entryId: z.string() }),
  z.object({ type: z.literal('moveInQueue'), entryId: z.string(), toIndex: z.number().int().min(0) }),
  z.object({ type: z.literal('clearQueue') }),
  z.object({ type: z.literal('clearHistory') }),
  /** Undoes the queue edit sent as `commandId`. See "Undo". */
  z.object({ type: z.literal('undo'), commandId: z.string().min(1).max(64) }),
  /**
   * Makes `deviceId` the active device. Playback continues there from the current position.
   * Refused (`device_unavailable`) for a device that is not connected, cannot play, or is
   * not in this session: a detached device from the shared session, and any device but
   * itself from a detached device's own session.
   */
  z.object({ type: z.literal('transfer'), deviceId: z.string(), play: z.boolean().optional() }),
  z.object({ type: z.literal('setVolume'), deviceId: z.string(), value: z.number().min(0).max(1) }),
  /**
   * Sets the session's sleep timer, replacing any, or turns it off with `null`. A `time` timer
   * ends `durationMs` after the command takes effect. Only servers with the `sleepTimer`
   * capability accept it. See "Sleep timer".
   */
  z.object({ type: z.literal('setSleepTimer'), timer: SleepTimerRequest.nullable() }),
  /**
   * Active device only: the current entry finished naturally and the device has advanced.
   * Ignored unless `entryId` is the current entry, so replays are harmless. With repeat
   * one, the track restarts under a fresh entry id.
   */
  z.object({ type: z.literal('trackEnded'), entryId: z.string() }),
])
export type SessionCommand = z.infer<typeof SessionCommand>

/**
 * Undo.
 *
 * The server keeps, per session and in memory only, the last `UNDO_LIMIT` queue edits, each
 * for `UNDO_KEEP_MS`: `removeFromQueue`, `enqueue`, `moveInQueue` and `clearQueue`. `undo`
 * names one by the `commandId` it was sent with, from any device of the session:
 *
 * - `removeFromQueue`: the entry goes back after the entry that was before it (by id; at the
 *   front when that one has gone), and into `playOrder` the same way while shuffled.
 * - `enqueue`: the entries it added that are still in the queue are removed.
 * - `moveInQueue`: the entry moves back after the entry that was before it.
 * - `clearQueue`: the entries go back in front of what was queued since, and while shuffled
 *   their `playOrder`.
 *
 * Undo works by ids, so later edits from any device do not break it. An undo is applied as
 * an ordinary change (versions move on, the queue goes out as usual) and removes its edit
 * from the stack. `playTracks`, Subsonic's `savePlayQueue`, attaching with `bringQueue` and
 * joining a jam empty the stack. In a jam only the host undoes (see "Listen together"). Errors: `nothing_to_undo` (the edit is not kept, or nothing of it is
 * left to undo), `queue_full`.
 */
export const UNDO_LIMIT = 20
export const UNDO_KEEP_MS = 15 * 60_000
/** The commands `undo` can undo. */
export const UNDOABLE_COMMANDS = ['removeFromQueue', 'enqueue', 'moveInQueue', 'clearQueue'] as const satisfies readonly SessionCommand['type'][]

/** Commands only the server issues. They go through the same reducer. */
export const ServerSessionCommand = z.discriminatedUnion('type', [
  /**
   * Updates every entry of the track. `ready` un-stalls a preparing current entry;
   * `failed` on a preparing current entry advances to the next playable one, and leaves a
   * ready current entry as it is.
   */
  z.object({ type: z.literal('setEntryState'), trackId: Id, state: QueueEntryState }),
  /**
   * The catalog rows of tracks changed: every entry holding `trackId` takes the track id
   * `id` (where the row was merged into another; the same id otherwise) and `durationMs`.
   * `albums` does the same for entries' album ids. Entry ids and states stay, so a device
   * playing the current entry goes on as it is.
   */
  z.object({
    type: z.literal('updateTracks'),
    tracks: z.array(z.object({ trackId: Id, id: Id, durationMs: z.number().int().nonnegative() })),
    albums: z.array(z.object({ albumId: Id, id: Id })).optional(),
  }),
  z.object({ type: z.literal('setAutoplayQueue'), tracks: z.array(QueueSeed) }),
  /**
   * A `time` sleep timer ran out: pause where playback is and clear the timer. Ignored unless
   * such a timer is set and has ended by `now`.
   */
  z.object({ type: z.literal('endSleepTimer') }),
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

/**
 * Signal path: what the active device is playing, as it plays it, so every client's Now
 * Playing can tell the file from what reaches the speakers.
 *
 * The active device sends `session:signal` (servers with the `signal` capability) each time
 * it starts an entry, when what it says changes (its normalization setting, album or track
 * gain), and after every hello or move. The server keeps the latest per session, in memory
 * only, and sends it to the sockets in that session; a hello's answer carries it. It describes
 * `entryId` on `deviceId` and nothing else: clients show it only while that entry is current
 * and that device active, so it never has to be cleared. A device that does not report
 * (an older app) leaves its listeners with none.
 */
export const SignalReport = z.object({
  entryId: z.string(),
  trackId: Id,
  /** The file. Null when the descriptor came from a server that did not describe it. */
  source: PlaybackSource.nullable(),
  /** What reaches the device. */
  delivery: z.object({
    profile: StreamProfile,
    transcoded: z.boolean(),
    codec: z.string(),
    lossless: z.boolean(),
    bitrate: z.number().int().nullable(),
    sampleRate: z.number().int().nullable(),
    bitDepth: z.number().int().nullable(),
    /** Why it is a transcode; null when it is not, or the server did not say. */
    reason: TranscodeReason.nullable(),
    /** Played from a copy on the device (a download, or the streaming cache) rather than streamed. */
    local: z.boolean(),
  }),
  /**
   * Loudness normalization: the device's setting, which gain it applies (null when none:
   * off, or no loudness data) and the change in dB after peak limiting, against the -18 LUFS
   * reference of `Normalization`.
   */
  normalization: z.object({
    mode: NormalizationMode,
    applied: z.enum(['track', 'album']).nullable(),
    gainDb: z.number().nullable(),
  }),
})
export type SignalReport = z.infer<typeof SignalReport>

/** A `SignalReport` as the server passes it on: `deviceId` is the device that sent it. */
export const SignalPath = SignalReport.extend({ deviceId: z.string() })
export type SignalPath = z.infer<typeof SignalPath>

/**
 * Presence.
 *
 * A device is listed (in `devices`, hello answers and `GET /me/devices`) only while it is
 * live: at least one of its sockets is open and answering the server's heartbeat. The
 * heartbeat is socket.io's own ping: the server pings every `HEARTBEAT_INTERVAL_MS` and
 * closes a socket that has not answered within `HEARTBEAT_TIMEOUT_MS`, so a device that
 * went silent (asleep, suspended, off the network) leaves the list within the sum of the
 * two. Clients answer it from the socket's message handler, not from a timer, so a hidden
 * browser tab keeps answering; a page the browser freezes, or an app the OS suspends,
 * does not, and is not listed. A socket that closes cleanly (a tab closed, an app sent to
 * the background with nothing playing) leaves the list at once. Older clients answer the
 * same ping: socket.io takes its timings from the server's handshake.
 *
 * The shared session's `activeDeviceId` can name a device the list leaves out: it went
 * away, and the server gives it `DEVICE_GRACE_MS` to come back with the session's clock
 * stopped (`stalled`). Clients show that as reconnecting to it, never as a device to pick.
 * When it does not return, the server applies `deviceLost`; when it does, it is listed again.
 */

/** How often the server pings each socket. */
export const HEARTBEAT_INTERVAL_MS = 5_000
/** How long the server waits for the answer to a ping before closing the socket: two pings' worth. */
export const HEARTBEAT_TIMEOUT_MS = 10_000
/** How long the session waits for an active device that went away before `deviceLost`. */
export const DEVICE_GRACE_MS = 20_000

/**
 * One of the user's live devices (see "Presence"). Every client of the user gets the same
 * list, whichever session it is in.
 */
export const DeviceInfo = z.object({
  id: z.string(),
  name: z.string(),
  kind: ClientDevice.shape.kind,
  /**
   * The shared session can be transferred to it. False for a device that only controls,
   * and for a detached one, so a client that does not know `detached` never offers it.
   */
  canPlay: z.boolean(),
  /** It is the active device of the shared session. */
  isActive: z.boolean(),
  /**
   * It is the device the list was sent to: over the socket, the one the receiving socket
   * said hello as; from `GET /me/devices`, the one the request's sign-in was made from.
   * Absent from older servers.
   */
  isCurrent: z.boolean().optional(),
  /**
   * When the device last said anything over its socket (its hello, a command, a report, an
   * answer to the heartbeat), epoch milliseconds. Sent again as it moves on, at most once a
   * minute per device. A listed device is live, so this is never much more than a minute
   * old; older servers counted only what the device sent of its own, and clients still say
   * how long such a device was quiet. Absent from older servers.
   */
  lastSeenAt: z.number().int().optional(),
  /**
   * Present while the device is detached: whether its own session is playing, and what.
   * The list is sent again when either changes.
   */
  detached: z.object({ playing: z.boolean(), trackId: Id.nullable(), albumId: Id.nullable() }).optional(),
})
export type DeviceInfo = z.infer<typeof DeviceInfo>

/**
 * Detaching.
 *
 * A device that can play may leave the shared session with `session:detach` and get a
 * session of its own, held and run by the server exactly like the shared one (the same
 * reducer, on-demand fetching, autoplay, plays). Only that device is in it: its updates
 * go to that device alone, the user's other devices list it with `DeviceInfo.detached`,
 * and nothing can be transferred to or from it.
 *
 * - **Detach.** The own session starts as a copy of the shared one, entry ids included,
 *   and continues the shared session's version numbers. If the device was the shared
 *   session's active device, the copy is exact and it goes on playing without a gap, and
 *   the shared session is left as after `deviceLost`: paused, no active device. Otherwise
 *   the copy is paused where the shared session was and has no active device. Refused
 *   for a device that cannot play (`cannot_play`), and when the user already has eight
 *   detached devices that are all connected (`too_many_detached`); otherwise the own
 *   session of the one gone longest makes room.
 * - **Attach.** `session:attach` puts the device back in the shared session as a remote
 *   and discards its own session; whatever it played there stops. With `bringQueue`
 *   the shared session becomes what the device's own session was (current entry, position,
 *   queue, history, shuffle, repeat, autoplay and context; entry ids kept) and the device
 *   becomes its active device, as if it had sent `playTracks` and `transfer` to itself,
 *   so it continues without a gap and whatever another device was playing stops. Refused
 *   with `nothing_to_bring` when the own session has no current entry and no queue.
 * - **Both are idempotent**, answer with everything a hello does, and replace what the
 *   client held: adopt the snapshot (its `scope` says which session it is) and drop own
 *   commands already acknowledged. Commands sent after the request apply to the new
 *   session. Other sockets of the same device receive `session:moved` instead of the ack.
 * - **Returning.** The server remembers a detached device. A hello carrying `detached`
 *   (either value) from a device with no other socket connected is answered with its own
 *   session when one is stored: the server's record wins over what the client believed.
 *   A hello without the field is from a client that cannot detach: a stored own session
 *   is discarded and the device is in the shared session. A further socket of a
 *   connected device joins the session the device is in.
 * - **Forgetting.** An own session is kept while its device is connected and for seven
 *   days after it was last seen, then discarded. A device that says `detached: true`
 *   and has none is answered with the shared session and `detachedEnded`.
 *
 * A client that held a different scope than a hello's answer drops its unsent commands:
 * they were made for another session.
 */
export const SessionHello = z.object({
  device: ClientDevice,
  canPlay: z.boolean(),
  /**
   * Sent by every client that can detach: whether this device was in its own session when
   * the client last heard from the server. Older clients leave it out.
   */
  detached: z.boolean().optional(),
  /**
   * Messages beyond the base protocol this socket understands. `queueOps`: queue changes as
   * `session:queueOps` (see "Queue diffs"). Servers that do not know a name ignore it; older
   * clients leave the field out and get the base protocol.
   */
  accepts: z.array(z.string()).optional(),
})
export type SessionHello = z.infer<typeof SessionHello>

/**
 * What a server can do beyond the base protocol. `detach`: `session:detach`, `session:attach`
 * and all they imply. `signal`: `session:signal` (see "Signal path"). `sleepTimer`:
 * `setSleepTimer` and `SessionState.sleepTimer`. `queueOps`: `session:queueOps` to sockets
 * that accept it, and `session:sync` (see "Queue diffs"). `undo`: the `undo` command
 * (see "Undo"). `jam`: `session:jam`, `SessionState.jam` and the rest of "Listen together".
 */
export const SessionCapability = z.enum(['detach', 'signal', 'sleepTimer', 'queueOps', 'undo', 'jam'])
export type SessionCapability = z.infer<typeof SessionCapability>

export const SessionHelloAck = z.object({
  serverTime: z.number(),
  snapshot: SessionSnapshot,
  devices: z.array(DeviceInfo),
  /**
   * `SessionCapability` names this server supports, and names a newer one may add. Absent
   * from servers older than the first capability; a client offers a feature only when its
   * name is listed.
   */
  capabilities: z.array(z.string()).optional(),
  /**
   * Set when the hello said `detached: true` and the device is in the shared session all
   * the same. `expired`: its own session was found and was past the seven days.
   * `missing`: the server holds none (cleaned up earlier, or ended from elsewhere).
   */
  detachedEnded: z.enum(['expired', 'missing']).optional(),
  /** The session's latest signal path while its entry is current and its device active. Absent otherwise, and from older servers. */
  signal: SignalPath.optional(),
})
export type SessionHelloAck = z.infer<typeof SessionHelloAck>

/** `session:detach` takes no options yet. */
export const SessionDetach = z.object({})
export type SessionDetach = z.infer<typeof SessionDetach>

export const SessionAttach = z.object({
  /** Make the shared session what this device's own session was, with this device active. */
  bringQueue: z.boolean().optional(),
})
export type SessionAttach = z.infer<typeof SessionAttach>

/**
 * Answer to `session:detach` and `session:attach`: on success, the session the device is
 * in now. Errors: `hello_required`, `cannot_play`, `too_many_detached`,
 * `nothing_to_bring`, `invalid_request`, `rate_limited`, `internal_error`.
 */
export const SessionMoveAck = z.union([
  SessionHelloAck.extend({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type SessionMoveAck = z.infer<typeof SessionMoveAck>

/**
 * `session:jam`, on servers with the `jam` capability. `start`: host a jam (idempotent for
 * a host). `join`: join one by id. `leave`: a member leaves. `end`: the host ends it.
 * `settings`: the host changes who may add to the queue. `remove`: the host removes a
 * member. `invite`: the host asks other users of the server to join; each of them gets a
 * `jam.invite` event.
 */
export const JamRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), queuePolicy: JamQueuePolicy.optional() }),
  z.object({ action: z.literal('join'), jamId: z.string().min(1).max(64) }),
  z.object({ action: z.literal('leave') }),
  z.object({ action: z.literal('end') }),
  z.object({ action: z.literal('settings'), queuePolicy: JamQueuePolicy }),
  z.object({ action: z.literal('remove'), userId: Id }),
  z.object({ action: z.literal('invite'), userIds: z.array(Id).min(1).max(JAM_MEMBER_LIMIT) }),
])
export type JamRequest = z.infer<typeof JamRequest>

/**
 * Answer to `session:jam`. On success, the jam as it is now (absent after `leave` and
 * `end`); the session's own update follows as `session:state`. Errors: `hello_required`,
 * `invalid_request`, `rate_limited`, `jam_not_found`, `jam_full`, `jam_hosting`,
 * `jam_detached`, `not_in_jam`, `jam_host_only`, `internal_error`.
 */
export const JamAck = z.union([
  z.object({ ok: z.literal(true), jam: JamInfo.nullable() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type JamAck = z.infer<typeof JamAck>

/** `GET /jams/:id`: what an invite link shows before joining. */
export const JamPreview = z.object({
  id: z.string(),
  hostName: z.string(),
  members: z.array(JamMember.pick({ userId: true, name: true })),
  /** The track the jam is on, if any. */
  trackId: Id.nullable(),
})
export type JamPreview = z.infer<typeof JamPreview>

/** `GET /jams/people`: the other active users of the server, whom a host may invite. */
export const JamPerson = z.object({ userId: Id, name: z.string() })
export type JamPerson = z.infer<typeof JamPerson>

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
  /**
   * Sent to the sockets in a session, just before the state, when playback stopped on a
   * failed current entry instead of skipping on, so clients show one notice rather than one
   * per track. A detached device's own session tells that device alone. `trackId` is the
   * current entry's track when playback stopped. `kind` (left out by older servers; read it
   * as `outage` with a `reason`, else `failures`):
   * - `outage`: the provider is failing or unreachable; `reason` is a sentence to show.
   * - `failures`: several tracks in a row failed for no reason the server knows.
   * - `exhausted`: the track was not available and nothing after it in the queue is.
   * - `unavailable`: several tracks in a row were not available with nothing delivered in
   *   between, so the server stopped skipping: the provider may be wrong about them.
   */
  /**
   * Sent to the sockets in a session that holds the track, just before the state that marks
   * its entries failed: why it could not be fetched. Clients word the notice for a skipped
   * song with it. Older servers do not send it.
   */
  z.object({ type: z.literal('playback.failed'), trackId: Id, failure: EntryFailure }),
  z.object({
    type: z.literal('playback.unavailable'),
    trackId: Id.nullable(),
    reason: z.string().nullable().optional(),
    kind: z.enum(['outage', 'failures', 'exhausted', 'unavailable']).optional(),
  }),
  /** To every socket of an invited user: `hostName` asks them to join jam `jamId`. */
  z.object({ type: z.literal('jam.invite'), jamId: z.string(), hostName: z.string() }),
  /**
   * To the sockets of a member's shared session, just before the state that drops `jam`:
   * `ended` when the host ended it, `removed` when the host removed this member.
   */
  z.object({ type: z.literal('jam.left'), jamId: z.string(), reason: z.enum(['ended', 'removed']) }),
])
export type ServerEvent = z.infer<typeof ServerEvent>

/** socket.io event maps. Use these to type both ends. */
export interface ClientToServerEvents {
  'session:hello': (hello: SessionHello, ack: (reply: SessionHelloAck) => void) => void
  'time:sync': (clientTime: number, ack: (reply: { clientTime: number; serverTime: number }) => void) => void
  'session:command': (envelope: CommandEnvelope, ack: (reply: CommandAck) => void) => void
  'session:report': (report: EngineReport) => void
  /** Only on servers with the `signal` capability, and only from the active device. See "Signal path". */
  'session:signal': (report: SignalReport) => void
  /** Only on servers with the `detach` capability. See "Detaching". */
  'session:detach': (request: SessionDetach, ack: (reply: SessionMoveAck) => void) => void
  'session:attach': (request: SessionAttach, ack: (reply: SessionMoveAck) => void) => void
  /** Only on servers with the `queueOps` capability: the session now, with the whole queue. See "Queue diffs". */
  'session:sync': (request: Record<string, never>, ack: (reply: SessionSyncAck) => void) => void
  /** Only on servers with the `jam` capability. See "Listen together". */
  'session:jam': (request: JamRequest, ack: (reply: JamAck) => void) => void
}

/**
 * Every session change emits `session:state`. When the queue half also changed,
 * `session:queue` (or, to a socket that accepts it, `session:queueOps`) with the same
 * `version` is emitted first; clients hold it until the matching `session:state` arrives.
 * All go only to the sockets in that session: a detached device's to that device, the
 * shared session's to everyone else.
 */
export interface ServerToClientEvents {
  'session:state': (update: { version: number; state: SessionState }) => void
  'session:queue': (update: { version: number; queueVersion: number; queue: SessionQueue }) => void
  /** Instead of most `session:queue`s, to sockets whose hello accepts `queueOps`. See "Queue diffs". */
  'session:queueOps': (update: SessionQueueOps) => void
  /**
   * This socket's device changed session without this socket asking: another socket of
   * the device detached or attached it. Handle it like the answer to a hello.
   */
  'session:moved': (update: SessionHelloAck) => void
  /** The session's active device said what it plays (see "Signal path"). To the sockets in that session. */
  'session:signal': (signal: SignalPath) => void
  devices: (devices: DeviceInfo[]) => void
  /**
   * TanStack Query keys to invalidate: lists whose members or order changed. Changes to
   * entities they show come as `changes` instead. See `queryKeys`.
   */
  invalidate: (update: { keys: readonly (readonly unknown[])[] }) => void
  /** What changed about entities, for patching cached answers in place. See `EntityChange`. */
  changes: (update: EntityChanges) => void
  event: (event: ServerEvent) => void
}

/**
 * Query keys shared by the clients and by server-side invalidations. Keys are prefix
 * matched, so invalidating `queryKeys.playlists()` also refreshes each playlist.
 */
export const queryKeys = {
  me: () => ['me'] as const,
  /** `GET /setup/status`. Clients may add the server's URL after it. */
  setupStatus: () => ['setup-status'] as const,
  home: () => ['home'] as const,
  /** A mix made for the user (`GET /mixes/:id`). Under `home()`: mixes are made again with Home's rails. */
  mix: (id: string) => ['home', 'mix', id] as const,
  libraryAlbums: () => ['library', 'albums'] as const,
  libraryArtists: () => ['library', 'artists'] as const,
  libraryTracks: () => ['library', 'tracks'] as const,
  /** The Library's All (`GET /library/items`), which also moves when a collection is played or a playlist changes. */
  libraryItems: () => ['library', 'items'] as const,
  library: () => ['library'] as const,
  /**
   * The server's music (`GET /collection/albums`, `/collection/artists`, `/collection/tracks`).
   * Under `library()`, so whatever changes the collection, which every library may include,
   * reaches these lists too.
   */
  collectionAlbums: () => ['library', 'collection', 'albums'] as const,
  collectionArtists: () => ['library', 'collection', 'artists'] as const,
  collectionTracks: () => ['library', 'collection', 'tracks'] as const,
  collection: () => ['library', 'collection'] as const,
  /** The user's uploads (`GET /me/uploads` and an album's songs under it). */
  uploads: () => ['uploads'] as const,
  album: (id: string) => ['album', id] as const,
  artist: (id: string) => ['artist', id] as const,
  /** One section of an artist page, paged (`GET /artists/:id/releases`). Under `artist(id)`, so its invalidation covers it. */
  artistReleases: (id: string, section: string) => ['artist', id, 'releases', section] as const,
  track: (id: string) => ['track', id] as const,
  lyrics: (id: string) => ['lyrics', id] as const,
  likes: () => ['likes'] as const,
  playlists: () => ['playlists'] as const,
  playlist: (id: string) => ['playlists', id] as const,
  history: () => ['history'] as const,
  replay: () => ['history', 'replay'] as const,
  wants: () => ['wants'] as const,
  search: () => ['search'] as const,
  settings: () => ['settings'] as const,
  scrobbling: () => ['scrobbling'] as const,
  /** An invite link's preview (`GET /jams/:id`). */
  jam: (id: string) => ['jams', id] as const,
  /** Whom a host may invite (`GET /jams/people`). */
  jamPeople: () => ['jams', 'people'] as const,
  admin: () => ['admin'] as const,
  adminRoots: () => ['admin', 'roots'] as const,
  adminJobs: () => ['admin', 'jobs'] as const,
  adminReviews: () => ['admin', 'reviews'] as const,
  adminUsers: () => ['admin', 'users'] as const,
  adminOrganize: () => ['admin', 'organize'] as const,
  /** Everyone's uploads (`GET /admin/uploads`). */
  adminUploads: () => ['admin', 'uploads'] as const,
  /** The user's share links (`GET /me/shares`). */
  shares: () => ['shares'] as const,
  /** Everyone's share links (`GET /admin/shares`). */
  adminShares: () => ['admin', 'shares'] as const,
} as const
