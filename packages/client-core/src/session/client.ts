import {
  type ClientDevice,
  type CommandAck,
  type DeviceInfo,
  type EntryFailure,
  type EngineReport,
  JAM_DRIFT_MS,
  type JamAck,
  type JamRequest,
  type NormalizationMode,
  type PlaybackDescriptor,
  type QueueEntry,
  SessionCommand,
  type SessionHelloAck,
  type SessionMoveAck,
  type SessionQueue,
  type ServerEvent,
  SessionQueueOps,
  type SessionScope,
  type SessionSnapshot,
  type SessionState,
  type SessionSyncAck,
  type SignalPath,
} from '@squirmy/contracts'
import { ApiError, streamUrl } from '../api/client.js'
import type { EngineEvent, EngineMedia, EngineState, EngineStatus, PlayerEngine } from '../engine.js'
import { appliedGain, REFERENCE_LUFS, type GainContext } from '../normalization.js'
import { signalReport } from '../signal.js'
import { clearRepeating, setRepeating, setTimer } from '../timers.js'
import { followsJam, memberCommandRoute } from './jam.js'
import { applyQueueOps } from './queue-ops.js'
import { createInitialSession, joinSession, positionAt, reduceParsedSession, type Session, splitSession } from './reducer.js'
import { sleepFade } from './sleep.js'
import type { SessionTransport } from './transport.js'

/** Track failures remembered for `failureOf`: far more than are ever near the current entry. */
const FAILURES_KEPT = 200

/**
 * - `offline`: no connection. Commands still apply locally and wait to be sent.
 * - `connecting`: connected, waiting for the `session:hello` ack.
 * - `online`: in sync with the server.
 */
export type ConnectionStatus = 'offline' | 'connecting' | 'online'

/** What `getSnapshot()` returns. Each field keeps its identity until its content changes. */
export type SessionClientSnapshot = {
  /** The session's small half, with this client's unacknowledged commands applied. */
  session: SessionState
  queue: SessionQueue
  devices: readonly DeviceInfo[]
  connection: ConnectionStatus
  /** This device outputs the audio. */
  isActiveDevice: boolean
  /**
   * This device is detached: `session` and `queue` are its own session, which no other
   * device sees or controls, and not the user's shared one.
   */
  detached: boolean
  /** Detaching is possible: this device can play and the server said it supports it. False until a hello has. */
  canDetach: boolean
  /**
   * The server takes `undo` (see "Undo" in the session contract) for this session. False until
   * a hello has said so, and while following someone's jam, where only the host undoes.
   */
  canUndo: boolean
  /** The server takes `setSleepTimer` (the `sleepTimer` capability). False until a hello has said so. */
  canSetSleepTimer: boolean
  /** The server takes `session:jam` (the `jam` capability): listening together. False until a hello has said so. */
  canJam: boolean
  /**
   * Why the session paused on its failed current entry, when the server said so with
   * `playback.unavailable`. Set in the same snapshot as the pause (the server sends the
   * event first), and null again once the session plays or moves on.
   */
  outage: SessionOutage | null
  /**
   * The shared session's active device while it is away: the session names it, the server's
   * list of live devices does not, and the server is waiting for it to come back (see
   * "Presence" in the session contract). Null while this client is not online, and when the
   * active device is listed or is this one.
   */
  away: AwayDevice | null
  /**
   * What the active device plays, as it plays it (see "Signal path" in the session contract):
   * this device's own while it plays here, once the current entry is loaded; otherwise the
   * active device's last report, while it is about the current entry. Null when there is
   * none: nothing loaded yet, or a device or server that does not report.
   */
  signal: SignalPath | null
}

/**
 * An active device that went away. `device` is how it was last listed, so it can be named;
 * null when this client never saw it listed (it opened while the device was away).
 */
export type AwayDevice = { id: string; device: DeviceInfo | null }

/** How many devices `SessionClient` remembers after they leave the list, to name one that is away. */
const REMEMBERED_DEVICES = 32

/**
 * What a `playback.unavailable` said: the track playback stopped on, why (`kind`, see the
 * event), and the server's sentence for it, if it has one.
 */
export type SessionOutage = { trackId: string | null; kind: 'outage' | 'failures' | 'exhausted' | 'unavailable'; reason: string | null }

/**
 * How `detach` and `attach` end. Errors from this client: `offline` (they need the
 * server), `unsupported` (see `canDetach`), `busy` (another one is under way), `timeout`,
 * `disconnected` (the connection dropped and the next hello showed it had not happened),
 * `disposed`. Others are the server's; see `SessionMoveAck`.
 */
export type SessionMoveResult = { ok: true } | { ok: false; error: string }

/**
 * How `jam` ends: the server's answer (see `JamAck`), or this client's `offline`,
 * `unsupported` (see `canJam`) or `timeout`.
 */
export type JamResult = JamAck

/** Audio output of a device that can play. */
export type SessionPlayer = {
  engine: PlayerEngine
  /** Fetches `GET /tracks/:id/playback` for an entry (with the entry's album and the device's quality and codecs). */
  resolvePlayback: (entry: QueueEntry) => Promise<PlaybackDescriptor>
  /** Server root the descriptor's `url` is relative to; see `streamUrl`. */
  baseUrl: string
  /** Initial normalization mode (the user's setting). Defaults to `auto`. */
  normalization?: NormalizationMode
  /** Initial normalization target in LUFS (the user's setting). Defaults to -18. */
  normalizationTarget?: number
  /** The engine can amplify above unity. Defaults to false. */
  canBoost?: boolean
  /**
   * The engine limits true peaks after the gain, so normalization is not held back to a
   * song's peak (see `GainContext.limiter`). Defaults to false.
   */
  limiter?: boolean
  /**
   * This device's entry in the session's `volumes` is the system's output volume, which the
   * platform applies and keeps in step itself (iOS): the engine's gain leaves it out and
   * plays at full volume, with only normalization applied. Defaults to false.
   */
  systemVolume?: boolean
  /**
   * `resolvePlayback` failed for the current entry. `willRetry` is true for a failure that
   * may pass (no connection, a server error), which is retried every few seconds while the
   * session reports a stall; false when the server refused the track (a 4xx), which the
   * client gives up on until play or a seek: the caller should move on, as for an engine
   * `error`.
   */
  onLoadError?: (entry: QueueEntry, error: unknown, willRetry: boolean) => void
}

/**
 * What `save()` returns and `restore` takes: the last server state this client saw and
 * its own commands that state does not include yet, so a relaunch shows the same session
 * and still sends what was done offline.
 */
export type SavedSession = {
  version: number
  state: SessionState
  queue: SessionQueue
  pending: { commandId: string; command: SessionCommand; at: number; ackVersion: number | null }[]
  /** Estimated server time of the save. */
  savedAt: number
  /** The saved session is this device's own: it was detached. Absent in saves made before detaching existed. */
  detached?: boolean
}

export type SessionClientOptions = {
  transport: SessionTransport
  device: ClientDevice
  /** Omit on a device that only controls other devices. */
  player?: SessionPlayer
  /**
   * A session saved by an earlier run, shown until the server answers. If this device was
   * playing it, it comes back paused at the saved position: the audio stopped with the app.
   */
  restore?: SavedSession
  /**
   * Called when this device was detached and a hello finds it back in the shared session
   * without having asked: the server no longer holds its own session (`expired`: it was
   * away past the server's keep time; `missing`: cleaned up earlier or ended elsewhere).
   */
  onDetachedEnded?: (reason: 'expired' | 'missing') => void
  /** A jam event for this user: an invite to one, or this member's jam ending (see `ServerEvent`). */
  onJamEvent?: (event: Extract<ServerEvent, { type: 'jam.invite' | 'jam.left' }>) => void
  /** Local clock. Defaults to `Date.now`. */
  now?: () => number
  /** After the session's position moves, the engine is re-seeked only when it is further off than this. Defaults to 1000. */
  driftThresholdMs?: number
  /** Engine reports are sent on status changes and at this interval. Defaults to 10000. */
  reportIntervalMs?: number
  /** How often a device playing a jam it follows checks its drift from the jam's clock. Defaults to 2000. */
  jamAlignIntervalMs?: number
}

/** Dropped from the unsent commands when the server says another device took over. */
const PLAYBACK_COMMANDS = new Set<SessionCommand['type']>([
  'play', 'pause', 'next', 'previous', 'seek', 'playTracks', 'playQueueEntry', 'transfer', 'trackEnded',
])
const REQUEST_TIMEOUT_MS = 10_000
/** How often the gain follows a sleep timer's fade while one is set and this device plays. */
const FADE_TICK_MS = 200
/**
 * Past a sleep timer's end, how long a device that plays offline waits for the server's pause
 * before it pauses itself: the server cannot reach it, and it would go on playing silence.
 */
const SLEEP_OFFLINE_GRACE_MS = 2000
const CLOCK_SAMPLES = 5
const RETRY_MS = 3000
/** Signed URLs are refreshed this long before they expire. */
const DESCRIPTOR_MARGIN_MS = 5 * 60_000
const DESCRIPTOR_CACHE_SIZE = 50
/** Tracks `forgetPlayback` remembers forgetting, for resolves still in flight. */
const FORGOTTEN_TRACKS_SIZE = 64
const REPORTED: Partial<Record<EngineState, EngineReport['status']>> = {
  playing: 'playing',
  paused: 'paused',
  loading: 'buffering',
  buffering: 'buffering',
  error: 'error',
}

type Pending = {
  commandId: string
  command: SessionCommand
  /** Estimated server time of the dispatch; the command is replayed at this time. */
  at: number
  /** Session version that includes the command, once acked. */
  ackVersion: number | null
  /** Connection epoch it was last sent on. */
  sentEpoch: number | null
}

/** A `detach` or `attach` the server has not answered yet. */
type Move = {
  /** Whether the device is detached once it succeeds. */
  detached: boolean
  /** Commands made before the request: they were for the session being left. */
  before: Set<Pending>
  /** The server did not answer in time; a fresh hello is finding out whether it happened. */
  timedOut: boolean
  resolve: (result: SessionMoveResult) => void
}

/**
 * One client's view of the user's playback session: keeps it in sync with the server,
 * applies commands optimistically, and drives the audio engine while this device is the
 * active one.
 *
 * **Sync.** The client keeps the last server state and the list of its own commands the
 * server has not yet included. What it shows is the server state with those commands
 * replayed on top (at their original dispatch times), recomputed on every server update.
 * A command leaves the list once its ack has arrived and a server state at or past the
 * acked version has too, so its effect never flickers out. A rejected or timed-out ack
 * drops it.
 *
 * **Offline and reconnect.** Unsent and unacknowledged commands survive disconnects and
 * are re-sent in order after the next `session:hello` (the server ignores duplicates by
 * command id). If the hello reply shows another device active, pending playback commands
 * are dropped and the local engine stops; queue edits and settings are still sent. If no
 * device is active and this one was playing when it lost the connection, it reclaims the
 * session at the engine's position. It does the same when it ended tracks by itself while
 * offline, placing the transfer before the first of them so the server accepts them. When
 * it is still the active device, commands made offline are followed by the engine's
 * position, so the music does not jump back to where they were replayed.
 *
 * **Detaching.** `detach()` moves this device into a session of its own and `attach()`
 * back into the shared one (see "Detaching" in the session contract). Both need the
 * server and resolve once it has answered; nothing is applied optimistically, and the
 * audio is not touched unless the session the device lands in says so. The answer
 * replaces the server state held here; commands made before the request are forgotten
 * (the server had them when it copied or discarded the session) and commands made after
 * it go to the new session. The server remembers which session a device is in, so every
 * hello may answer with either: when it is not the one this client held, the commands
 * waiting to be sent are dropped, because they were made for the other session. While
 * detached, everything above applies to the device's own session unchanged.
 *
 * **Queue diffs.** The hello accepts `queueOps`, so a server that can sends most queue
 * changes as operations on the queue held here (see "Queue diffs" in the session contract).
 * The client tracks the `queueVersion` it holds; operations for another version or session,
 * or that do not apply, make it ask for the whole session with `session:sync`. Until the
 * answer it applies states with the queue it has, and drops further operations.
 *
 * **Engine.** While active, the client loads the current entry, preloads the one that
 * would follow it, follows play/pause/seek, applies `volumes[device] × normalization`,
 * and on the engine's `ended` advances locally with `trackEnded` without waiting for the
 * server. Position changes from elsewhere re-seek the engine only past the drift
 * threshold. While not active, the engine is stopped.
 */
export class SessionClient {
  private readonly transport: SessionTransport
  private device: ClientDevice
  private readonly player: SessionPlayer | undefined
  private readonly now: () => number
  private readonly driftThresholdMs: number
  private readonly reportIntervalMs: number
  private readonly jamAlignIntervalMs: number
  private readonly onDetachedEnded: SessionClientOptions['onDetachedEnded']
  private readonly onJamEvent: SessionClientOptions['onJamEvent']

  private server: { version: number; session: Session } | null = null
  /** The server state held is this device's own session. */
  private detached = false
  private serverDetaches = false
  private serverUndoes = false
  /** The server takes and passes on `session:signal`. */
  private serverSignals = false
  /** The last signal path the server passed on, from whichever device sent it. */
  private remoteSignal: SignalPath | null = null
  /** What this device last reported since the last hello, so a report goes out only when it changes. */
  private sentSignal: string | null = null
  private serverSleeps = false
  private serverJams = false
  /** Moves the gain along a sleep timer's fade; see `followFade`. */
  private fadeTimer: unknown = null
  private move: Move | null = null
  private heldQueue: { version: number; queue: SessionQueue } | null = null
  /** The `queueVersion` of the newest queue held (`heldQueue`'s, else the server state's). Null before the first hello. */
  private queueVersion: number | null = null
  /** Queue operations did not apply: the whole session has been asked for (`session:sync`). */
  private outOfSync = false
  /** A `session:sync` is waiting for its answer. */
  private syncing = false
  private pending: Pending[] = []
  /**
   * The pause and seek `restore` adds for a session this device was playing, and the
   * version of the saved state they were made against. Dropped at the first hello when the
   * server has moved on since: it then knows better where the music stopped.
   */
  private restored: { commands: Set<Pending>; version: number; savedAt: number } | null = null
  private local: Session = createInitialSession()
  private devices: DeviceInfo[] = []
  /** Every device listed lately, the latest last, as last listed: an away device is named from here. */
  private readonly seen = new Map<string, DeviceInfo>()
  private connection: ConnectionStatus = 'offline'
  /** Why tracks failed, from `playback.failed`, oldest first. */
  private readonly failures = new Map<string, EntryFailure>()
  /** The last `playback.unavailable`, and whether the pause it explains has been shown. */
  private told: { outage: SessionOutage; shown: boolean } | null = null
  private snapshot: SessionClientSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly cleanup: (() => void)[] = []
  /** Bumped on every connect and disconnect; stale async work checks it. */
  private attempt = 0
  /** Bumped on every completed hello. */
  private epoch = 0
  private offset = 0
  private bestRtt = Infinity
  private serial = 0

  private normalization: NormalizationMode
  private normalizationTarget: number
  private loadToken = 0
  private loadingEntryId: string | null = null
  /** The entry whose stream could not be had yet (offline), and where its first try would have started. */
  private unloaded: { entryId: string; anchorAt: number; anchorMs: number; startMs: number } | null = null
  /** The entry whose descriptor the server refused; not loaded again until play or a seek. */
  private refusedEntryId: string | null = null
  private preloadTarget: string | null = null
  /** The entry `prepareTakeover` buffered while another device played. */
  private takeover: string | null = null
  private preloadTrackId: string | null = null
  /** Bumped each time the preload is aimed; a resolve begun for an earlier aim is dropped. */
  private preloadToken = 0
  /** Bumped by `forgetPlayback`; a resolve begun before a forget of its track serves its load but is not kept. */
  private forgotten = 0
  /** The value of `forgotten` when everything was last forgotten. */
  private allForgottenAt = 0
  /** The value of `forgotten` when each track was last forgotten, the most recent last. */
  private readonly forgottenAt = new Map<string, number>()
  private engineState: EngineState = 'idle'
  private gain: number | null = null
  private lastReport: string | null = null
  /** Command id the next `trackEnded` of this entry will use, fixed in advance so the preload predicts its entry ids. */
  private endCommand: { entryId: string; commandId: string } | null = null
  private readonly descriptors = new Map<string, PlaybackDescriptor>()
  /**
   * What the engine's loaded and preloaded entries were resolved to, by entry id. Their gain
   * comes from here, so it holds while they play, whatever is forgotten meanwhile.
   */
  private readonly inEngine = new Map<string, PlaybackDescriptor>()

  constructor(options: SessionClientOptions) {
    this.transport = options.transport
    this.device = options.device
    this.player = options.player
    this.now = options.now ?? (() => Date.now())
    this.driftThresholdMs = options.driftThresholdMs ?? 1000
    this.reportIntervalMs = options.reportIntervalMs ?? 10_000
    this.jamAlignIntervalMs = options.jamAlignIntervalMs ?? 2000
    this.normalization = options.player?.normalization ?? 'auto'
    this.normalizationTarget = options.player?.normalizationTarget ?? REFERENCE_LUFS
    this.onDetachedEnded = options.onDetachedEnded
    this.onJamEvent = options.onJamEvent
    if (options.restore) this.restore(options.restore)
    const { state, queue } = splitSession(this.local)
    this.snapshot = {
      session: state, queue, devices: this.devices, connection: this.connection, isActiveDevice: this.isActive(),
      detached: this.detached, canDetach: this.canDetach(), canSetSleepTimer: false, canUndo: false, canJam: false, outage: null, away: null, signal: null,
    }
  }

  /**
   * Why the server could not fetch a track, as it said (`playback.failed`) just before the
   * state that marked it failed. Undefined when it did not say (an older server): word that
   * as an `error`.
   */
  failureOf(trackId: string): EntryFailure | undefined {
    return this.failures.get(trackId)
  }

  /** Subscribes to the transport and the engine, and says hello if already connected. Call once. */
  start(): void {
    const { transport, player } = this
    this.cleanup.push(
      transport.onConnectionChange(connected => (connected ? this.connect() : this.disconnected())),
      transport.on('session:state', update => this.onState(update)),
      transport.on('session:queue', update => this.onQueue(update)),
      transport.on('session:queueOps', update => this.onQueueOps(update)),
      transport.on('session:moved', update => {
        // Before the hello is answered there is nothing to replace; its answer says the same.
        if (this.connection === 'online') this.onMoved(update)
      }),
      transport.on('session:signal', signal => {
        this.remoteSignal = signal
        this.publish()
      }),
      transport.on('devices', devices => {
        this.setDevices(devices)
        this.publish()
      }),
      transport.on('event', event => {
        if (event.type === 'jam.invite' || event.type === 'jam.left') return this.onJamEvent?.(event)
        if (event.type === 'playback.failed') {
          this.failures.delete(event.trackId)
          this.failures.set(event.trackId, event.failure)
          for (const trackId of this.failures.keys()) {
            if (this.failures.size <= FAILURES_KEPT) break
            this.failures.delete(trackId)
          }
          return
        }
        if (event.type !== 'playback.unavailable') return
        const reason = event.reason ?? null
        // Older servers send no kind: a reason meant the provider was failing.
        const kind = event.kind ?? (reason ? 'outage' : 'failures')
        this.told = { outage: { trackId: event.trackId, kind, reason }, shown: false }
        this.publish()
      }),
    )
    if (player) {
      this.cleanup.push(player.engine.subscribe(event => this.onEngineEvent(event)))
      const timer = setRepeating(() => this.report(player.engine.getStatus(), true), this.reportIntervalMs)
      this.cleanup.push(() => clearRepeating(timer))
      const align = setRepeating(() => this.alignToJam(), this.jamAlignIntervalMs)
      this.cleanup.push(() => clearRepeating(align))
      // A restored session this device was playing loads paused, ready to resume offline.
      this.syncEngine(this.local, false)
    }
    if (transport.isConnected()) this.connect()
  }

  /** Unsubscribes everything and stops the engine. */
  dispose(): void {
    for (const undo of this.cleanup.splice(0)) undo()
    this.attempt += 1
    this.settleMove({ ok: false, error: 'disposed' })
    this.stopEngine()
    this.followFade(false)
  }

  /**
   * Applies a command locally at once and sends it (now, or after reconnecting). Returns
   * the command's id, which `undo` names it by; null when it was not sent.
   * Throws a ZodError when the command does not match `SessionCommand`.
   */
  dispatch(command: SessionCommand): string | null {
    const parsed = SessionCommand.parse(command)
    // The server refuses these. Applying one until it does would stop this device's audio
    // for the round trip, so it is not tried at all.
    if (parsed.type === 'transfer' && this.outOfSession(parsed.deviceId)) return null
    // The same for what only a jam's host may do, while this user follows someone's jam.
    if (followsJam(this.local) && !this.memberMay(parsed)) return null
    const commandId = this.newCommandId()
    this.enqueue(parsed, commandId)
    this.recompute(parsed.type === 'seek')
    this.flush()
    return commandId
  }

  /**
   * Moves this device out of the shared session into a session of its own, which starts
   * as a copy of the shared one. If this device was playing, it keeps playing there and
   * the shared session pauses; otherwise the copy is paused. Resolves once the server has
   * answered; resolves `ok` at once when already detached.
   */
  detach(): Promise<SessionMoveResult> {
    return this.requestMove('session:detach', {}, true)
  }

  /**
   * Moves this device back into the shared session as a remote; its own session stops and
   * is discarded. With `bringQueue` the shared session becomes what this device's own was
   * and this device its active device, so it carries on playing and the user's other
   * devices follow it (refused with `nothing_to_bring` when there is nothing in it).
   * Resolves `ok` at once when not detached.
   */
  attach(options: { bringQueue?: boolean } = {}): Promise<SessionMoveResult> {
    return this.requestMove('session:attach', options.bringQueue ? { bringQueue: true } : {}, false)
  }

  /**
   * Starts, joins, leaves, ends or changes a jam (see "Listen together" in the session
   * contract). Nothing is applied optimistically: the session's update follows the answer.
   */
  jam(request: JamRequest): Promise<JamResult> {
    if (this.connection !== 'online') return Promise.resolve({ ok: false, error: 'offline' })
    if (!this.serverJams) return Promise.resolve({ ok: false, error: 'unsupported' })
    return new Promise(resolve => {
      this.transport.request('session:jam', request, REQUEST_TIMEOUT_MS, (_error, reply) => resolve(reply ?? { ok: false, error: 'timeout' }))
    })
  }

  /** For `useSyncExternalStore`. Returns the same object until something changes. */
  getSnapshot = (): SessionClientSnapshot => this.snapshot

  /** For `useSyncExternalStore`. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Position of the current entry now. The engine's own position while this device
   * plays the entry, otherwise computed from the session anchor. Poll it (e.g. per
   * animation frame); it does not notify.
   */
  getPositionMs(): number {
    const status = this.isActive() ? this.player?.engine.getStatus() : undefined
    if (status && status.entryId === this.local.current?.id && status.state !== 'loading' && status.state !== 'error') {
      return status.positionMs
    }
    return positionAt(this.local, this.serverNow())
  }

  /** Current server time in epoch milliseconds, estimated from `time:sync` round trips. */
  serverNow(): number {
    return this.now() + this.offset
  }

  /** The session as `restore` takes it. */
  save(): SavedSession {
    const { state, queue } = splitSession(this.server?.session ?? createInitialSession())
    return {
      version: this.server?.version ?? 0,
      state,
      queue,
      pending: this.pending.map(({ commandId, command, at, ackVersion }) => ({ commandId, command, at, ackVersion })),
      savedAt: this.serverNow(),
      detached: this.detached,
    }
  }

  /**
   * Forgets resolved playback descriptors, so each entry is resolved again when it next
   * loads. For when the place an entry plays from has changed: a download finished or was
   * removed. With `trackId` only that track's are forgotten, and the preload is aimed again
   * only when it is that track, so a cache that fills as the queue plays never restarts the
   * preload of another entry. What the engine already holds keeps playing, with its gain.
   */
  forgetPlayback(trackId?: string): void {
    this.forgotten += 1
    if (trackId === undefined) {
      this.allForgottenAt = this.forgotten
      this.forgottenAt.clear()
      this.descriptors.clear()
    } else {
      this.forgottenAt.delete(trackId)
      this.forgottenAt.set(trackId, this.forgotten)
      if (this.forgottenAt.size > FORGOTTEN_TRACKS_SIZE) {
        // The oldest is let go as if everything had been forgotten then, which only ever keeps less.
        const [oldest, at] = this.forgottenAt.entries().next().value!
        this.forgottenAt.delete(oldest)
        this.allForgottenAt = Math.max(this.allForgottenAt, at)
      }
      for (const key of [...this.descriptors.keys()]) if (key.startsWith(`${trackId}:`)) this.descriptors.delete(key)
      if (this.preloadTrackId !== trackId) return
    }
    this.preloadTarget = null
    if (this.isActive()) this.preloadNext()
  }

  /** Renames this device. The server and the user's other devices learn the name from a fresh hello. */
  rename(name: string): void {
    if (name === this.device.name) return
    this.device = { ...this.device, name }
    if (this.transport.isConnected()) this.connect()
  }

  /**
   * Gets this device ready to take playback over: resolves the current entry and has the
   * engine buffer it, so a `transfer` here starts without waiting for either. For a pointer
   * on "Play here", which is most often pressed next. Does nothing while this device plays,
   * or when it has nothing to play.
   */
  prepareTakeover(): void {
    const player = this.player
    const current = this.local.current
    if (!player || this.isActive() || !current || current.state !== 'ready' || this.takeover === current.id) return
    this.takeover = current.id
    this.describe(current).then(
      descriptor => {
        // The engine keeps what it buffers as the preload, which `load` reuses when the entry is the same.
        if (this.isActive() || this.local.current?.id !== current.id || this.takeover !== current.id) return
        player.engine.preload({
          entryId: current.id, url: streamUrl(player.baseUrl, descriptor), gain: this.gainOf(current, descriptor, this.local), media: mediaOf(descriptor),
        })
      },
      () => {
        // The load after a transfer asks again and reports what fails.
        if (this.takeover === current.id) this.takeover = null
      },
    )
  }

  /** Changes the normalization mode (the user's setting) and applies it at once. */
  setNormalization(mode: NormalizationMode): void {
    this.normalization = mode
    if (this.isActive() && this.local.current) this.applyGain(this.local.current)
    this.publish()
  }

  /** Changes the loudness normalization brings songs to, in LUFS (the user's setting), at once. */
  setNormalizationTarget(targetLufs: number): void {
    if (targetLufs === this.normalizationTarget) return
    this.normalizationTarget = targetLufs
    if (this.isActive() && this.local.current) this.applyGain(this.local.current)
    this.publish()
  }

  // Sync

  private restore(saved: SavedSession): void {
    this.server = { version: saved.version, session: joinSession(saved.state, saved.queue) }
    this.detached = saved.detached ?? false
    // Replays skip validation, so what comes from storage is checked once here.
    this.pending = saved.pending.flatMap(pending => {
      const parsed = SessionCommand.safeParse(pending.command)
      return parsed.success ? [{ ...pending, command: parsed.data, sentEpoch: null }] : []
    })
    const session = this.rebase()
    if (session.playing && session.activeDeviceId === this.device.id) {
      const commands: Pending[] = [
        { commandId: this.newCommandId(), command: { type: 'pause' }, at: saved.savedAt, ackVersion: null, sentEpoch: null },
        { commandId: this.newCommandId(), command: { type: 'seek', positionMs: positionAt(session, saved.savedAt) }, at: saved.savedAt, ackVersion: null, sentEpoch: null },
      ]
      this.pending.push(...commands)
      this.restored = { commands: new Set(commands), version: saved.version, savedAt: saved.savedAt }
    }
    this.local = this.rebase()
  }

  private connect(): void {
    const attempt = ++this.attempt
    this.setConnection('connecting')
    const sentAt = this.now()
    const hello = { device: this.device, canPlay: Boolean(this.player), detached: this.detached, accepts: ['queueOps'] }
    this.transport.request('session:hello', hello, REQUEST_TIMEOUT_MS, (_error, reply) => {
      if (attempt !== this.attempt) return
      if (reply) return this.onHello(reply, sentAt, attempt)
      setTimer(() => {
        if (attempt === this.attempt && this.transport.isConnected()) this.connect()
      }, RETRY_MS)
    })
  }

  private onHello(reply: SessionHelloAck, sentAt: number, attempt: number): void {
    this.bestRtt = Infinity
    this.addClockSample(sentAt, reply.serverTime, this.now())
    this.epoch += 1
    const wasPlayingHere = this.isActive() && this.engineIsPlaying()
    const wasDetached = this.detached
    this.adopt(reply)
    this.connection = 'online'

    // The server says which session this device is in. When it is not the one held here,
    // what waits to be sent was made for the other one.
    const moved = this.detached !== wasDetached
    const asked = this.move
    if (asked) {
      // The answer to a detach or attach was lost with the connection; this is it.
      this.move = null
      if (moved) this.pending = this.pending.filter(pending => !asked.before.has(pending))
      asked.resolve(moved ? { ok: true } : { ok: false, error: asked.timedOut ? 'timeout' : 'disconnected' })
    } else if (moved) {
      this.pending = []
    }

    const restored = this.restored
    this.restored = null
    // The save is from up to several seconds before the app stopped. A server that changed
    // the session after it (it paused it when this device went away, or another device
    // played) holds a later position: seeking back to the save would rewind every device.
    // One that last changed before the save, as when this device played on offline, does not.
    const later = reply.snapshot.version > (restored?.version ?? Infinity) && reply.snapshot.state.anchorAt > (restored?.savedAt ?? Infinity)
    if (restored && (moved || later)) {
      this.pending = this.pending.filter(pending => !restored.commands.has(pending))
    }
    const active = reply.snapshot.state.activeDeviceId
    if (active !== null && active !== this.device.id) {
      this.pending = this.pending.filter(pending => !PLAYBACK_COMMANDS.has(pending.command.type))
    }
    this.prune()
    // After a change of session there is nothing to take back: what played here while
    // offline belonged to the session this device is no longer in.
    if (!moved && active === null) this.reclaim(wasPlayingHere)
    else if (!moved && active === this.device.id && wasPlayingHere && this.pending.some(pending => PLAYBACK_COMMANDS.has(pending.command.type))) {
      this.sendEnginePosition()
    }
    this.recompute()
    this.flush()
    this.syncClock(attempt, CLOCK_SAMPLES - 1)
    if (moved && wasDetached && !asked) this.onDetachedEnded?.(reply.detachedEnded ?? 'missing')
  }

  /** Makes a hello's answer (or a move's, which has the same shape) the server state held here. */
  private adopt(reply: SessionHelloAck): void {
    const { snapshot } = reply
    this.server = { version: snapshot.version, session: joinSession(snapshot.state, snapshot.queue) }
    this.heldQueue = null
    this.queueVersion = snapshot.queueVersion
    this.outOfSync = false
    this.syncing = false
    this.setDevices(reply.devices)
    this.detached = snapshot.scope?.type === 'device'
    this.serverDetaches = reply.capabilities?.includes('detach') ?? false
    this.serverUndoes = reply.capabilities?.includes('undo') ?? false
    this.serverSignals = reply.capabilities?.includes('signal') ?? false
    this.remoteSignal = reply.signal ?? null
    // The server may have restarted, or this device moved session: it hears it again.
    this.sentSignal = null
    this.serverSleeps = reply.capabilities?.includes('sleepTimer') ?? false
    this.serverJams = reply.capabilities?.includes('jam') ?? false
  }

  /** A member may send this to the jam they follow; see `memberCommandRoute`, and the jam's queue policy. */
  private memberMay(command: SessionCommand): boolean {
    const route = memberCommandRoute(command)
    if (route === 'own') return true
    if (route !== 'jam') return false
    return command.type !== 'enqueue' || this.local.jam?.queuePolicy === 'everyone'
  }

  /**
   * Keeps this device's audio on the jam's clock while it plays a jam it follows. Every
   * listener plays from the same anchor; a device that drifted further than `JAM_DRIFT_MS`
   * from it (a slow start, a stall, a clock estimate that improved) seeks back to it.
   */
  private alignToJam(): void {
    const session = this.local
    const current = session.current
    if (!this.player || !followsJam(session) || !this.isActive() || this.connection !== 'online') return
    if (!session.playing || session.stalled || current?.state !== 'ready') return
    const status = this.player.engine.getStatus()
    if (status.entryId !== current.id || status.state !== 'playing') return
    const expected = positionAt(session, this.serverNow())
    if (Math.abs(expected - status.positionMs) > JAM_DRIFT_MS) this.player.engine.seek(expected)
  }

  /**
   * The server moved this device to another session: on this client's request, or on that
   * of another socket of the device. Acks arrive in order, so a command acked by now was
   * applied to the session left behind and is in the new one only as far as the server
   * carried it over; one not acked yet is applied to the new session.
   */
  private onMoved(reply: SessionHelloAck): void {
    this.adopt(reply)
    this.pending = this.pending.filter(pending => pending.ackVersion === null)
    this.recompute()
    this.flush()
  }

  private requestMove(event: 'session:detach' | 'session:attach', request: { bringQueue?: boolean }, detached: boolean): Promise<SessionMoveResult> {
    if (this.move) return Promise.resolve({ ok: false, error: 'busy' })
    if (this.detached === detached) return Promise.resolve({ ok: true })
    if (this.connection !== 'online') return Promise.resolve({ ok: false, error: 'offline' })
    if (!this.canDetach()) return Promise.resolve({ ok: false, error: 'unsupported' })
    return new Promise(resolve => {
      const move: Move = { detached, before: new Set(this.pending), timedOut: false, resolve }
      this.move = move
      const epoch = this.epoch
      this.transport.request(event, request, REQUEST_TIMEOUT_MS, (_error: Error | null, reply?: SessionMoveAck) => {
        if (this.move !== move) return
        // Lost to a disconnect: the next hello says which session this device is in.
        if (!reply && (epoch !== this.epoch || this.connection !== 'online')) return
        if (!reply) {
          // The server may still have done it, and moved this socket. A hello says where it is.
          move.timedOut = true
          return this.connect()
        }
        this.move = null
        if (!reply.ok) return resolve({ ok: false, error: reply.error })
        this.onMoved(reply)
        resolve({ ok: true })
      })
    })
  }

  private settleMove(result: SessionMoveResult): void {
    const move = this.move
    this.move = null
    move?.resolve(result)
  }

  private canDetach(): boolean {
    return Boolean(this.player) && this.serverDetaches
  }

  /** A device playback cannot be moved to: the session held here does not include it. */
  private outOfSession(deviceId: string): boolean {
    if (this.detached) return deviceId !== this.device.id
    return this.devices.some(device => device.id === deviceId && device.detached !== undefined)
  }

  /**
   * Takes the session back after the server gave up on this device while it kept playing
   * offline, or ended tracks there: the server only accepts `trackEnded` from the active
   * device, so the transfer goes in just before the first one.
   */
  private reclaim(wasPlaying: boolean): void {
    if (!this.player) return
    const ended = this.pending.findIndex(pending => pending.command.type === 'trackEnded')
    if (!wasPlaying && ended < 0) return
    if (ended >= 0) {
      this.pending.splice(ended, 0, {
        commandId: this.newCommandId(),
        command: { type: 'transfer', deviceId: this.device.id, play: true },
        at: this.pending[ended]!.at,
        ackVersion: null,
        sentEpoch: null,
      })
    }
    if (wasPlaying) this.enqueue({ type: 'transfer', deviceId: this.device.id, play: true }, this.newCommandId())
    this.sendEnginePosition()
  }

  /**
   * The server replays commands made offline as they arrive, so positions they anchored
   * there would lag behind the audio that kept playing here; the engine's position follows them.
   */
  private sendEnginePosition(): void {
    const status = this.player?.engine.getStatus()
    if (status && status.entryId === this.rebase().current?.id && status.state !== 'idle') {
      this.enqueue({ type: 'seek', positionMs: status.positionMs }, this.newCommandId())
    }
  }

  private disconnected(): void {
    this.attempt += 1
    this.setConnection('offline')
  }

  /** Takes `remaining` more samples, one after another. */
  private syncClock(attempt: number, remaining: number): void {
    if (remaining <= 0) return
    this.transport.request('time:sync', this.now(), REQUEST_TIMEOUT_MS, (_error, reply) => {
      if (attempt !== this.attempt || !reply) return
      this.addClockSample(reply.clientTime, reply.serverTime, this.now())
      this.syncClock(attempt, remaining - 1)
    })
  }

  /** Keeps the offset from the round trip with the lowest RTT, the least skewed by asymmetry. */
  private addClockSample(sentAt: number, serverTime: number, receivedAt: number): void {
    const rtt = receivedAt - sentAt
    if (rtt >= this.bestRtt) return
    this.bestRtt = rtt
    this.offset = serverTime - (sentAt + rtt / 2)
  }

  private onQueue(update: { version: number; queueVersion: number; queue: SessionQueue }): void {
    if (this.server && update.version <= this.server.version) return
    if (this.heldQueue && update.version < this.heldQueue.version) return
    this.heldQueue = { version: update.version, queue: update.queue }
    // The whole queue: whatever was missing, this is it.
    this.queueVersion = update.queueVersion
    this.outOfSync = false
  }

  /** Operations on the queue held, held like a whole queue until the state of the same version. */
  private onQueueOps(update: SessionQueueOps): void {
    if (!this.server || update.version <= this.server.version || this.outOfSync) return
    if (this.heldQueue && update.version < this.heldQueue.version) return
    // Small, so checked whole: a server's mistake asks for the queue rather than corrupting it.
    const parsed = SessionQueueOps.safeParse(update)
    const base = this.heldQueue?.queue ?? splitSession(this.server.session).queue
    const queue = parsed.success && update.baseQueueVersion === this.queueVersion && this.holdsScope(update.scope)
      ? applyQueueOps(base, parsed.data.ops, parsed.data.lengths)
      : null
    if (!queue) {
      this.outOfSync = true
      return this.requestSync()
    }
    this.heldQueue = { version: update.version, queue }
    this.queueVersion = update.queueVersion
  }

  /** `scope` is the session held here: a detached device's own counts versions of its own. */
  private holdsScope(scope: SessionScope | undefined): boolean {
    if (!scope) return !this.detached
    return this.detached ? scope.type === 'device' && scope.deviceId === this.device.id : scope.type === 'shared'
  }

  /** Asks for the whole session after operations did not apply, again every few seconds until it comes. */
  private requestSync(): void {
    if (this.syncing || this.connection !== 'online') return
    this.syncing = true
    const epoch = this.epoch
    this.transport.request('session:sync', {}, REQUEST_TIMEOUT_MS, (_error: Error | null, reply?: SessionSyncAck) => {
      // A hello since answered with the whole session.
      if (epoch !== this.epoch) return
      this.syncing = false
      if (!this.outOfSync) return
      if (reply?.ok && this.adoptSync(reply.snapshot)) return
      setTimer(() => {
        if (epoch === this.epoch && this.outOfSync) this.requestSync()
      }, RETRY_MS)
    })
  }

  /** Makes a `session:sync` answer the server state held here, when it is of this session and not older. */
  private adoptSync(snapshot: SessionSnapshot): boolean {
    if (!this.server || !this.holdsScope(snapshot.scope) || snapshot.version < this.server.version) return false
    this.server = { version: snapshot.version, session: joinSession(snapshot.state, snapshot.queue) }
    if (this.heldQueue && this.heldQueue.version <= snapshot.version) this.heldQueue = null
    this.queueVersion = snapshot.queueVersion
    this.outOfSync = false
    this.prune()
    this.recompute()
    return true
  }

  private onState(update: { version: number; state: SessionState }): void {
    if (!this.server || update.version <= this.server.version) return
    let queue = splitSession(this.server.session).queue
    if (this.heldQueue && this.heldQueue.version <= update.version) {
      queue = this.heldQueue.queue
      this.heldQueue = null
    }
    this.server = { version: update.version, session: joinSession(update.state, queue) }
    this.prune()
    this.recompute()
  }

  private enqueue(command: SessionCommand, commandId: string): void {
    this.pending.push({ commandId, command, at: this.serverNow(), ackVersion: null, sentEpoch: null })
  }

  private flush(): void {
    if (this.connection !== 'online') return
    for (const pending of this.pending) {
      if (pending.sentEpoch !== this.epoch) this.send(pending)
    }
  }

  private send(pending: Pending): void {
    const epoch = this.epoch
    pending.sentEpoch = epoch
    this.transport.request('session:command', { commandId: pending.commandId, command: pending.command }, REQUEST_TIMEOUT_MS, (_error, ack) => {
      if (ack) return this.onAck(pending, ack)
      // Lost while still connected: give up on it. Lost to a disconnect: it is re-sent after the next hello.
      if (epoch === this.epoch && this.connection === 'online') this.drop(pending)
    })
  }

  private onAck(pending: Pending, ack: CommandAck): void {
    if (!this.pending.includes(pending)) return
    if (!ack.ok) return this.drop(pending)
    pending.ackVersion = ack.version
    const count = this.pending.length
    this.prune()
    if (this.pending.length !== count) this.recompute()
  }

  private drop(pending: Pending): void {
    this.pending = this.pending.filter(item => item !== pending)
    this.recompute()
  }

  /** Forgets commands the server state already includes. */
  private prune(): void {
    const version = this.server?.version
    if (version === undefined) return
    this.pending = this.pending.filter(pending => pending.ackVersion === null || pending.ackVersion > version)
  }

  private rebase(): Session {
    let session = this.server?.session ?? createInitialSession()
    for (const pending of this.pending) {
      session = reduceParsedSession(session, { command: pending.command, now: pending.at, commandId: pending.commandId, deviceId: this.playDeviceId() })
    }
    return session
  }

  private recompute(seek = false): void {
    const previous = this.local
    this.local = this.rebase()
    this.publish()
    this.syncEngine(previous, seek)
  }

  // Store

  private publish(): void {
    const { state, queue } = splitSession(this.local)
    const previous = this.snapshot
    const session = shallowEqual(previous.session, state) ? previous.session : state
    const queueHalf = shallowEqual(previous.queue, queue) ? previous.queue : queue
    const isActiveDevice = this.isActive()
    const canDetach = this.canDetach()
    // A jam's edits are undone by its host alone, so a member is not offered undo.
    const canUndo = this.serverUndoes && !followsJam(this.local)
    const outage = this.outage()
    const away = this.away(previous.away)
    const signal = this.signal(previous.signal)
    this.sendSignal(signal)
    if (
      session === previous.session && queueHalf === previous.queue && this.devices === previous.devices
      && this.connection === previous.connection && isActiveDevice === previous.isActiveDevice
      && this.detached === previous.detached && canDetach === previous.canDetach && this.serverSleeps === previous.canSetSleepTimer && canUndo === previous.canUndo
      && this.serverJams === previous.canJam && outage === previous.outage && away === previous.away && signal === previous.signal
    ) return
    this.snapshot = {
      session, queue: queueHalf, devices: this.devices, connection: this.connection, isActiveDevice, detached: this.detached, canDetach,
      canSetSleepTimer: this.serverSleeps, canUndo, canJam: this.serverJams, outage, away, signal,
    }
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * The signal path to show: this device's while it plays the current entry, else the
   * active device's report about it. `previous` is kept while it says the same.
   */
  private signal(previous: SignalPath | null): SignalPath | null {
    const current = this.local.current
    let signal: SignalPath | null = null
    if (this.isActive()) {
      const descriptor = current && this.inEngine.get(current.id)
      if (current && descriptor) {
        const albumContext = this.inAlbumContext(current, this.local)
        const normalization = {
          mode: this.normalization,
          targetLufs: this.normalizationTarget,
          ...appliedGain(this.normalization, descriptor.normalization, this.gainContext(albumContext)),
        }
        signal = { ...signalReport(current.id, descriptor, normalization, descriptor.url.startsWith('file:')), deviceId: this.device.id }
      }
    } else {
      const remote = this.remoteSignal
      if (remote && remote.entryId === current?.id && remote.deviceId === this.local.activeDeviceId) signal = remote
    }
    if (signal === previous || (signal && previous && JSON.stringify(signal) === JSON.stringify(previous))) return previous
    return signal
  }

  /**
   * Tells the server what this device plays, when it is the active device and that changed.
   * Only once the server's own state has the entry current on this device: it drops a report
   * about any other, so one sent ahead of the `trackEnded` or `transfer` that gets it there
   * would be lost. That state's arrival publishes again.
   */
  private sendSignal(signal: SignalPath | null): void {
    if (!signal || signal.deviceId !== this.device.id || this.connection !== 'online' || !this.serverSignals) return
    const held = this.server?.session
    if (held?.current?.id !== signal.entryId || held.activeDeviceId !== this.device.id) return
    const { deviceId: _deviceId, ...report } = signal
    const key = JSON.stringify(report)
    if (key === this.sentSignal) return
    this.sentSignal = key
    this.transport.signal(report)
  }

  private setDevices(devices: DeviceInfo[]): void {
    this.devices = devices
    for (const device of devices) {
      this.seen.delete(device.id)
      this.seen.set(device.id, device)
    }
    for (const id of this.seen.keys()) {
      if (this.seen.size <= REMEMBERED_DEVICES) break
      this.seen.delete(id)
    }
  }

  /**
   * The active device, when the session names one the live list leaves out. Only an online
   * client's list is current, so only it can tell. `previous` is kept while it says the same.
   */
  private away(previous: AwayDevice | null): AwayDevice | null {
    const id = this.local.activeDeviceId
    if (this.connection !== 'online' || id === null || id === this.device.id || this.devices.some(device => device.id === id)) return null
    const device = this.seen.get(id) ?? null
    return previous?.id === id && previous.device === device ? previous : { id, device }
  }

  /**
   * The outage told by the server while the session is still paused on it. The server sends
   * `playback.unavailable` just before the state that pauses, so a listener sees the pause
   * and its reason together; until that state arrives the outage is kept, not shown. Once
   * the session plays again (here or elsewhere) or moves to another entry, it is forgotten.
   */
  private outage(): SessionOutage | null {
    const told = this.told
    if (!told) return null
    const { current, playing } = this.local
    const on = told.outage.trackId === null || current?.trackId === told.outage.trackId
    if (on && !playing && current?.state === 'failed') {
      told.shown = true
      return told.outage
    }
    if (!told.shown && on) return null
    this.told = null
    return null
  }

  private setConnection(connection: ConnectionStatus): void {
    this.connection = connection
    this.publish()
  }

  private isActive(): boolean {
    return Boolean(this.player) && this.local.activeDeviceId === this.device.id
  }

  /** Only a device that can play may become active. */
  private playDeviceId(): string | undefined {
    return this.player ? this.device.id : undefined
  }

  private newCommandId(): string {
    this.serial += 1
    return `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${this.serial.toString(36)}`
  }

  // Engine

  private syncEngine(previous: Session, forceSeek: boolean): void {
    if (!this.player) return
    const { engine } = this.player
    const session = this.local
    const current = session.current
    this.followFade(this.isActive() && session.playing && session.sleepTimer !== undefined)
    if (!this.isActive() || !current || current.state !== 'ready') return this.stopEngine()
    this.takeover = null

    const status = engine.getStatus()
    if (status.entryId !== current.id) {
      // As for an engine error below: only play or a seek tries a refused entry again.
      const retry = this.refusedEntryId !== current.id || forceSeek || (session.playing && !previous.playing)
      if (retry && this.loadingEntryId !== current.id) void this.load(current)
      return
    }
    if (status.state === 'error') {
      // The engine cannot recover a failed entry. Pressing play again or seeking retries it
      // with a fresh descriptor; other updates (such as the stall the error report causes) do not.
      const retry = forceSeek || (session.playing && !previous.playing)
      if (retry && this.loadingEntryId !== current.id) void this.load(current)
      return
    }
    const moved = previous.current?.id !== current.id || previous.positionMs !== session.positionMs || previous.anchorAt !== session.anchorAt
    if (forceSeek || moved) {
      const expected = positionAt(session, this.serverNow())
      if (forceSeek || Math.abs(expected - status.positionMs) > this.driftThresholdMs) engine.seek(expected)
    }
    const running = status.state === 'playing' || status.state === 'buffering' || status.state === 'loading'
    if (session.playing && !running) engine.play()
    if (!session.playing && running) engine.pause()
    this.applyGain(current)
    this.preloadNext()
  }

  private stopEngine(): void {
    if (!this.player) return
    // What was buffered for a takeover is dropped once another entry plays elsewhere.
    if (this.takeover !== null && this.takeover !== this.local.current?.id) {
      this.takeover = null
      this.player.engine.preload(null)
    }
    this.loadToken += 1
    this.loadingEntryId = null
    this.preloadTarget = null
    this.preloadTrackId = null
    this.gain = null
    this.inEngine.clear()
    if (this.player.engine.getStatus().state !== 'idle') this.player.engine.stop()
  }

  private async load(entry: QueueEntry): Promise<void> {
    const { engine, baseUrl } = this.player!
    const token = ++this.loadToken
    this.loadingEntryId = entry.id
    this.refusedEntryId = null
    const asked = this.local
    const startMs = this.startPosition(asked)
    let descriptor: PlaybackDescriptor
    try {
      descriptor = await this.describe(entry)
    } catch (error) {
      if (token !== this.loadToken) return
      this.loadingEntryId = null
      const willRetry = !isRefusal(error)
      // Whatever the engine still holds is the entry before this one; it must not go on playing.
      if (engine.getStatus().entryId !== entry.id && engine.getStatus().state !== 'idle') engine.stop()
      this.reportLoadFailure(entry, willRetry ? 'buffering' : 'error')
      if (willRetry && this.unloaded?.entryId !== entry.id) {
        this.unloaded = { entryId: entry.id, anchorAt: asked.anchorAt, anchorMs: asked.positionMs, startMs }
      }
      if (willRetry) {
        setTimer(() => {
          if (token === this.loadToken) this.syncEngine(this.local, false)
        }, RETRY_MS)
      } else {
        this.refusedEntryId = entry.id
      }
      this.player!.onLoadError?.(entry, error, willRetry)
      return
    }
    if (token !== this.loadToken) return
    this.loadingEntryId = null
    const session = this.local
    if (session.current?.id !== entry.id) return
    this.hold(entry.id, descriptor)
    this.gain = this.gainOf(entry, descriptor, session)
    // Time spent unable to load (offline) is not time played: a retry starts where the first
    // try would have, unless the session was moved meanwhile (a seek, or another device's clock).
    const unloaded = this.unloaded
    this.unloaded = null
    const waited = unloaded?.entryId === entry.id && unloaded.anchorAt === session.anchorAt && unloaded.anchorMs === session.positionMs
    engine.load({
      entryId: entry.id,
      url: streamUrl(baseUrl, descriptor),
      startMs: waited ? unloaded.startMs : this.startPosition(session),
      autoplay: session.playing,
      gain: this.gain,
      media: mediaOf(descriptor),
    })
    this.preloadNext()
    // The signal path follows what the engine now holds.
    this.publish()
  }

  /**
   * Where a load starts: where the session clock is, except for an entry that has only just
   * started. Its clock has run the few milliseconds the load took to begin, but an exact
   * seek that short makes a streaming player drop its buffer (a preloaded one included)
   * and fetch again, which costs a second or two of silence. Starting at 0 is inaudibly
   * different, and the engine's first report puts the clock right.
   */
  private startPosition(session: Session): number {
    const expected = positionAt(session, this.serverNow())
    return session.positionMs === 0 && expected < this.driftThresholdMs ? 0 : expected
  }

  /** Preloads the entry `trackEnded` would start, so the engine can continue without a gap. */
  private preloadNext(): void {
    const { engine, baseUrl } = this.player!
    const session = this.local
    const current = session.current
    if (!current) return
    const predicted = reduceParsedSession(session, {
      command: { type: 'trackEnded', entryId: current.id },
      now: this.serverNow(),
      commandId: this.endCommandId(current.id),
      deviceId: this.device.id,
    })
    const next = predicted.playing && predicted.current && predicted.current.id !== current.id && predicted.current.state === 'ready'
      ? predicted.current
      : null
    if ((next?.id ?? null) === this.preloadTarget) return
    this.preloadTarget = next?.id ?? null
    this.preloadTrackId = next?.trackId ?? null
    const token = ++this.preloadToken
    if (!next) return engine.preload(null)
    this.describe(next).then(
      descriptor => {
        if (token !== this.preloadToken || this.preloadTarget !== next.id || !this.isActive()) return
        this.hold(next.id, descriptor)
        engine.preload({ entryId: next.id, url: streamUrl(baseUrl, descriptor), gain: this.gainOf(next, descriptor, predicted), media: mediaOf(descriptor) })
      },
      error => {
        // A refusal is the server's answer for this entry; asking again on every session
        // change would get the same one. It stays the target, so only a new target or
        // `forgetPlayback` asks again, and the entry's own load reports the refusal.
        if (isRefusal(error)) return
        if (token === this.preloadToken && this.preloadTarget === next.id) this.preloadTarget = null
      },
    )
  }

  /** Remembers what an entry handed to the engine was resolved to, and drops the entries the engine no longer has. */
  private hold(entryId: string, descriptor: PlaybackDescriptor): void {
    this.inEngine.set(entryId, descriptor)
    for (const id of [...this.inEngine.keys()]) {
      if (id !== entryId && id !== this.local.current?.id && id !== this.preloadTarget) this.inEngine.delete(id)
    }
  }

  private endCommandId(entryId: string): string {
    if (this.endCommand?.entryId !== entryId) this.endCommand = { entryId, commandId: this.newCommandId() }
    return this.endCommand.commandId
  }

  private async describe(entry: QueueEntry): Promise<PlaybackDescriptor> {
    const key = descriptorKey(entry)
    const cached = this.descriptors.get(key)
    if (cached && Date.parse(cached.expiresAt) - DESCRIPTOR_MARGIN_MS > this.serverNow()) return cached
    const begun = this.forgotten
    const descriptor = await this.player!.resolvePlayback(entry)
    // Where it plays from may have changed while it was asked: good for this load, not for the next.
    if (this.allForgottenAt > begun || (this.forgottenAt.get(entry.trackId) ?? 0) > begun) return descriptor
    this.descriptors.delete(key)
    this.descriptors.set(key, descriptor)
    if (this.descriptors.size > DESCRIPTOR_CACHE_SIZE) this.descriptors.delete(this.descriptors.keys().next().value!)
    return descriptor
  }

  private gainOf(entry: QueueEntry, descriptor: PlaybackDescriptor | undefined, session: Session): number {
    const volume = this.player?.systemVolume ? 1 : session.volumes[this.device.id] ?? 1
    const albumContext = this.inAlbumContext(entry, session)
    const fade = entry.id === session.current?.id ? this.fadeOf(session) : 1
    return volume * fade * appliedGain(this.normalization, descriptor?.normalization, this.gainContext(albumContext)).gain
  }

  /** What normalization depends on besides the song: the same for the gain applied and the one reported. */
  private gainContext(albumContext: boolean): GainContext {
    return { albumContext, canBoost: this.player?.canBoost ?? false, limiter: this.player?.limiter ?? false, targetLufs: this.normalizationTarget }
  }

  private inAlbumContext(entry: QueueEntry, session: Session): boolean {
    return !session.shuffle && session.context?.type === 'album' && session.context.id === entry.albumId
  }

  /**
   * The sleep timer's fade for `session`'s current entry, measured from the engine's own
   * position while it plays that entry: it is what the listener hears end.
   */
  private fadeOf(session: Session): number {
    if (!session.sleepTimer) return 1
    const status = this.player?.engine.getStatus()
    const engineMs = status && status.entryId === session.current?.id && status.state !== 'loading' && status.state !== 'error' ? status.positionMs : undefined
    return sleepFade(session, this.serverNow(), engineMs)
  }

  /**
   * While a sleep timer is set and this device plays, brings the gain along the timer's fade
   * a few times a second; nothing changes until its last seconds. The server pauses the
   * session when the timer ends, and the gain comes back with the pause. A device playing
   * offline, which the server's pause cannot reach, pauses itself a little later.
   */
  private followFade(on: boolean): void {
    if (on === (this.fadeTimer !== null)) return
    if (!on) {
      clearRepeating(this.fadeTimer)
      this.fadeTimer = null
      return
    }
    this.fadeTimer = setRepeating(() => {
      const { current, sleepTimer, playing } = this.local
      if (!this.isActive() || !current || current.state !== 'ready') return
      this.applyGain(current)
      if (this.connection !== 'online' && playing && sleepTimer?.kind === 'time' && this.serverNow() >= sleepTimer.endsAt + SLEEP_OFFLINE_GRACE_MS) {
        this.dispatch({ type: 'pause' })
      }
    }, FADE_TICK_MS)
  }

  private applyGain(entry: QueueEntry): void {
    const gain = this.gainOf(entry, this.inEngine.get(entry.id) ?? this.descriptors.get(descriptorKey(entry)), this.local)
    if (gain === this.gain) return
    this.gain = gain
    this.player!.engine.setGain(gain)
  }

  private engineIsPlaying(): boolean {
    const status = this.player?.engine.getStatus()
    if (!status) return false
    if (status.state === 'playing' || status.state === 'buffering') return true
    // A song another device just switched to is still loading here (a stream takes a moment
    // to start), but it is the one this device is playing: when the connection drops in
    // that moment and the server gives up on the device, it takes the session back all the same.
    return status.state === 'loading' && this.local.playing && status.entryId === this.local.current?.id
  }

  private onEngineEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'ended':
        if (this.isActive() && event.entryId === this.local.current?.id) {
          this.enqueue({ type: 'trackEnded', entryId: event.entryId }, this.endCommandId(event.entryId))
          this.recompute()
          this.flush()
        }
        return
      case 'error':
        // A stale signed URL is the likeliest cause; resolve afresh on the next load.
        if (this.local.current?.id === event.entryId) this.descriptors.delete(descriptorKey(this.local.current))
        return
      case 'status': {
        const finishedLoading = this.engineState === 'loading' && event.status.state !== 'loading'
        this.engineState = event.status.state
        this.report(event.status, false)
        // A command may have arrived while the engine was loading with the old play state.
        if (finishedLoading) this.syncEngine(this.local, false)
      }
    }
  }

  /**
   * Nothing is loaded for `entry`, so the engine has nothing to report: say it here, which
   * stops the clock on the user's other devices instead of letting it run through a silent track.
   */
  private reportLoadFailure(entry: QueueEntry, status: 'buffering' | 'error'): void {
    const session = this.local
    if (!this.isActive() || this.connection !== 'online' || session.current?.id !== entry.id || !session.playing) return
    const key = `${entry.id}:${status}`
    if (key === this.lastReport) return
    this.lastReport = key
    this.transport.report({ entryId: entry.id, status, positionMs: positionAt(session, this.serverNow()), at: this.serverNow() })
  }

  private report(status: EngineStatus, periodic: boolean): void {
    const reported = REPORTED[status.state]
    if (!reported || !status.entryId || !this.isActive() || this.connection !== 'online' || status.entryId !== this.local.current?.id) return
    const key = `${status.entryId}:${reported}`
    if (!periodic && key === this.lastReport) return
    this.lastReport = key
    this.transport.report({ entryId: status.entryId, status: reported, positionMs: status.positionMs, at: this.serverNow() })
  }
}

/**
 * The server answered and will not serve the track (gone, forbidden, not available):
 * asking again gives the same answer. Timeouts and rate limits pass.
 */
function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
}

function mediaOf(descriptor: PlaybackDescriptor): EngineMedia {
  return { transcoded: descriptor.transcoded, gapless: descriptor.gapless ?? null }
}

function descriptorKey(entry: QueueEntry): string {
  return `${entry.trackId}:${entry.albumId ?? ''}`
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[]
  return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]))
}
