import type { EngineEvent } from '@squirmy/client-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpoAudioEngine, type NativePlayer, type NativeStatus } from './ExpoAudioEngine';

/** Stands in for an `expo-audio` player; the test decides when it loads, ends or fails. */
class FakePlayer implements NativePlayer {
  playing = false;
  isLoaded = false;
  isBuffering = false;
  currentTime = 0;
  duration = 0;
  volume = 1;
  muted = false;
  released = false;
  readonly calls: string[] = [];
  readonly seeks: { seconds: number; land: () => void }[] = [];
  private listener?: (status: NativeStatus) => void;

  constructor(readonly url: string) {}

  play() {
    this.calls.push('play');
    if (this.isLoaded) this.playing = true;
  }
  pause() {
    this.calls.push('pause');
    this.playing = false;
  }
  seekTo(seconds: number, before?: number, after?: number) {
    this.calls.push(`seek ${seconds} ${before} ${after}`);
    return new Promise<void>(resolve => this.seeks.push({ seconds, land: () => {
      this.currentTime = seconds;
      resolve();
    } }));
  }
  remove() {
    this.calls.push('remove');
  }
  release() {
    this.released = true;
  }
  addListener(_event: 'playbackStatusUpdate', listener: (status: NativeStatus) => void) {
    this.listener = listener;
    return { remove: () => { this.listener = undefined; } };
  }

  load(duration = 180) {
    this.isLoaded = true;
    this.duration = duration;
    this.emit({ didJustFinish: false });
  }
  end() {
    this.playing = false;
    this.currentTime = this.duration;
    this.emit({ didJustFinish: true });
  }
  fail(error: string) {
    this.emit({ didJustFinish: false, error });
  }
  emit(status: NativeStatus) {
    this.listener?.(status);
  }
}

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

let players: FakePlayer[];
let events: EngineEvent[];
let interrupted: string[];
let resumed: string[];
let silences: FakeSilence[];
let engine: ExpoAudioEngine;

class FakeSilence {
  loop = false;
  playing = false;
  released = false;
  play() { this.playing = true; }
  pause() { this.playing = false; }
  remove() {}
  release() { this.released = true; }
}

beforeEach(() => {
  vi.useFakeTimers();
  players = [];
  events = [];
  interrupted = [];
  resumed = [];
  silences = [];
  engine = new ExpoAudioEngine({
    createSilence: () => {
      const silence = new FakeSilence();
      silences.push(silence);
      return silence;
    },
    onResumed: entryId => resumed.push(entryId),
    createPlayer: url => {
      const player = new FakePlayer(url);
      players.push(player);
      return player;
    },
    onInterrupted: entryId => interrupted.push(entryId),
  });
  engine.subscribe(event => events.push(event));
});

afterEach(() => {
  engine.stop();
  vi.useRealTimers();
});

const states = () => events.flatMap(event => event.type === 'status' ? [`${event.status.entryId}:${event.status.state}`] : []);

describe('ExpoAudioEngine', () => {
  it('loads and autoplays', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 0.5 });
    expect(engine.getStatus()).toEqual({ entryId: 'a', state: 'loading', positionMs: 0 });
    players[0].load();
    expect(players[0].volume).toBe(0.5);
    expect(players[0].calls).toContain('play');
    expect(states()).toEqual(['a:loading', 'a:playing']);
  });

  it('loads paused at the start position, exactly', async () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 42_000, autoplay: false, gain: 1 });
    players[0].load();
    expect(players[0].calls).toEqual(['seek 42 0 0']);
    expect(engine.getStatus()).toEqual({ entryId: 'a', state: 'loading', positionMs: 42_000 });
    players[0].seeks[0].land();
    await settle();
    expect(engine.getStatus()).toEqual({ entryId: 'a', state: 'paused', positionMs: 42_000 });
    expect(players[0].calls).not.toContain('play');
    engine.play();
    expect(engine.getStatus().state).toBe('playing');
  });

  it('starts the preload before emitting ended, then reports the new entry', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    engine.preload({ entryId: 'b', url: 'https://x/b', gain: 0.25 });
    players[1].load();
    expect(players[1].calls).toEqual([]);

    const seen: unknown[] = [];
    engine.subscribe(event => {
      if (event.type === 'ended') seen.push({ ...engine.getStatus(), nextPlaying: players[1].playing });
    });
    events = [];
    players[0].end();

    expect(seen).toEqual([{ entryId: 'b', state: 'playing', positionMs: 0, nextPlaying: true }]);
    expect(events.map(event => event.type === 'status' ? `status ${event.status.entryId}` : `${event.type} ${event.entryId}`))
      .toEqual(['ended a', 'status b']);
    expect(players[1].volume).toBe(0.25);
    expect(players[0].released).toBe(true);

    // The preload slot is empty: the next end stays on the finished entry.
    events = [];
    players[1].end();
    expect(engine.getStatus()).toEqual({ entryId: 'b', state: 'ended', positionMs: 180_000 });
    expect(events.map(event => event.type)).toEqual(['ended', 'status']);
  });

  it('starts a preload that is still loading as soon as it loads', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    engine.preload({ entryId: 'b', url: 'https://x/b', gain: 1 });
    players[0].end();
    expect(engine.getStatus()).toMatchObject({ entryId: 'b', state: 'loading' });
    players[1].load();
    expect(engine.getStatus()).toMatchObject({ entryId: 'b', state: 'playing' });
  });

  it('seeks from ended to paused, and emits status when the seek lands', async () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load(200);
    players[0].end();
    expect(engine.getStatus().state).toBe('ended');
    engine.seek(500_000);
    expect(engine.getStatus()).toEqual({ entryId: 'a', state: 'paused', positionMs: 200_000 });
    events = [];
    players[0].seeks.at(-1)!.land();
    await settle();
    expect(events).toEqual([{ type: 'status', status: { entryId: 'a', state: 'paused', positionMs: 200_000 } }]);
  });

  it('pauses for an interruption, stays silent while expo-audio resumes, and asks to resume when iOS says so', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    vi.advanceTimersByTime(2000);
    engine.interrupt(); // an incoming call
    expect(engine.getStatus().state).toBe('paused');
    expect(interrupted).toEqual(['a']);
    expect(players[0].muted).toBe(true);

    players[0].playing = true; // expo-audio resuming after the call
    vi.advanceTimersByTime(500);
    players[0].emit({ didJustFinish: false });
    expect(players[0].playing).toBe(false);
    expect(engine.getStatus().state).toBe('paused');

    engine.endInterruption(true);
    expect(resumed).toEqual(['a']);
    engine.play();
    expect(players[0].muted).toBe(false);
    expect(engine.getStatus().state).toBe('playing');
  });

  it('does not resume after an interruption iOS says to stay paused after, or one that came while paused', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    engine.interrupt();
    engine.endInterruption(false);
    engine.pause();
    engine.interrupt();
    engine.endInterruption(true);
    expect(interrupted).toEqual(['a']);
    expect(resumed).toEqual([]);
  });

  it('pauses for good when the headphones are unplugged, even during an interruption', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    engine.routeLost();
    expect(engine.getStatus().state).toBe('paused');
    expect(interrupted).toEqual(['a']);
    engine.play();
    engine.interrupt();
    engine.routeLost();
    engine.endInterruption(true);
    expect(resumed).toEqual([]);
  });

  it('counts a player that stops by itself as stalled', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    vi.advanceTimersByTime(2000);
    players[0].playing = false;
    vi.advanceTimersByTime(500);
    expect(engine.getStatus().state).toBe('buffering');
    expect(interrupted).toEqual([]);
  });

  it('loops silence while holding the session with nothing loaded', () => {
    engine.holdAudioSession(true);
    expect(silences).toHaveLength(1);
    expect(silences[0]).toMatchObject({ loop: true, playing: true });
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    expect(silences[0].released).toBe(true);
    // The session client stops the engine when the next entry is still being fetched.
    engine.stop();
    expect(silences).toHaveLength(2);
    expect(silences[1].playing).toBe(true);
    engine.holdAudioSession(false);
    expect(silences[1].released).toBe(true);
    engine.stop();
    expect(silences).toHaveLength(2);
  });

  it('reports buffering while the player waits for data', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    vi.advanceTimersByTime(2000);
    players[0].playing = false;
    players[0].isBuffering = true;
    vi.advanceTimersByTime(500);
    expect(engine.getStatus().state).toBe('buffering');
    players[0].playing = true;
    players[0].isBuffering = false;
    vi.advanceTimersByTime(500);
    expect(states()).toEqual(['a:loading', 'a:playing', 'a:buffering', 'a:playing']);
    expect(interrupted).toEqual([]);
  });

  it('maps a failure to an error and stays there', () => {
    engine.load({ entryId: 'a', url: 'http://127.0.0.1:1/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].fail('The operation couldn’t be completed. (NSURLErrorDomain error -1004.)');
    expect(events.filter(event => event.type === 'error')).toEqual([
      { type: 'error', entryId: 'a', message: 'Couldn’t reach the server to play this track.' },
    ]);
    expect(engine.getStatus().state).toBe('error');
    engine.play();
    expect(engine.getStatus().state).toBe('error');
  });

  it('drops a preload that fails, silently', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    engine.preload({ entryId: 'b', url: 'https://x/missing', gain: 1 });
    events = [];
    players[1].fail('Cannot Open');
    expect(events).toEqual([]);
    expect(players[1].released).toBe(true);
    players[0].end();
    expect(engine.getStatus()).toMatchObject({ entryId: 'a', state: 'ended' });
  });

  it('reuses the preloaded player when loading that entry, and keeps the preload otherwise', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    engine.preload({ entryId: 'b', url: 'https://x/b', gain: 1 });
    engine.load({ entryId: 'c', url: 'https://x/c', startMs: 0, autoplay: true, gain: 1 });
    expect(players.map(player => player.released)).toEqual([true, false, false]);
    engine.load({ entryId: 'b', url: 'https://x/b', startMs: 0, autoplay: true, gain: 1 });
    expect(players).toHaveLength(3);
    expect(events.some(event => event.type === 'ended')).toBe(false);
  });

  it('attenuates only', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: false, gain: 2 });
    expect(players[0].volume).toBe(1);
    engine.setGain(0.3);
    expect(players[0].volume).toBe(0.3);
  });

  it('pauses and stops', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    engine.pause();
    expect(engine.getStatus().state).toBe('paused');
    engine.preload({ entryId: 'b', url: 'https://x/b', gain: 1 });
    events = [];
    engine.stop();
    expect(events).toEqual([{ type: 'status', status: { entryId: null, state: 'idle', positionMs: 0 } }]);
    expect(players.every(player => player.released)).toBe(true);
  });
});
