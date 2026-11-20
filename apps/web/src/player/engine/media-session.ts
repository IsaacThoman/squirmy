import { ART_SIZES, type ArtSize } from '@squirmy/contracts'

/** Session commands the system controls map to. The adapter never touches the engine. */
export type MediaSessionCommands = {
  play: () => void
  pause: () => void
  next: () => void
  previous: () => void
  seek: (positionMs: number) => void
}

export type MediaSessionTrack = { title: string; artist: string; album: string; artwork: MediaImage[] }

export type MediaSessionSnapshot = {
  track: MediaSessionTrack | null
  playing: boolean
  positionMs: number
  durationMs: number
}

const SEEK_STEP_SECONDS = 10

/** One artwork entry per served rendition, so the system picks the size it shows. */
export function mediaArtwork(url: (size: ArtSize) => string): MediaImage[] {
  return ART_SIZES.map(size => ({ src: url(size), sizes: `${size}x${size}`, type: 'image/webp' }))
}

/** The Media Session position state in seconds, or null while the duration is unknown. */
export function positionState(positionMs: number, durationMs: number): MediaPositionState | null {
  if (!(durationMs > 0)) return null
  return { duration: durationMs / 1000, position: Math.min(Math.max(positionMs, 0), durationMs) / 1000, playbackRate: 1 }
}

/** Where playback is `elapsedMs` after `snapshot` was taken. */
export function estimatePosition(snapshot: MediaSessionSnapshot, elapsedMs: number): number {
  return snapshot.playing ? Math.min(snapshot.positionMs + elapsedMs, snapshot.durationMs) : snapshot.positionMs
}

/**
 * Mirrors playback on the system's media controls (lock screen, keyboard media keys,
 * headset buttons) and turns their actions into `commands`. Call `update` whenever the
 * track, play state or position changes; `dispose` clears everything it set.
 */
export class MediaSessionAdapter {
  private snapshot: MediaSessionSnapshot | null = null
  private snapshotAt = 0
  private shownTrack: MediaSessionTrack | null = null
  private readonly actions: [MediaSessionAction, MediaSessionActionHandler][]
  private readonly session: MediaSession | undefined

  constructor(commands: MediaSessionCommands, session: MediaSession | undefined = globalThis.navigator?.mediaSession) {
    this.session = session
    const seekBy = (seconds: number) => commands.seek(Math.max(0, this.position() + seconds * 1000))
    this.actions = [
      ['play', () => commands.play()],
      ['pause', () => commands.pause()],
      ['nexttrack', () => commands.next()],
      ['previoustrack', () => commands.previous()],
      ['seekto', details => { if (details.seekTime !== undefined) commands.seek(details.seekTime * 1000) }],
      ['seekbackward', details => seekBy(-(details.seekOffset ?? SEEK_STEP_SECONDS))],
      ['seekforward', details => seekBy(details.seekOffset ?? SEEK_STEP_SECONDS)],
    ]
    for (const [action, handler] of this.actions) this.setHandler(action, handler)
  }

  update(snapshot: MediaSessionSnapshot): void {
    this.snapshot = snapshot
    this.snapshotAt = performance.now()
    const session = this.session
    if (!session) return
    if (snapshot.track !== this.shownTrack) {
      this.shownTrack = snapshot.track
      session.metadata = snapshot.track ? new MediaMetadata(snapshot.track) : null
    }
    session.playbackState = snapshot.track ? (snapshot.playing ? 'playing' : 'paused') : 'none'
    const state = positionState(snapshot.positionMs, snapshot.durationMs)
    try {
      session.setPositionState?.(state ?? undefined)
    } catch {
      // Older engines reject some position states; the controls still work without one.
    }
  }

  dispose(): void {
    for (const [action] of this.actions) this.setHandler(action, null)
    if (!this.session) return
    this.session.metadata = null
    this.session.playbackState = 'none'
  }

  private position(): number {
    return this.snapshot ? estimatePosition(this.snapshot, performance.now() - this.snapshotAt) : 0
  }

  private setHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    try {
      this.session?.setActionHandler(action, handler)
    } catch {
      // Browsers throw for actions they do not support.
    }
  }
}
