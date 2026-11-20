import { describe, expect, it } from 'vitest';
import { canPlay, extensionFor, formatBytes, retryDelay, sizeMatches, waitReason } from './model';

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
    expect(canPlay({ id: 'here', availability: 'none' }, { offline: true, downloaded })).toBe(true);
    expect(canPlay({ id: 'there', availability: 'server' }, { offline: true, downloaded })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'server' }, { offline: false, downloaded })).toBe(true);
    expect(canPlay({ id: 'there', availability: 'on_demand' }, { offline: false, downloaded })).toBe(true);
    expect(canPlay({ id: 'there', availability: 'none' }, { offline: false, downloaded })).toBe(false);
  });

  it('formats sizes', () => {
    expect([2_500, 4_200_000, 123_000_000, 1_250_000_000, 64_000_000_000].map(formatBytes))
      .toEqual(['3 KB', '4.2 MB', '123 MB', '1.3 GB', '64 GB']);
  });
});
