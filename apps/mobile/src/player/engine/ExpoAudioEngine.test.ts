import type { EngineEvent } from '@squirmy/client-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpoAudioEngine, type NativePlayer, type NativeStatus } from './ExpoAudioEngine';

/** Stands in for an `expo-audio` player; the test decides when it loads, ends or fails. */
class FakePlayer implements NativePlayer {
  isLoaded = false;
  isBuffering = false;
  /** Says it plays, but its clock stands still: a stream that has not started to arrive. */
  frozen = false;
  /** Ignores play(), as AVPlayer waiting to play at the asked rate does. */
  refusePlay = false;
  duration = 0;
  volume = 1;
  muted = false;
  released = false;
  readonly calls: string[] = [];
  readonly seeks: { seconds: number; land: () => void }[] = [];
  private listener?: (status: NativeStatus) => void;

  // The clock runs on the (fake) time while playing, as AVPlayer's does.
  private playingNow = false;
  private time = 0;
  private since = 0;

  constructor(readonly url: string) {}

  get playing() {
    return this.playingNow;
  }
  set playing(playing: boolean) {
    this.time = this.currentTime;
    this.since = Date.now();
    this.playingNow = playing;
  }
  get currentTime() {
    return this.time + (this.playingNow && !this.frozen ? (Date.now() - this.since) / 1000 : 0);
  }
  set currentTime(seconds: number) {
    this.time = seconds;
    this.since = Date.now();
  }

  play() {
    this.calls.push('play');
    timeline.push(`play ${this.url}`);
    if (this.isLoaded && !this.refusePlay) this.playing = true;
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
    timeline.push(`remove ${this.url}`);
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
/** What the players and the silence did, in order across all of them. */
let timeline: string[];
let engine: ExpoAudioEngine;

class FakeSilence {
  loop = false;
  playing = false;
  released = false;
  play() {
    this.playing = true;
    timeline.push('silence play');
  }
  pause() { this.playing = false; }
  remove() {
    timeline.push('silence remove');
  }
  release() { this.released = true; }
}

beforeEach(() => {
  vi.useFakeTimers();
  players = [];
  events = [];
  interrupted = [];
  resumed = [];
  silences = [];
  timeline = [];
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
    // The fetched entry loads: the same silence carries on until it plays.
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    expect(silences).toHaveLength(1);
    expect(silences[0].playing).toBe(true);
    players[0].load();
    vi.advanceTimersByTime(2000);
    expect(engine.getStatus().state).toBe('playing');
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

  it('keeps the audio going across a song chosen elsewhere: silence starts before the old player goes, and stops once the new one plays', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    vi.advanceTimersByTime(2000);
    expect(engine.getStatus().state).toBe('playing');
    // The first song had its silence too, until it played.
    expect(silences).toHaveLength(1);
    expect(silences[0].released).toBe(true);
    timeline = [];

    engine.load({ entryId: 'b', url: 'https://x/b', startMs: 0, autoplay: true, gain: 1 });
    expect(players[0].playing).toBe(false);
    expect(players[0].released).toBe(true);
    expect(timeline).toEqual(['silence play', 'remove https://x/a']);
    expect(engine.getStatus()).toMatchObject({ entryId: 'b', state: 'loading' });

    // Songs picked one after another while loading keep the one silence.
    engine.load({ entryId: 'c', url: 'https://x/c', startMs: 0, autoplay: true, gain: 1 });
    expect(silences).toHaveLength(2);
    expect(silences[1].playing).toBe(true);

    // The silence goes only once the new player plays, which keeps the session from then on.
    players[2].load();
    expect(engine.getStatus()).toMatchObject({ entryId: 'c', state: 'playing' });
    expect(silences[1].released).toBe(true);
    expect(timeline).toEqual(['silence play', 'remove https://x/a', 'remove https://x/b', 'play https://x/c', 'silence remove']);
  });

  it('plays no silence for a load that is not to play, and stops it for a pause or a failure while loading', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: false, gain: 1 });
    expect(silences).toHaveLength(0);

    engine.load({ entryId: 'b', url: 'https://x/b', startMs: 0, autoplay: true, gain: 1 });
    expect(silences[0].playing).toBe(true);
    engine.pause();
    expect(silences[0].released).toBe(true);

    engine.load({ entryId: 'c', url: 'https://x/c', startMs: 0, autoplay: true, gain: 1 });
    expect(silences[1].playing).toBe(true);
    players[2].fail('The operation couldn’t be completed. (NSURLErrorDomain error -1004.)');
    expect(engine.getStatus().state).toBe('error');
    expect(silences[1].released).toBe(true);
  });

  it('plays silence while a preload that has not loaded takes over at the end of a song', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    engine.preload({ entryId: 'b', url: 'https://x/b', gain: 1 });
    vi.advanceTimersByTime(2000);
    players[0].end();
    expect(engine.getStatus()).toMatchObject({ entryId: 'b', state: 'loading' });
    expect(silences).toHaveLength(2);
    expect(silences[1].playing).toBe(true);
    players[1].load();
    vi.advanceTimersByTime(2000);
    expect(engine.getStatus().state).toBe('playing');
    expect(silences[1].released).toBe(true);
  });

  it('asks a player whose play() did not take again every few seconds, without reporting it as playing', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].refusePlay = true;
    players[0].load();
    expect(players[0].calls.filter(call => call === 'play')).toHaveLength(1);
    vi.advanceTimersByTime(2500);
    expect(players[0].calls.filter(call => call === 'play')).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(players[0].calls.filter(call => call === 'play')).toHaveLength(2);
    expect(engine.getStatus().state).toBe('loading');
    // Its play() was asked for: the silence is gone, and stays gone.
    expect(silences).toHaveLength(1);
    expect(silences[0].released).toBe(true);
    players[0].refusePlay = false;
    vi.advanceTimersByTime(3000);
    expect(engine.getStatus().state).toBe('playing');
    expect(silences).toHaveLength(1);
    expect(states()).toEqual(['a:loading', 'a:playing']);
  });

  it('asks again mid-song when the player stopped by itself and does not resume', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].load();
    vi.advanceTimersByTime(5000);
    players[0].refusePlay = true;
    players[0].playing = false;
    // The last play() was long ago, so it is asked at once, then every 3 s.
    vi.advanceTimersByTime(1000);
    expect(engine.getStatus().state).toBe('buffering');
    expect(players[0].calls.filter(call => call === 'play')).toHaveLength(2);
    vi.advanceTimersByTime(3000);
    expect(players[0].calls.filter(call => call === 'play')).toHaveLength(3);
    expect(engine.getStatus().state).toBe('buffering');
    // Paused on purpose, nothing is asked again.
    engine.pause();
    vi.advanceTimersByTime(10_000);
    expect(players[0].calls.filter(call => call === 'play')).toHaveLength(3);
  });

  it('reloads the same entry with a new player for a recovery, keeping the silence until it plays', () => {
    engine.load({ entryId: 'a', url: 'https://x/a?1', startMs: 0, autoplay: true, gain: 1 });
    vi.advanceTimersByTime(6000);
    engine.load({ entryId: 'a', url: 'https://x/a?2', startMs: 0, autoplay: true, gain: 1 });
    expect(players).toHaveLength(2);
    expect(players[0].released).toBe(true);
    expect(silences).toHaveLength(1);
    expect(silences[0].playing).toBe(true);
    players[1].load();
    expect(engine.getStatus()).toMatchObject({ entryId: 'a', state: 'playing' });
    expect(silences[0].released).toBe(true);
  });

  it('stops the silence when the new player is asked to play, even while its clock has not moved (AirPlay)', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    expect(silences[0].playing).toBe(true);
    // Over AirPlay the player said it plays but waited for as long as the silence played.
    players[0].frozen = true;
    players[0].load();
    expect(players[0].playing).toBe(true);
    expect(silences[0].released).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(engine.getStatus().state).not.toBe('playing');
    expect(silences).toHaveLength(1);
    players[0].frozen = false;
    vi.advanceTimersByTime(1000);
    expect(engine.getStatus().state).toBe('playing');
  });

  it('ends the silence when the session gives up on a load and stops the engine', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    expect(silences[0].playing).toBe(true);
    engine.stop();
    expect(silences[0].released).toBe(true);
    expect(engine.getStatus().state).toBe('idle');
  });

  it('holds background running time while it should sound and does not yet, and gives it back', () => {
    const holds: boolean[] = [];
    const held = new ExpoAudioEngine({
      createPlayer: url => {
        const player = new FakePlayer(url);
        players.push(player);
        return player;
      },
      createSilence: () => new FakeSilence(),
      holdRunning: hold => holds.push(hold),
    });
    held.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    expect(holds).toEqual([true]);
    players.at(-1)!.load();
    expect(holds).toEqual([true, false]);
    vi.advanceTimersByTime(5000);
    players.at(-1)!.refusePlay = true;
    players.at(-1)!.playing = false;
    vi.advanceTimersByTime(1000);
    expect(held.getStatus().state).toBe('buffering');
    expect(holds).toEqual([true, false, true]);
    held.pause();
    expect(holds).toEqual([true, false, true, false]);
    held.load({ entryId: 'b', url: 'https://x/b', startMs: 0, autoplay: true, gain: 1 });
    held.stop();
    expect(holds).toEqual([true, false, true, false, true, false]);
  });

  it('logs state changes and the silence', () => {
    const lines: string[] = [];
    const logged = new ExpoAudioEngine({
      createPlayer: url => {
        const player = new FakePlayer(url);
        players.push(player);
        return player;
      },
      createSilence: () => new FakeSilence(),
      log: line => lines.push(line),
    });
    logged.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players.at(-1)!.load();
    expect(lines).toEqual(['a idle → loading at 0 ms', 'silence on', 'holding background time', 'silence off', 'a loading → playing at 0 ms', 'background time given back']);
    players.at(-1)!.emit({ didJustFinish: false, timeControlStatus: 'waitingToPlayAtSpecifiedRate', reasonForWaitingToPlay: 'evaluatingBufferingRate' });
    players.at(-1)!.emit({ didJustFinish: false, timeControlStatus: 'waitingToPlayAtSpecifiedRate', reasonForWaitingToPlay: 'evaluatingBufferingRate' });
    players.at(-1)!.emit({ didJustFinish: false, timeControlStatus: 'playing' });
    expect(lines.filter(line => line.includes('player'))).toEqual(['a player new → waiting (evaluatingBufferingRate)', 'a player waiting (evaluatingBufferingRate) → playing']);
    logged.stop();
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

  it('reports buffering while the player says it plays but its clock stands still', () => {
    engine.load({ entryId: 'a', url: 'https://x/a', startMs: 0, autoplay: true, gain: 1 });
    players[0].frozen = true;
    players[0].load();
    expect(engine.getStatus().state).toBe('playing');
    vi.advanceTimersByTime(2000);
    expect(engine.getStatus()).toEqual({ entryId: 'a', state: 'buffering', positionMs: 0 });
    players[0].frozen = false;
    players[0].currentTime = 0;
    vi.advanceTimersByTime(500);
    expect(engine.getStatus().state).toBe('playing');
    expect(states()).toEqual(['a:loading', 'a:playing', 'a:buffering', 'a:playing']);
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
