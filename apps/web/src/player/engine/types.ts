import type { PlayerEngine } from '@squirmy/client-core'
import type { PlaybackQuery } from '@squirmy/contracts'
import type { EqGains } from './equalizer'

/** What the page needs of its audio engine on top of the client-core contract. */
export interface BrowserEngine extends PlayerEngine {
  /**
   * A true-peak limiter ends the audio graph (an AudioWorklet, which needs a secure context),
   * so normalization is not held back to a song's peak (`SessionPlayer.limiter`).
   */
  readonly limiter: boolean
  /** Normalization may boost above unity: only with the limiter, which keeps the boost from clipping. */
  readonly canBoost: boolean
  /** The part of `GET /tracks/:id/playback`'s query that makes the server pick streams this engine plays. */
  playbackQuery(): Pick<PlaybackQuery, 'codecs' | 'containers' | 'engine'>
  /** The browser refused to start audio; `unlock()` from a click or key press fixes it. */
  isBlocked(): boolean
  /** Call from a user gesture: resumes the output and starts a play the browser held back. */
  unlock(): void
  /** Call from a user gesture: opens the output before the first play. */
  warm(): void
  /** This browser's equalizer bands in dB (see `EQ_BANDS`); null or all zero plays without it. */
  setEqualizer(gains: EqGains | null): void
  /** Plays through the output device `sinkId` ('' for the system's default). Rejects when the device is gone or not allowed. */
  setOutputDevice(sinkId: string): Promise<void>
  /** Stops playback and releases the elements and the audio context. */
  dispose(): void
}
