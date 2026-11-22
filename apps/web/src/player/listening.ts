import type { EngineStatus, SessionClientSnapshot } from '@squirmy/client-core'
import type { SessionCommand } from '@squirmy/contracts'

/**
 * What the listener gets of playback, which is not always what the session says:
 *
 * - `paused`: nothing is meant to play.
 * - `waiting`: something is meant to play and there is no sound yet. The song is being
 *   fetched, its stream resolved or buffered, or the device that plays is stalled.
 * - `playing`: there is sound.
 * - `blocked`: this tab should play, and the browser holds audio back until a click.
 */
export type Audible = 'paused' | 'waiting' | 'playing' | 'blocked'

/** The parts of the session client the player reads and drives. */
export type ListeningClient = {
  getSnapshot: () => SessionClientSnapshot
  getPositionMs: () => number
  dispatch: (command: SessionCommand) => void
}

/** The parts of this tab's engine it reads. */
export type ListeningEngine = {
  getStatus: () => EngineStatus
  isBlocked: () => boolean
}

/**
 * What can be heard now. On the device that plays, the session says playing as soon as a
 * command is applied, well before the first sample, so the engine is the truth: only its
 * `playing` on the current entry is sound. Elsewhere, the session's `stalled` (from the
 * playing device's reports) is all there is to go on.
 */
export function audibleOf(snapshot: Pick<SessionClientSnapshot, 'session' | 'isActiveDevice'>, engine: ListeningEngine): Audible {
  const { session, isActiveDevice } = snapshot
  const current = session.current
  if (!session.playing || !current) return 'paused'
  if (!isActiveDevice) return current.state === 'ready' && !session.stalled ? 'playing' : 'waiting'
  const status = engine.getStatus()
  const holds = status.entryId === current.id
  if (holds && engine.isBlocked()) return 'blocked'
  return holds && current.state === 'ready' && status.state === 'playing' ? 'playing' : 'waiting'
}

/**
 * Keeps the player honest about time and seeking while nothing can be heard:
 *
 * - The position stands still where the music will start. The session's clock runs from
 *   the moment playback was asked for, and offline nothing tells it the audio never came,
 *   so it would count through silence and then jump back.
 * - A seek made while the song is still being fetched is kept and sent once it is ready.
 *   The session ignores seeks then, since nothing knows the song's length for certain.
 */
export class Listening {
  private readonly client: ListeningClient
  private readonly engine: ListeningEngine
  /** A seek asked for while its entry was being fetched. */
  private pendingSeek: { entryId: string; positionMs: number } | null = null
  /** Where the clock stands for an entry the engine has not got yet. */
  private held: { entryId: string; positionMs: number } | null = null
  /** The last position read, so an entry that stops being heard keeps it instead of jumping. */
  private last: { entryId: string; positionMs: number } | null = null

  constructor(client: ListeningClient, engine: ListeningEngine) {
    this.client = client
    this.engine = engine
  }

  audible(): Audible {
    return audibleOf(this.client.getSnapshot(), this.engine)
  }

  /** The position to show. Poll it, as `SessionClient.getPositionMs`. */
  position(): number {
    const snapshot = this.client.getSnapshot()
    const current = snapshot.session.current
    if (!current) return this.client.getPositionMs()
    if (this.pendingSeek?.entryId === current.id) return this.pendingSeek.positionMs
    const audible = audibleOf(snapshot, this.engine)
    if (!snapshot.isActiveDevice || (audible !== 'waiting' && audible !== 'blocked')) return this.read(current.id)
    const status = this.engine.getStatus()
    // Loading, the engine reports where it is heading; buffering, where it stopped.
    if (status.entryId === current.id && status.state !== 'error' && status.state !== 'idle') return this.read(current.id, status.positionMs)
    if (this.held?.entryId !== current.id) {
      // An entry that was being heard keeps its place; a new one starts where the session put it.
      const positionMs = this.last?.entryId === current.id ? this.last.positionMs : snapshot.session.positionMs
      this.held = { entryId: current.id, positionMs }
    }
    return this.held.positionMs
  }

  /** Seeks now, or once the current song has been fetched. */
  seek(positionMs: number): void {
    const current = this.client.getSnapshot().session.current
    if (current?.state === 'preparing') {
      this.pendingSeek = { entryId: current.id, positionMs }
      return
    }
    this.pendingSeek = null
    this.client.dispatch({ type: 'seek', positionMs })
  }

  /** Call after each session change: sends a kept seek once its song is ready, and forgets it when the song changed. */
  update(): void {
    const current = this.client.getSnapshot().session.current
    const pending = this.pendingSeek
    if (this.held && this.held.entryId !== current?.id) this.held = null
    if (!pending) return
    if (pending.entryId !== current?.id || current.state === 'failed') {
      this.pendingSeek = null
      return
    }
    if (current.state !== 'ready') return
    this.pendingSeek = null
    this.client.dispatch({ type: 'seek', positionMs: pending.positionMs })
  }

  private read(entryId: string, positionMs = this.client.getPositionMs()): number {
    this.held = null
    this.last = { entryId, positionMs }
    return positionMs
  }
}
