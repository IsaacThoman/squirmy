import type { PlayerEngine } from '@squirmy/client-core'
import type { PlaybackQuery } from '@squirmy/contracts'

/** What the page needs of its audio engine on top of the client-core contract. */
export interface BrowserEngine extends PlayerEngine {
  /** Normalization may boost above unity: the output runs through a `GainNode`. */
  readonly canBoost: boolean
  /** The part of `GET /tracks/:id/playback`'s query that makes the server pick streams this engine plays. */
  playbackQuery(): Pick<PlaybackQuery, 'codecs' | 'containers' | 'engine'>
  /** The browser refused to start audio; `unlock()` from a click or key press fixes it. */
  isBlocked(): boolean
  /** Call from a user gesture: resumes the output and starts a play the browser held back. */
  unlock(): void
  /** Call from a user gesture: opens the output before the first play. */
  warm(): void
  /** Stops playback and releases the elements and the audio context. */
  dispose(): void
}
