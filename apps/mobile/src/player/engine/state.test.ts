import { describe, expect, it } from 'vitest';
import { engineState, playbackErrorMessage, startGraceMs, type SlotReading } from './state';

const playing: SlotReading = {
  failed: false, finished: false, ready: true, wantsPlay: true, started: true, sincePlay: 10_000, playing: true, waiting: false,
};

describe('engineState', () => {
  it('puts failures and ends before everything else', () => {
    expect(engineState({ ...playing, failed: true, finished: true }).state).toBe('error');
    expect(engineState({ ...playing, finished: true }).state).toBe('ended');
  });

  it('is loading until the player is ready and first plays', () => {
    expect(engineState({ ...playing, ready: false }).state).toBe('loading');
    expect(engineState({ ...playing, started: false, playing: false, waiting: true }).state).toBe('loading');
    expect(engineState({ ...playing, started: false, playing: false, sincePlay: 100 }).state).toBe('loading');
  });

  it('follows the request to play or pause', () => {
    expect(engineState(playing)).toEqual({ state: 'playing', interrupted: false });
    expect(engineState({ ...playing, wantsPlay: false, playing: false }).state).toBe('paused');
  });

  it('tells buffering from a system pause', () => {
    expect(engineState({ ...playing, playing: false, waiting: true })).toEqual({ state: 'buffering', interrupted: false });
    expect(engineState({ ...playing, playing: false, sincePlay: startGraceMs - 1 })).toEqual({ state: 'playing', interrupted: false });
    expect(engineState({ ...playing, playing: false, waiting: true, sincePlay: 10 })).toEqual({ state: 'playing', interrupted: false });
    expect(engineState({ ...playing, playing: false })).toEqual({ state: 'paused', interrupted: true });
  });
});

describe('playbackErrorMessage', () => {
  it('explains common AVFoundation failures', () => {
    expect(playbackErrorMessage('The operation couldn’t be completed. (NSURLErrorDomain error -1004.)')).toMatch(/reach the server/);
    expect(playbackErrorMessage('The operation couldn’t be completed. (NSURLErrorDomain error -1100.)')).toMatch(/find this track/);
    expect(playbackErrorMessage('The operation couldn’t be completed. (NSURLErrorDomain error -1001.)')).toMatch(/too long/);
    expect(playbackErrorMessage('Cannot Open')).toMatch(/can’t be played/);
    expect(playbackErrorMessage('Could not connect to the server.')).toMatch(/reach the server/);
    expect(playbackErrorMessage('The requested URL was not found on this server.')).toMatch(/find this track/);
    expect(playbackErrorMessage('The request timed out.')).toMatch(/too long/);
    expect(playbackErrorMessage('Something new')).toBe('Something new');
  });
});
