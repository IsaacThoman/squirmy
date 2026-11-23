import type {
  EngineEvent, EngineLoad, EnginePreload, EngineState, EngineStatus, PlayerEngine,
} from '@squirmy/client-core';
import { engineState, playbackErrorMessage, stillClockMs } from './state';

/** The part of an `expo-audio` `AudioPlayer` the engine uses. Times are seconds. */
export type NativePlayer = {
  readonly playing: boolean;
  readonly isLoaded: boolean;
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

/** A player that starts over at its end. */
export type LoopingPlayer = Pick<NativePlayer, 'play' | 'pause' | 'remove' | 'release'> & { loop: boolean };

export type ExpoAudioEngineOptions = {
  /** Creates a paused player that starts buffering `url`. */
  createPlayer: (url: string) => NativePlayer;
  /**
   * Creates a player for a short silent clip, looped while the engine holds the audio
   * session (`holdAudioSession`).
   */
  createSilence?: () => LoopingPlayer;
  /**
   * The system paused playback (an incoming call, Siri, unplugged headphones). The engine
   * reports `paused`; the caller dispatches a session `pause`.
   */
  onInterrupted?: (entryId: string) => void;
  /** An interruption of `entryId` ended and iOS says to carry on; the caller dispatches `play`. */
  onResumed?: (entryId: string) => void;
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
  /** The player's position when last read, and when it was last seen to change. */
  lastTime: number;
  movedAt: number;
};

/**
 * `PlayerEngine` on `expo-audio`: one `AudioPlayer` for the loaded entry and a second,
 * already buffering, for the preloaded one. At a natural end the second starts at once and
 * becomes the loaded entry before `ended` is emitted.
 *
 * Gain is the player's volume, so it can only attenuate (`canBoost: false`). The engine
 * never resumes on its own: `expo-audio` resumes players after an interruption ends, so a
 * player the system paused is muted until the engine is told to play again, and paused
 * if it starts anyway. The audio session's events say what the system did:
 * `interrupt`/`endInterruption` for a call or Siri, `routeLost` for unplugged headphones.
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
  /** The entry an interruption paused, to resume when it ends. */
  private interruptedEntryId: string | null = null;
  private holding = false;
  private silence: LoopingPlayer | null = null;
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly options: ExpoAudioEngineOptions) {
    this.now = options.now ?? Date.now;
  }

  load(request: EngineLoad): void {
    // Stopped now, but released only after `setState` has started the silence (`syncSilence`).
    const previous = this.current;
    previous?.player.pause();
    this.current = null;
    this.interruptedEntryId = null;
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
    this.release(previous);
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
    this.interruptedEntryId = null;
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
    this.interruptedEntryId = null;
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
    this.interruptedEntryId = null;
    this.setState('idle', true);
  }

  /** iOS paused the audio for a call, Siri or another app. */
  interrupt(): void {
    const slot = this.current;
    if (!slot || !this.wantsPlay) return;
    this.interruptedEntryId = slot.entryId;
    this.systemPause(slot);
  }

  /** The interruption is over; `shouldResume` is iOS saying playback should carry on, as after a call. */
  endInterruption(shouldResume: boolean): void {
    const entryId = this.interruptedEntryId;
    this.interruptedEntryId = null;
    if (entryId && shouldResume && this.current?.entryId === entryId) this.options.onResumed?.(entryId);
  }

  /** The output went away (headphones unplugged): paused for good, as in every iOS player. */
  routeLost(): void {
    this.interruptedEntryId = null;
    if (this.current && this.wantsPlay) this.systemPause(this.current);
  }

  /**
   * While `hold` and nothing is loaded, loops silence. iOS suspends a backgrounded app that
   * plays nothing, so without it the app would be asleep by the time a track it waits for
   * (one the server is still fetching) can play.
   */
  holdAudioSession(hold: boolean): void {
    this.holding = hold;
    this.syncSilence();
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
      entryId, url, gain, player, startMs: 0, seeking: false, ready: false, started: false, finished: false, failed: false, lastTime: 0, movedAt: -Infinity,
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
    const now = this.now();
    if (player.currentTime !== slot.lastTime) {
      slot.lastTime = player.currentTime;
      slot.movedAt = now;
    }
    // A player that says it plays while its clock has stood still since play() is waiting for
    // data, not playing: reported as playing, its position would pin the session at 0:00 with
    // the pause button up and no sign of loading.
    const playing = player.playing && now - Math.max(slot.movedAt, this.playCalledAt) < stillClockMs;
    if (playing) slot.started = true;
    this.setState(engineState({
      failed: slot.failed,
      finished: slot.finished,
      ready: slot.ready,
      wantsPlay: this.wantsPlay,
      started: slot.started,
      sincePlay: now - this.playCalledAt,
      playing,
    }));
  }

  private systemPause(slot: Slot): void {
    this.wantsPlay = false;
    // `expo-audio` resumes interrupted players by itself; keep that silent until asked.
    slot.player.muted = true;
    slot.player.pause();
    this.update();
    this.options.onInterrupted?.(slot.entryId);
  }

  /**
   * Loops silence while the engine should be making sound and nothing else does: while it
   * holds the session with nothing loaded, and while an entry it was told to play is still
   * loading. iOS suspends a backgrounded app that plays nothing, and a song chosen on another
   * device is not the preload, so it starts from nothing: the old player stops at once and
   * the new one plays only once its stream has loaded, which over a network takes a moment.
   * `expo-audio` also deactivates the audio session as soon as no player that keeps it
   * active is playing (a player counts only from its first `play()`). Suspended in between, the app
   * could neither start the new song nor answer the server's heartbeat, so the server would
   * give up on the phone and pause everyone's session. The silence starts before the old
   * player is released, so the session never goes idle.
   */
  private syncSilence(): void {
    const loading = this.current !== null && this.wantsPlay && this.state === 'loading';
    const wanted = loading || (this.holding && !this.current);
    if (wanted && !this.silence && this.options.createSilence) {
      this.silence = this.options.createSilence();
      this.silence.loop = true;
      this.silence.play();
    } else if (!wanted && this.silence) {
      this.silence.pause();
      this.silence.remove();
      this.silence.release();
      this.silence = null;
    }
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
    this.syncSilence();
    this.emit({ type: 'ended', entryId: slot.entryId });
    this.emit({ type: 'status', status: this.getStatus() });
    this.schedulePoll();
  }

  private fail(slot: Slot, message: string): void {
    slot.failed = true;
    this.wantsPlay = false;
    slot.player.pause();
    this.state = 'error';
    this.syncSilence();
    this.emit({ type: 'error', entryId: slot.entryId, message: playbackErrorMessage(message) });
    this.emit({ type: 'status', status: this.getStatus() });
    this.schedulePoll();
  }

  private setState(state: EngineState, always = false): void {
    const changed = state !== this.state || always;
    this.state = state;
    // Also when the state stays: a pause while loading keeps `loading` but needs no silence.
    this.syncSilence();
    if (changed) this.emit({ type: 'status', status: this.getStatus() });
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
