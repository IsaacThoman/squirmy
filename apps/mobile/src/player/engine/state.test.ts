import { describe, expect, it } from 'vitest';
import { engineState, playbackErrorMessage, startGraceMs, type SlotReading } from './state';

const playing: SlotReading = {
  failed: false, finished: false, ready: true, wantsPlay: true, started: true, sincePlay: 10_000, playing: true,
};

describe('engineState', () => {
  it('puts failures and ends before everything else', () => {
    expect(engineState({ ...playing, failed: true, finished: true })).toBe('error');
    expect(engineState({ ...playing, finished: true })).toBe('ended');
  });

  it('is loading until the player is ready and first plays', () => {
    expect(engineState({ ...playing, ready: false })).toBe('loading');
    expect(engineState({ ...playing, started: false, playing: false })).toBe('loading');
    expect(engineState({ ...playing, started: false, playing: false, sincePlay: 100 })).toBe('loading');
  });

  it('follows the request to play or pause', () => {
    expect(engineState(playing)).toBe('playing');
    expect(engineState({ ...playing, wantsPlay: false, playing: false })).toBe('paused');
  });

  it('counts a player that stopped by itself as stalled, not paused', () => {
    expect(engineState({ ...playing, playing: false })).toBe('buffering');
    expect(engineState({ ...playing, playing: false, sincePlay: startGraceMs - 1 })).toBe('playing');
    expect(engineState({ ...playing, playing: false, started: false })).toBe('loading');
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
