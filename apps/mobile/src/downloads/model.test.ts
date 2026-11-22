import { describe, expect, it } from 'vitest';
import {
  canPlay, canRequestMusic, extensionFor, formatBytes, retryDelay, sizeMatches, songPage, trackMark, unavailableReason, waitReason,
} from './model';

describe('download rules', () => {
  it('waits longer after each failure, up to 15 minutes', () => {
    expect([1, 2, 3, 4, 10].map(retryDelay)).toEqual([15_000, 30_000, 60_000, 120_000, 15 * 60_000]);
  });

  it('explains why nothing downloads', () => {
    const base = { online: true, network: 'wifi' as const, wifiOnly: true, usedBytes: 0, capBytes: null };
    expect(waitReason(base)).toBeNull();
    expect(waitReason({ ...base, online: false })).toBe('offline');
    expect(waitReason({ ...base, network: 'none' })).toBe('offline');
    expect(waitReason({ ...base, network: 'cellular' })).toBe('wifi');
    expect(waitReason({ ...base, network: 'cellular', wifiOnly: false })).toBeNull();
    expect(waitReason({ ...base, network: 'other' })).toBeNull();
    expect(waitReason({ ...base, usedBytes: 10, capBytes: 10 })).toBe('storage');
  });

  it('accepts a file only at the size the server announced', () => {
    expect(sizeMatches(1000, [1000, 1000])).toBe(true);
    expect(sizeMatches(1000, [-1, null])).toBe(true);
    expect(sizeMatches(999, [1000, null])).toBe(false);
    expect(sizeMatches(0, [-1])).toBe(false);
    expect(sizeMatches(null, [])).toBe(false);
  });

  it('names files so AVPlayer recognises them', () => {
    expect(extensionFor({ mime: 'audio/flac', codec: 'flac', transcoded: false })).toBe('flac');
    expect(extensionFor({ mime: 'audio/mp4', codec: 'alac', transcoded: false })).toBe('m4a');
    expect(extensionFor({ mime: 'audio/aac', codec: 'aac', transcoded: true })).toBe('aac');
    expect(extensionFor({ mime: 'audio/mpeg', codec: 'mp3', transcoded: true })).toBe('mp3');
    expect(extensionFor({ mime: 'application/octet-stream', codec: 'wav', transcoded: false })).toBe('wav');
  });

  it('plays only downloads offline, and downloads or server files online', () => {
    const downloaded = (id: string) => id === 'here';
    const online = { offline: false, downloaded, canRequest: true };
    expect(canPlay({ id: 'here', availability: 'none' }, { ...online, offline: true })).toBe(true);
    expect(canPlay({ id: 'there', availability: 'server' }, { ...online, offline: true })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'server' }, online)).toBe(true);
    expect(canPlay({ id: 'there', availability: 'on_demand' }, online)).toBe(true);
    expect(canPlay({ id: 'there', availability: 'none' }, online)).toBe(false);
  });

  it('plays on-demand tracks only for those who may have them fetched', () => {
    const downloaded = () => false;
    expect(canPlay({ id: 'there', availability: 'on_demand' }, { offline: false, downloaded, canRequest: false })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'server' }, { offline: false, downloaded, canRequest: false })).toBe(true);
    expect(canRequestMusic({ role: 'admin', canAcquire: false })).toBe(true);
    expect(canRequestMusic({ role: 'member', canAcquire: true })).toBe(true);
    expect(canRequestMusic({ role: 'member', canAcquire: false })).toBe(false);
    expect(unavailableReason({ availability: 'on_demand' }, false)).toMatch(/ask an admin/);
    expect(unavailableReason({ availability: 'none' }, false)).toBe('not in your library');
    expect(unavailableReason({ availability: 'server' }, true)).toBe('not downloaded or cached');
  });

  it('marks downloads, and on-demand tracks that can be fetched', () => {
    expect(trackMark(undefined, { availability: 'on_demand' }, true)).toBe('icloud.and.arrow.down');
    expect(trackMark(undefined, { availability: 'on_demand' }, false)).toBeNull();
    expect(trackMark(undefined, { availability: 'server' }, true)).toBeNull();
    expect(trackMark({ state: 'done', bytes: 1, gone: false }, { availability: 'server' }, true)).toBe('arrow.down.circle.fill');
  });

  it('formats sizes', () => {
    expect([2_500, 4_200_000, 123_000_000, 1_250_000_000, 64_000_000_000].map(formatBytes))
      .toEqual(['3 KB', '4.2 MB', '123 MB', '1.3 GB', '64 GB']);
  });
});

describe('songPage', () => {
  const artist = { id: 'artist-1', name: 'Artist' };
  it('opens the album, or the first artist when the song has none', () => {
    expect(songPage({ album: { id: 'album-1', title: 'Album', artwork: null }, artists: [artist] })).toEqual({ page: 'album', id: 'album-1' });
    expect(songPage({ album: null, artists: [artist] })).toEqual({ page: 'artist', id: 'artist-1' });
    expect(songPage({ album: null, artists: [] })).toBeNull();
  });
});
