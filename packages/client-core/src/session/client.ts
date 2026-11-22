import {
  type ClientDevice,
  type CommandAck,
  type DeviceInfo,
  type EngineReport,
  type NormalizationMode,
  type PlaybackDescriptor,
  type QueueEntry,
  SessionCommand,
  type SessionHelloAck,
  type SessionQueue,
  type SessionState,
} from '@squirmy/contracts'
import { streamUrl } from '../api/client.js'
import type { EngineEvent, EngineState, EngineStatus, PlayerEngine } from '../engine.js'
import { gainFor } from '../normalization.js'
import { clearRepeating, setRepeating, setTimer } from '../timers.js'
import { createInitialSession, joinSession, positionAt, reduceSession, type Session, splitSession } from './reducer.js'
import type { SessionTransport } from './transport.js'

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
}

/** Audio output of a device that can play. */
export type SessionPlayer = {
  engine: PlayerEngine
  /** Fetches `GET /tracks/:id/playback` for an entry (with the entry's album and the device's quality and codecs). */
  resolvePlayback: (entry: QueueEntry) => Promise<PlaybackDescriptor>
  /** Server root the descriptor's `url` is relative to; see `streamUrl`. */
  baseUrl: string
  /** Initial normalization mode (the user's setting). Defaults to `auto`. */
  normalization?: NormalizationMode
  /** The engine can amplify above unity. Defaults to false. */
  canBoost?: boolean
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
  /** Local clock. Defaults to `Date.now`. */
  now?: () => number
  /** After the session's position moves, the engine is re-seeked only when it is further off than this. Defaults to 1000. */
  driftThresholdMs?: number
  /** Engine reports are sent on status changes and at this interval. Defaults to 10000. */
  reportIntervalMs?: number
}

/** Dropped from the unsent commands when the server says another device took over. */
const PLAYBACK_COMMANDS = new Set<SessionCommand['type']>([
  'play', 'pause', 'next', 'previous', 'seek', 'playTracks', 'playQueueEntry', 'transfer', 'trackEnded',
])
const REQUEST_TIMEOUT_MS = 10_000
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

  private server: { version: number; session: Session } | null = null
  private heldQueue: { version: number; queue: SessionQueue } | null = null
  private pending: Pending[] = []
  private local: Session = createInitialSession()
  private devices: DeviceInfo[] = []
  private connection: ConnectionStatus = 'offline'
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
  private loadToken = 0
  private loadingEntryId: string | null = null
  private preloadTarget: string | null = null
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
    this.normalization = options.player?.normalization ?? 'auto'
    if (options.restore) this.restore(options.restore)
    const { state, queue } = splitSession(this.local)
    this.snapshot = { session: state, queue, devices: this.devices, connection: this.connection, isActiveDevice: this.isActive() }
  }

  /** Subscribes to the transport and the engine, and says hello if already connected. Call once. */
  start(): void {
    const { transport, player } = this
    this.cleanup.push(
      transport.onConnectionChange(connected => (connected ? this.connect() : this.disconnected())),
      transport.on('session:state', update => this.onState(update)),
      transport.on('session:queue', update => this.onQueue(update)),
      transport.on('devices', devices => {
        this.devices = devices
        this.publish()
      }),
    )
    if (player) {
      this.cleanup.push(player.engine.subscribe(event => this.onEngineEvent(event)))
      const timer = setRepeating(() => this.report(player.engine.getStatus(), true), this.reportIntervalMs)
      this.cleanup.push(() => clearRepeating(timer))
      // A restored session this device was playing loads paused, ready to resume offline.
      this.syncEngine(this.local, false)
    }
    if (transport.isConnected()) this.connect()
  }

  /** Unsubscribes everything and stops the engine. */
  dispose(): void {
    for (const undo of this.cleanup.splice(0)) undo()
    this.attempt += 1
    this.stopEngine()
  }

  /**
   * Applies a command locally at once and sends it (now, or after reconnecting).
   * Throws a ZodError when the command does not match `SessionCommand`.
   */
  dispatch(command: SessionCommand): void {
    const parsed = SessionCommand.parse(command)
    this.enqueue(parsed, this.newCommandId())
    this.recompute(parsed.type === 'seek')
    this.flush()
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

  /** Changes the normalization mode (the user's setting) and applies it at once. */
  setNormalization(mode: NormalizationMode): void {
    this.normalization = mode
    if (this.isActive() && this.local.current) this.applyGain(this.local.current)
  }

  // Sync

  private restore(saved: SavedSession): void {
    this.server = { version: saved.version, session: joinSession(saved.state, saved.queue) }
    this.pending = saved.pending.map(pending => ({ ...pending, sentEpoch: null }))
    const session = this.rebase()
    if (session.playing && session.activeDeviceId === this.device.id) {
      this.pending.push(
        { commandId: this.newCommandId(), command: { type: 'pause' }, at: saved.savedAt, ackVersion: null, sentEpoch: null },
        { commandId: this.newCommandId(), command: { type: 'seek', positionMs: positionAt(session, saved.savedAt) }, at: saved.savedAt, ackVersion: null, sentEpoch: null },
      )
    }
    this.local = this.rebase()
  }

  private connect(): void {
    const attempt = ++this.attempt
    this.setConnection('connecting')
    const sentAt = this.now()
    this.transport.request('session:hello', { device: this.device, canPlay: Boolean(this.player) }, REQUEST_TIMEOUT_MS, (_error, reply) => {
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
    const { snapshot } = reply
    this.server = { version: snapshot.version, session: joinSession(snapshot.state, snapshot.queue) }
    this.heldQueue = null
    this.devices = reply.devices
    this.connection = 'online'

    const active = snapshot.state.activeDeviceId
    if (active !== null && active !== this.device.id) {
      this.pending = this.pending.filter(pending => !PLAYBACK_COMMANDS.has(pending.command.type))
    }
    this.prune()
    if (active === null) this.reclaim(wasPlayingHere)
    else if (active === this.device.id && wasPlayingHere && this.pending.some(pending => PLAYBACK_COMMANDS.has(pending.command.type))) {
      this.sendEnginePosition()
    }
    this.recompute()
    this.flush()
    this.syncClock(attempt, CLOCK_SAMPLES - 1)
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

  private onQueue(update: { version: number; queue: SessionQueue }): void {
    if (this.server && update.version <= this.server.version) return
    if (!this.heldQueue || update.version >= this.heldQueue.version) this.heldQueue = update
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
      session = reduceSession(session, { command: pending.command, now: pending.at, commandId: pending.commandId, deviceId: this.playDeviceId() })
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
    if (
      session === previous.session && queueHalf === previous.queue && this.devices === previous.devices
      && this.connection === previous.connection && isActiveDevice === previous.isActiveDevice
    ) return
    this.snapshot = { session, queue: queueHalf, devices: this.devices, connection: this.connection, isActiveDevice }
    for (const listener of [...this.listeners]) listener()
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
    if (!this.isActive() || !current || current.state !== 'ready') return this.stopEngine()

    const status = engine.getStatus()
    if (status.entryId !== current.id) {
      if (this.loadingEntryId !== current.id) void this.load(current)
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
    let descriptor: PlaybackDescriptor
    try {
      descriptor = await this.describe(entry)
    } catch {
      if (token !== this.loadToken) return
      this.loadingEntryId = null
      setTimer(() => {
        if (token === this.loadToken) this.syncEngine(this.local, false)
      }, RETRY_MS)
      return
    }
    if (token !== this.loadToken) return
    this.loadingEntryId = null
    const session = this.local
    if (session.current?.id !== entry.id) return
    this.hold(entry.id, descriptor)
    this.gain = this.gainOf(entry, descriptor, session)
    engine.load({
      entryId: entry.id,
      url: streamUrl(baseUrl, descriptor),
      startMs: positionAt(session, this.serverNow()),
      autoplay: session.playing,
      gain: this.gain,
    })
    this.preloadNext()
  }

  /** Preloads the entry `trackEnded` would start, so the engine can continue without a gap. */
  private preloadNext(): void {
    const { engine, baseUrl } = this.player!
    const session = this.local
    const current = session.current
    if (!current) return
    const predicted = reduceSession(session, {
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
        engine.preload({ entryId: next.id, url: streamUrl(baseUrl, descriptor), gain: this.gainOf(next, descriptor, predicted) })
      },
      () => {
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
    const volume = session.volumes[this.device.id] ?? 1
    const albumContext = !session.shuffle && session.context?.type === 'album' && session.context.id === entry.albumId
    return volume * gainFor(this.normalization, descriptor?.normalization, { albumContext, canBoost: this.player?.canBoost ?? false })
  }

  private applyGain(entry: QueueEntry): void {
    const gain = this.gainOf(entry, this.inEngine.get(entry.id) ?? this.descriptors.get(descriptorKey(entry)), this.local)
    if (gain === this.gain) return
    this.gain = gain
    this.player!.engine.setGain(gain)
  }

  private engineIsPlaying(): boolean {
    const state = this.player?.engine.getStatus().state
    return state === 'playing' || state === 'buffering'
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

  private report(status: EngineStatus, periodic: boolean): void {
    const reported = REPORTED[status.state]
    if (!reported || !status.entryId || !this.isActive() || this.connection !== 'online' || status.entryId !== this.local.current?.id) return
    const key = `${status.entryId}:${reported}`
    if (!periodic && key === this.lastReport) return
    this.lastReport = key
    this.transport.report({ entryId: status.entryId, status: reported, positionMs: status.positionMs, at: this.serverNow() })
  }
}

function descriptorKey(entry: QueueEntry): string {
  return `${entry.trackId}:${entry.albumId ?? ''}`
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[]
  return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]))
}
