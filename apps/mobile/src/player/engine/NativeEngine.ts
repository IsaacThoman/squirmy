import type { EngineEvent, EngineLoad, EnginePreload, EngineStatus, PlayerEngine } from '@squirmy/client-core';
import type { NativeItem, SquirmyAudio } from '../../../modules/audio-engine';
import { playbackErrorMessage } from './state';

export type NativeEngineOptions = {
  native: SquirmyAudio;
  /**
   * The system paused playback (a call, Siri, another app, unplugged headphones). The engine
   * reports `paused`; the caller dispatches a session `pause`.
   */
  onInterrupted?: (entryId: string) => void;
  /** An interruption of `entryId` ended and iOS says to carry on; the caller dispatches `play`. */
  onResumed?: (entryId: string) => void;
  log?: (message: string) => void;
};

/**
 * `PlayerEngine` on the native engine (`modules/audio-engine`), which decodes the streams
 * itself and plays them on one sample clock, so consecutive tracks are gapless. Everything
 * that times audio is native: the preload starts where the loaded entry ends and `ended` is
 * emitted from the feed loop, and the audio session's interruptions and route changes are
 * handled there too and arrive here only as what to tell the session.
 *
 * Gain is linear and may boost: a true-peak limiter at the end of the engine's chain keeps
 * what it turns up under -1 dBTP, so normalization is not held back to a song's peak.
 */
export class NativeEngine implements PlayerEngine {
  readonly canBoost = true;
  readonly limiter = true;
  private readonly native: SquirmyAudio;
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly subscriptions: { remove(): void }[];

  constructor(private readonly options: NativeEngineOptions) {
    this.native = options.native;
    this.subscriptions = [
      // Each one as it happened, so the client sees every state, but none for an entry that is
      // no longer loaded: it crossed a newer `load` on its way here.
      this.native.addListener('status', ({ entryId, state, positionMs }) => {
        if (entryId === this.native.getStatus().entryId) this.emit({ type: 'status', status: { entryId, state, positionMs } });
      }),
      this.native.addListener('ended', ({ entryId }) => this.emit({ type: 'ended', entryId })),
      this.native.addListener('error', ({ entryId, message }) => this.emit({ type: 'error', entryId, message: playbackErrorMessage(message) })),
      this.native.addListener('interrupted', ({ entryId }) => options.onInterrupted?.(entryId)),
      this.native.addListener('resumed', ({ entryId }) => options.onResumed?.(entryId)),
      this.native.addListener('log', ({ message }) => options.log?.(message)),
    ];
  }

  load(request: EngineLoad): void {
    this.native.load({ ...item(request), startMs: Math.max(0, request.startMs), autoplay: request.autoplay });
    // At once, as the contract has it: the client follows `loading` to know when to look again.
    this.emit({ type: 'status', status: this.getStatus() });
  }

  preload(request: EnginePreload | null): void {
    this.native.preload(request && item({ ...request, startMs: 0 }));
  }

  play(): void {
    this.native.play();
  }

  pause(): void {
    this.native.pause();
  }

  seek(positionMs: number): void {
    this.native.seek(positionMs);
  }

  setGain(gain: number): void {
    this.native.setGain(Number.isFinite(gain) ? Math.max(0, gain) : 1);
  }

  stop(): void {
    this.native.stop();
  }

  getStatus(): EngineStatus {
    const { entryId, state, positionMs } = this.native.getStatus();
    return { entryId, state, positionMs };
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * While `hold` and nothing is loaded, the engine plays silence: iOS suspends a backgrounded
   * app that plays nothing, so without it the app would be asleep by the time a track it
   * waits for (one the server is still fetching) can play.
   */
  holdAudioSession(hold: boolean): void {
    this.native.holdAudioSession(hold);
  }

  /** It was told to play an entry that makes no sound yet: loading, or buffering mid-song. */
  isTryingToPlay(): boolean {
    const { playing, state } = this.native.getStatus();
    return playing && (state === 'loading' || state === 'buffering');
  }

  /** Stops listening to the native engine, which carries on as the process's one engine. */
  dispose(): void {
    for (const subscription of this.subscriptions) subscription.remove();
    this.listeners.clear();
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function item(request: Omit<EngineLoad, 'autoplay'>): NativeItem {
  return {
    entryId: request.entryId,
    url: request.url,
    startMs: request.startMs,
    gain: Number.isFinite(request.gain) ? Math.max(0, request.gain) : 1,
    cacheKey: null,
    gapless: request.media?.gapless ?? null,
    // Every server transcode goes through the stream decoder and every original through the
    // file reader, so a format never alternates between two decoders.
    decoder: request.media?.transcoded ? 'stream' : 'file',
    albumRun: false,
  };
}
