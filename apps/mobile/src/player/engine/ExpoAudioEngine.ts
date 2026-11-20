import type {
  EngineEvent, EngineLoad, EnginePreload, EngineState, EngineStatus, PlayerEngine,
} from '@squirmy/client-core';
import { engineState, playbackErrorMessage } from './state';

/** The part of an `expo-audio` `AudioPlayer` the engine uses. Times are seconds. */
export type NativePlayer = {
  readonly playing: boolean;
  readonly isLoaded: boolean;
  readonly isBuffering: boolean;
  readonly currentTime: number;
  readonly duration: number;
  volume: number;
  muted: boolean;
  play(): void;
  pause(): void;
  seekTo(seconds: number, toleranceMillisBefore?: number, toleranceMillisAfter?: number): Promise<void>;
  /** Unregisters the player from `expo-audio`. */
  remove(): void;
  /** Frees the native player now instead of at garbage collection. */
  release(): void;
  addListener(event: 'playbackStatusUpdate', listener: (status: NativeStatus) => void): { remove(): void };
};

export type NativeStatus = { didJustFinish: boolean; error?: string | null };

export type ExpoAudioEngineOptions = {
  /** Creates a paused player that starts buffering `url`. */
  createPlayer: (url: string) => NativePlayer;
  /**
   * The system paused playback (an incoming call, Siri, unplugged headphones). The engine
   * reports `paused` and stays paused; the caller dispatches a session `pause`.
   */
  onInterrupted?: (entryId: string) => void;
  now?: () => number;
  /** How often to look for stalls while playing, which no native event reports. */
  pollIntervalMs?: number;
};

type Slot = {
  entryId: string;
  url: string;
  gain: number;
  player: NativePlayer;
  subscription: { remove(): void };
  /** Where the entry starts, sought to once it has loaded. */
  startMs: number;
  /** `seekTo(startMs)` was issued. */
  seeking: boolean;
  ready: boolean;
  started: boolean;
  finished: boolean;
  failed: boolean;
};

/**
 * `PlayerEngine` on `expo-audio`: one `AudioPlayer` for the loaded entry and a second,
 * already buffering, for the preloaded one. At a natural end the second starts at once and
 * becomes the loaded entry before `ended` is emitted.
 *
 * Gain is the player's volume, so it can only attenuate (`canBoost: false`). The engine
 * never resumes on its own: `expo-audio` resumes players after an interruption ends, so a
 * player the system paused is muted until the engine is told to play again, and paused
 * if it starts anyway.
 */
export class ExpoAudioEngine implements PlayerEngine {
  private current: Slot | null = null;
  private next: Slot | null = null;
  private state: EngineState = 'idle';
  private wantsPlay = false;
  private playCalledAt = -Infinity;
  /** The position a seek in flight will land on, reported until it does. */
  private seekTarget: number | null = null;
  private seekSerial = 0;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly options: ExpoAudioEngineOptions) {
    this.now = options.now ?? Date.now;
  }

  load(request: EngineLoad): void {
    this.release(this.current);
    this.current = null;
    let slot: Slot;
    if (this.next && this.next.entryId === request.entryId && this.next.url === request.url) {
      slot = this.next;
      this.next = null;
    } else {
      slot = this.createSlot(request.entryId, request.url, request.gain);
    }
    slot.gain = request.gain;
    slot.startMs = Math.max(0, request.startMs);
    slot.player.volume = volumeFor(request.gain);
    this.current = slot;
    this.wantsPlay = request.autoplay;
    this.seekTarget = null;
    this.seekSerial += 1;
    this.setState('loading', true);
    this.update();
  }

  preload(request: EnginePreload | null): void {
    if (request && this.next?.entryId === request.entryId && this.next.url === request.url) {
      this.next.gain = request.gain;
      return;
    }
    this.release(this.next);
    this.next = request && this.createSlot(request.entryId, request.url, request.gain);
  }

  play(): void {
    const slot = this.current;
    if (!slot || slot.failed || this.state === 'loading' || this.state === 'playing') return;
    this.wantsPlay = true;
    if (slot.finished) {
      // Playing an entry that ended starts it over, as a player's play button does.
      slot.finished = false;
      this.seekTo(slot, 0);
    }
    if (slot.ready) this.start(slot);
    this.update();
  }

  pause(): void {
    const slot = this.current;
    if (!slot) return;
    this.wantsPlay = false;
    slot.finished = false;
    slot.player.pause();
    this.update();
  }

  seek(positionMs: number): void {
    const slot = this.current;
    if (!slot || slot.failed) return;
    const duration = slot.player.duration * 1000;
    const target = Math.max(0, duration > 0 ? Math.min(duration, positionMs) : positionMs);
    if (!slot.ready) {
      // Still loading: start there instead. The status that ends loading reports it.
      slot.startMs = target;
      if (slot.seeking) this.seekTo(slot, target, () => this.becomeReady(slot));
      return;
    }
    if (slot.finished) {
      slot.finished = false;
      this.wantsPlay = false;
    }
    this.seekTo(slot, target, () => {
      this.update();
      this.emit({ type: 'status', status: this.getStatus() });
    });
    this.update();
  }

  setGain(gain: number): void {
    if (!this.current) return;
    this.current.gain = gain;
    this.current.player.volume = volumeFor(gain);
  }

  stop(): void {
    this.release(this.current);
    this.release(this.next);
    this.current = null;
    this.next = null;
    this.wantsPlay = false;
    this.seekTarget = null;
    this.setState('idle', true);
  }

  getStatus(): EngineStatus {
    return { entryId: this.current?.entryId ?? null, state: this.state, positionMs: this.position() };
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private position(): number {
    const slot = this.current;
    if (!slot) return 0;
    if (this.seekTarget !== null) return this.seekTarget;
    if (!slot.ready) return slot.startMs;
    if (slot.finished) return slot.player.duration * 1000;
    return slot.player.currentTime * 1000;
  }

  private createSlot(entryId: string, url: string, gain: number): Slot {
    const player = this.options.createPlayer(url);
    const slot: Slot = {
      entryId, url, gain, player, startMs: 0, seeking: false, ready: false, started: false, finished: false, failed: false,
      subscription: { remove: () => undefined },
    };
    slot.subscription = player.addListener('playbackStatusUpdate', status => this.onNativeStatus(slot, status));
    return slot;
  }

  private release(slot: Slot | null): void {
    if (!slot) return;
    slot.subscription.remove();
    slot.player.pause();
    slot.player.remove();
    slot.player.release();
  }

  private onNativeStatus(slot: Slot, status: NativeStatus): void {
    if (slot === this.next) {
      // A preload that fails is dropped without a word; the entry loads normally later.
      if (status.error) {
        this.release(slot);
        this.next = null;
      }
      return;
    }
    if (slot !== this.current || slot.failed) return;
    if (status.error) return this.fail(slot, status.error);
    if (status.didJustFinish && slot.ready && !slot.finished) return this.finish(slot);
    this.update();
  }

  /** Re-reads the loaded player and moves the state along. */
  private update(): void {
    const slot = this.current;
    if (!slot) return this.setState('idle');
    const { player } = slot;
    if (!slot.ready && !slot.seeking && player.isLoaded) {
      slot.seeking = true;
      if (slot.startMs > 0) {
        this.seekTo(slot, slot.startMs, () => this.becomeReady(slot));
      } else {
        this.becomeReady(slot);
        return;
      }
    }
    if (!this.wantsPlay && player.playing) player.pause();
    if (player.playing) slot.started = true;
    const { state, interrupted } = engineState({
      failed: slot.failed,
      finished: slot.finished,
      ready: slot.ready,
      wantsPlay: this.wantsPlay,
      started: slot.started,
      sincePlay: this.now() - this.playCalledAt,
      playing: player.playing,
      waiting: player.isBuffering,
    });
    if (interrupted) {
      this.wantsPlay = false;
      // `expo-audio` resumes interrupted players by itself; keep that silent until asked.
      player.muted = true;
      player.pause();
    }
    this.setState(state);
    if (interrupted) this.options.onInterrupted?.(slot.entryId);
  }

  private becomeReady(slot: Slot): void {
    if (slot !== this.current) return;
    slot.ready = true;
    if (this.wantsPlay) this.start(slot);
    this.update();
  }

  private start(slot: Slot): void {
    slot.player.muted = false;
    slot.player.play();
    this.playCalledAt = this.now();
  }

  private seekTo(slot: Slot, positionMs: number, landed?: () => void): void {
    const serial = ++this.seekSerial;
    if (slot.ready) this.seekTarget = positionMs;
    slot.player.seekTo(positionMs / 1000, 0, 0).then(() => {
      if (serial !== this.seekSerial || slot !== this.current) return;
      this.seekTarget = null;
      landed?.();
    }, () => {
      if (serial === this.seekSerial) this.seekTarget = null;
    });
  }

  private finish(slot: Slot): void {
    const next = this.next;
    if (next) {
      // Start the preloaded entry first, so it is already the loaded one when `ended` goes out.
      this.next = null;
      this.current = next;
      this.release(slot);
      next.player.volume = volumeFor(next.gain);
      // A preload that has not loaded yet starts as soon as it does, like any load.
      next.ready = next.seeking = next.player.isLoaded;
      next.started = true;
      this.wantsPlay = true;
      this.seekSerial += 1;
      this.seekTarget = null;
      if (next.ready) this.start(next);
      this.state = next.ready ? 'playing' : 'loading';
    } else {
      slot.finished = true;
      this.wantsPlay = false;
      this.state = 'ended';
    }
    this.emit({ type: 'ended', entryId: slot.entryId });
    this.emit({ type: 'status', status: this.getStatus() });
    this.schedulePoll();
  }

  private fail(slot: Slot, message: string): void {
    slot.failed = true;
    this.wantsPlay = false;
    slot.player.pause();
    this.state = 'error';
    this.emit({ type: 'error', entryId: slot.entryId, message: playbackErrorMessage(message) });
    this.emit({ type: 'status', status: this.getStatus() });
    this.schedulePoll();
  }

  private setState(state: EngineState, always = false): void {
    if (state !== this.state || always) {
      this.state = state;
      this.emit({ type: 'status', status: this.getStatus() });
    }
    this.schedulePoll();
  }

  /** Polls while audio should be coming out: stalls and some interruptions send no event. */
  private schedulePoll(): void {
    const active = this.state === 'loading' || this.state === 'playing' || this.state === 'buffering';
    if (active && !this.poll) this.poll = setInterval(() => this.update(), this.options.pollIntervalMs ?? 500);
    if (!active && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** Player volume is attenuation only. */
function volumeFor(gain: number): number {
  return Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1;
}
