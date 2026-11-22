import { describe, expect, it } from 'vitest';
import {
  canPlay, downloadSymbol, extensionFor, formatBytes, retryDelay, sizeMatches, songPage, unavailableReason, waitReason,
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

  const admin = { role: 'admin', canAcquire: false } as const;
  const requester = { role: 'member', canAcquire: true } as const;
  const listener = { role: 'member', canAcquire: false } as const;

  it('plays only what is on the phone offline, and what the server has or fetches online', () => {
    const onDevice = (id: string) => id === 'here';
    const online = { offline: false, onDevice, viewer: requester };
    expect(canPlay({ id: 'here', availability: 'none' }, { ...online, offline: true })).toBe(true);
    expect(canPlay({ id: 'there', availability: 'server' }, { ...online, offline: true })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'server' }, online)).toBe(true);
    expect(canPlay({ id: 'there', availability: 'on_demand' }, online)).toBe(true);
    expect(canPlay({ id: 'there', availability: 'on_demand' }, { ...online, viewer: admin })).toBe(true);
    expect(canPlay({ id: 'there', availability: 'none' }, online)).toBe(false);
  });

  it('plays on-demand tracks only for those who may have them fetched', () => {
    const onDevice = () => false;
    expect(canPlay({ id: 'there', availability: 'on_demand' }, { offline: false, onDevice, viewer: listener })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'on_demand' }, { offline: false, onDevice, viewer: null })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'server' }, { offline: false, onDevice, viewer: listener })).toBe(true);
  });

  it('says only "Not available" or, offline, "Not downloaded"', () => {
    expect(unavailableReason({ availability: 'on_demand' }, false, listener)).toBe('Not available');
    expect(unavailableReason({ availability: 'none' }, false, requester)).toBe('Not available');
    expect(unavailableReason({ availability: 'server' }, true, listener)).toBe('Not downloaded');
    expect(unavailableReason({ availability: 'on_demand' }, true, requester)).toBe('Not downloaded');
    // Offline or not, what would not play with a connection either is simply not available.
    expect(unavailableReason({ availability: 'on_demand' }, true, listener)).toBe('Not available');
    expect(unavailableReason({ availability: 'none' }, true, requester)).toBe('Not available');
  });

  it('marks downloads only, never where a streamed file comes from', () => {
    expect(downloadSymbol(undefined)).toBeNull();
    expect(downloadSymbol({ state: 'done', bytes: 1, gone: false })).toBe('arrow.down.circle.fill');
    expect(downloadSymbol({ state: 'queued', wait: null })).toBe('arrow.down.circle.dotted');
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
