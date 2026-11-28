import type { EngineEvent, EngineState } from '@squirmy/client-core';
import { describe, expect, it, vi } from 'vitest';
import type { NativeEqualizer, NativeItem, NativeStatus, SquirmyAudio } from '../../../modules/audio-engine';
import { NativeEngine } from './NativeEngine';

type Listener = (payload: never) => void;

/**
 * Stands in for the native module, following the engine contract the Swift engine has its
 * own tests for: loads go `loading` then `playing` or `paused`, `finish` moves to the
 * preload before `ended`. Events go out asynchronously, as the native ones arrive.
 */
class FakeNative implements SquirmyAudio {
  readonly calls: [string, ...unknown[]][] = [];
  loaded: NativeItem | null = null;
  preloaded: NativeItem | null = null;
  status: NativeStatus = { entryId: null, state: 'idle', positionMs: 0, playing: false };
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly pending: (() => void)[] = [];

  load(item: NativeItem & { autoplay: boolean }) {
    this.calls.push(['load', item]);
    this.loaded = item;
    this.set({ entryId: item.entryId, state: 'loading', positionMs: item.startMs, playing: item.autoplay });
  }
  preload(item: NativeItem | null) {
    this.calls.push(['preload', item]);
    this.preloaded = item;
  }
  play() {
    this.calls.push(['play']);
    if (this.status.state === 'paused') this.set({ ...this.status, state: 'playing', playing: true });
  }
  pause() {
    this.calls.push(['pause']);
    if (this.status.entryId) this.set({ ...this.status, state: 'paused', playing: false });
  }
  seek(positionMs: number) {
    this.calls.push(['seek', positionMs]);
    this.set({ ...this.status, positionMs });
  }
  setGain(gain: number) {
    this.calls.push(['setGain', gain]);
  }
  stop() {
    this.calls.push(['stop']);
    this.loaded = this.preloaded = null;
    this.set({ entryId: null, state: 'idle', positionMs: 0, playing: false });
  }
  holdAudioSession(hold: boolean) {
    this.calls.push(['holdAudioSession', hold]);
  }
  setEqualizer(curve: NativeEqualizer | null) {
    this.calls.push(['setEqualizer', curve]);
  }
  getStatus() {
    return { ...this.status };
  }
  addListener(event: string, listener: Listener) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return { remove: () => set.delete(listener) };
  }

  /** The first frames are queued. */
  ready() {
    this.set({ ...this.status, state: this.status.playing ? 'playing' : 'paused' });
  }
  /** The loaded entry played to its end. */
  finish() {
    const finished = this.status.entryId!;
    if (this.preloaded) {
      this.loaded = this.preloaded;
      this.preloaded = null;
      this.status = { entryId: this.loaded.entryId, state: 'playing', positionMs: 0, playing: true };
    } else {
      this.status = { ...this.status, state: 'ended', playing: false };
    }
    this.send('ended', { entryId: finished });
    this.send('status', this.getStatus());
  }
  send(event: string, payload: unknown) {
    this.pending.push(() => this.listeners.get(event)?.forEach(listener => (listener as (payload: unknown) => void)(payload)));
  }
  /** Delivers what was sent, as the bridge does a moment later. */
  deliver() {
    while (this.pending.length) this.pending.shift()!();
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((count, set) => count + set.size, 0);
  }

  private set(status: NativeStatus) {
    this.status = status;
    this.send('status', this.getStatus());
  }
}

function setup() {
  const native = new FakeNative();
  const onInterrupted = vi.fn();
  const onResumed = vi.fn();
  const log = vi.fn();
  const engine = new NativeEngine({ native, onInterrupted, onResumed, log });
  const events: EngineEvent[] = [];
  engine.subscribe(event => events.push(event));
  const states = () => events.flatMap(event => event.type === 'status' ? [event.status.state] : []);
  return { native, engine, events, states, onInterrupted, onResumed, log };
}

const load = { entryId: 'a', url: 'https://music.test/stream/a', startMs: 0, autoplay: true, gain: 1 };

describe('NativeEngine', () => {
  it('hands the equalizer to the native engine, which an older build may not have', () => {
    const { native, engine } = setup();
    expect(engine.equalizer).toBe(true);
    engine.setEqualizer({ bandsDb: [6, 0, 0, 0, 0, 0, 0, 0, 0, 0], preampDb: -6 });
    engine.setEqualizer(null);
    expect(native.calls).toEqual([['setEqualizer', { bandsDb: [6, 0, 0, 0, 0, 0, 0, 0, 0, 0], preampDb: -6 }], ['setEqualizer', null]]);
    const older = new NativeEngine({ native: { ...native, setEqualizer: undefined, addListener: native.addListener.bind(native) } as never });
    expect(older.equalizer).toBe(false);
    older.setEqualizer(null);
  });

  it('loads originals through the file reader and transcodes through the stream decoder', () => {
    const { native, engine } = setup();
    engine.load({ ...load, startMs: 42_000, gain: 0.5, media: { transcoded: false } });
    expect(native.calls.at(-1)).toEqual(['load', {
      entryId: 'a', url: 'https://music.test/stream/a', startMs: 42_000, gain: 0.5, autoplay: true,
      cacheKey: null, gapless: null, decoder: 'file', albumRun: false,
    }]);
    const gapless = { sampleRate: 48_000, primingFrames: 312, frames: 9_600_000 };
    engine.preload({ entryId: 'b', url: 'https://music.test/stream/b', gain: 1, media: { transcoded: true, gapless } });
    expect(native.preloaded).toMatchObject({ entryId: 'b', decoder: 'stream', startMs: 0, gapless });
    engine.preload(null);
    expect(native.preloaded).toBeNull();
    // From a client that does not say: the file reader, which reads today's transcodes too.
    engine.load({ ...load, entryId: 'c' });
    expect(native.loaded).toMatchObject({ entryId: 'c', decoder: 'file' });
  });

  it('loads and autoplays, reporting loading at once, then playing', () => {
    const { native, engine, states } = setup();
    engine.load(load);
    expect(states()).toEqual(['loading']);
    expect(engine.getStatus()).toEqual({ entryId: 'a', state: 'loading', positionMs: 0 });
    native.ready();
    native.deliver();
    expect(states()).toEqual(['loading', 'loading', 'playing']);
    expect(engine.getStatus().state).toBe('playing');
  });

  it('drops a status for an entry a newer load replaced', () => {
    const { native, engine, events } = setup();
    engine.load(load);
    native.ready();
    engine.load({ ...load, entryId: 'b' });
    native.deliver();
    expect(events.map(event => event.type === 'status' && `${event.status.entryId} ${event.status.state}`)).toEqual(['a loading', 'b loading', 'b loading']);
  });

  it('starts the preload before emitting ended, then reports the new entry', () => {
    const { native, engine, events } = setup();
    engine.load(load);
    engine.preload({ entryId: 'b', url: 'https://music.test/stream/b', gain: 1 });
    native.ready();
    native.deliver();
    events.length = 0;
    let statusAtEnded: string | null = null;
    engine.subscribe(event => {
      if (event.type === 'ended') statusAtEnded = engine.getStatus().entryId;
    });
    native.finish();
    native.deliver();
    expect(events.map(event => event.type)).toEqual(['ended', 'status']);
    expect(events[0]).toEqual({ type: 'ended', entryId: 'a' });
    expect(statusAtEnded).toBe('b');
    expect(engine.getStatus()).toEqual({ entryId: 'b', state: 'playing', positionMs: 0 });
  });

  it('stays on an entry that ended with nothing after it', () => {
    const { native, engine } = setup();
    engine.load(load);
    native.ready();
    native.finish();
    native.deliver();
    expect(engine.getStatus().state).toBe('ended');
  });

  it('says why a stream failed in the words the app uses', () => {
    const { native, engine, events } = setup();
    engine.load(load);
    native.send('error', { entryId: 'a', message: 'Could not connect to the server. (NSURLErrorDomain error -1004.)' });
    native.send('error', { entryId: 'a', message: 'The server answered HTTP 404' });
    native.send('error', { entryId: 'a', message: 'This file’s format can’t be decoded (\'fmt?\')' });
    native.deliver();
    expect(events.flatMap(event => event.type === 'error' ? [event.message] : [])).toEqual([
      'Couldn’t reach the server to play this track.',
      'The server couldn’t find this track.',
      'This track’s file can’t be played.',
    ]);
  });

  it('passes on what the system did, for the app to turn into session commands', () => {
    const { native, onInterrupted, onResumed, log } = setup();
    native.send('interrupted', { entryId: 'a' });
    native.send('resumed', { entryId: 'a' });
    native.send('log', { message: 'a buffering at 1200 ms' });
    native.deliver();
    expect(onInterrupted).toHaveBeenCalledWith('a');
    expect(onResumed).toHaveBeenCalledWith('a');
    expect(log).toHaveBeenCalledWith('a buffering at 1200 ms');
  });

  it('is trying to play only while asked to play and not sounding yet', () => {
    const { native, engine } = setup();
    engine.load({ ...load, autoplay: false });
    expect(engine.isTryingToPlay()).toBe(false);
    engine.load(load);
    expect(engine.isTryingToPlay()).toBe(true);
    native.ready();
    expect(engine.isTryingToPlay()).toBe(false);
    native.status = { ...native.status, state: 'buffering' };
    expect(engine.isTryingToPlay()).toBe(true);
    engine.pause();
    expect(engine.isTryingToPlay()).toBe(false);
  });

  it('forwards transport, gain and holding the session, and keeps gains finite', () => {
    const { native, engine } = setup();
    engine.load(load);
    engine.seek(1_000);
    engine.setGain(Number.NaN);
    engine.setGain(1.4);
    engine.pause();
    engine.play();
    engine.holdAudioSession(true);
    engine.stop();
    expect(native.calls.slice(1)).toEqual([
      ['seek', 1_000], ['setGain', 1], ['setGain', 1.4], ['pause'], ['play'], ['holdAudioSession', true], ['stop'],
    ]);
    expect(engine.getStatus()).toEqual({ entryId: null, state: 'idle' satisfies EngineState, positionMs: 0 });
  });

  it('boosts, behind the engine\'s limiter', () => {
    const { engine } = setup();
    expect(engine.canBoost).toBe(true);
    expect(engine.limiter).toBe(true);
  });

  it('stops listening when disposed', () => {
    const { native, engine, events } = setup();
    expect(native.listenerCount).toBe(6);
    engine.dispose();
    expect(native.listenerCount).toBe(0);
    native.send('ended', { entryId: 'a' });
    native.deliver();
    expect(events).toEqual([]);
  });
});
