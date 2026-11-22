import type { DeviceInfo, QueueEntry, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import {
  codecsFor, deviceRows, isPlayable, isRemote, newlyFailed, nextDownloaded, nextRepeat, outputDevice, playableSeeds, qualityFor,
  seedOf,
} from './session';

const phone: DeviceInfo = { id: 'phone', name: 'Isa’s iPhone', kind: 'ios', canPlay: true, isActive: false };
const web: DeviceInfo = { id: 'web', name: 'Firefox on Mac', kind: 'web', canPlay: true, isActive: true };
const remote: DeviceInfo = { id: 'remote', name: 'Watch', kind: 'other', canPlay: false, isActive: false };

function track(id: string, availability: TrackSummary['availability'] = 'server'): TrackSummary {
  return {
    id, mbid: null, title: id, artistCredit: 'Artist', artists: [], durationMs: 200_000,
    album: { id: `album-${id}`, title: 'Album', artwork: null }, disc: 1, position: 1,
    availability, liked: false, explicit: null, hasLyrics: false,
  };
}

const entry = (id: string, state: QueueEntry['state']): QueueEntry => ({ id, trackId: id, albumId: null, durationMs: 1, state });

describe('deviceRows', () => {
  it('puts this device first, keeps only other devices that can play, and marks the active one', () => {
    const rows = deviceRows([web, phone, remote], phone, 'web');
    expect(rows.map(row => [row.id, row.name, row.subtitle, row.icon, row.active])).toEqual([
      ['phone', 'This iPhone', 'This device', 'iphone', false],
      ['web', 'Firefox on Mac', 'Playing', 'laptopcomputer', true],
    ]);
  });

  it('lists this device even before the server has', () => {
    expect(deviceRows([], phone, null).map(row => row.id)).toEqual(['phone']);
  });

  it('names the active device as the output, or this one when nothing plays', () => {
    expect(outputDevice(deviceRows([web, phone], phone, 'web')).id).toBe('web');
    expect(outputDevice(deviceRows([web, phone], phone, null)).id).toBe('phone');
  });
});

describe('isRemote', () => {
  it('is a remote only while another device plays', () => {
    expect(isRemote({ activeDeviceId: 'web' }, 'phone')).toBe(true);
    expect(isRemote({ activeDeviceId: 'phone' }, 'phone')).toBe(false);
    expect(isRemote({ activeDeviceId: null }, 'phone')).toBe(false);
  });
});

describe('qualityFor', () => {
  const settings = { qualityWifi: 'original', qualityCellular: 'data_saver' } as const;
  it('uses the cellular setting only on cellular', () => {
    expect(qualityFor(settings, 'cellular')).toBe('data_saver');
    expect(qualityFor(settings, 'wifi')).toBe('original');
    expect(qualityFor(settings, 'other')).toBe('original');
  });

  it('asks iOS for the codecs AVPlayer plays', () => {
    expect(codecsFor('ios').split(',')).not.toContain('opus');
    expect(codecsFor('ios').split(',')).toContain('flac');
    expect(codecsFor('android').split(',')).toContain('opus');
  });
});

describe('availability', () => {
  it('never plays catalog-only tracks and prepares on-demand ones', () => {
    expect(isPlayable(track('a', 'none'))).toBe(false);
    expect(isPlayable(track('a', 'on_demand'))).toBe(true);
    expect(seedOf(track('a', 'on_demand'))).toEqual({ trackId: 'a', albumId: 'album-a', durationMs: 200_000, state: 'preparing' });
    expect(seedOf(track('a')).state).toBe('ready');
  });

  it('drops gray tracks and keeps the start on the chosen track', () => {
    const tracks = [track('a'), track('b', 'none'), track('c'), track('d', 'on_demand')];
    const result = playableSeeds(tracks, 2);
    expect(result.seeds.map(seed => seed.trackId)).toEqual(['a', 'c', 'd']);
    expect(result.startIndex).toBe(1);
  });

  it('starts at the next playable track when the chosen one is gray', () => {
    expect(playableSeeds([track('a'), track('b', 'none'), track('c')], 1).startIndex).toBe(1);
    expect(playableSeeds([track('a', 'none'), track('b', 'none')]).seeds).toEqual([]);
  });

  it('queues only what the rule allows, such as downloads while offline', () => {
    const downloaded = new Set(['b', 'd']);
    const result = playableSeeds([track('a'), track('b'), track('c'), track('d')], 0, item => downloaded.has(item.id));
    expect(result.seeds.map(seed => seed.trackId)).toEqual(['b', 'd']);
    expect(playableSeeds([track('a'), track('b'), track('c'), track('d')], 2, item => downloaded.has(item.id)).startIndex).toBe(1);
  });

  it('reports entries that failed after preparing, once', () => {
    const before = { current: entry('a', 'preparing'), queue: [entry('b', 'preparing'), entry('c', 'ready')], history: [], autoplayQueue: [] };
    const after = { current: entry('c', 'ready'), queue: [entry('b', 'preparing')], history: [entry('a', 'failed')], autoplayQueue: [] };
    expect(newlyFailed(before, after).map(item => item.id)).toEqual(['a']);
    expect(newlyFailed(after, after)).toEqual([]);
  });
});

describe('nextRepeat', () => {
  it('cycles off, all, one', () => {
    expect([nextRepeat('off'), nextRepeat('all'), nextRepeat('one')]).toEqual(['all', 'one', 'off']);
  });
});

describe('nextDownloaded', () => {
  const downloaded = new Set(['b', 'd', 'x']);
  const isDownloaded = (id: string) => downloaded.has(id);

  it('finds the first downloaded entry that is ready, passing over the rest', () => {
    const queue = [entry('a', 'ready'), entry('x', 'preparing'), entry('b', 'ready'), entry('d', 'ready')];
    expect(nextDownloaded({ autoplay: false, queue, autoplayQueue: [] }, isDownloaded)?.id).toBe('b');
  });

  it('goes on to autoplay suggestions only when autoplay is on', () => {
    const session = { queue: [entry('a', 'ready')], autoplayQueue: [entry('d', 'ready')] };
    expect(nextDownloaded({ ...session, autoplay: true }, isDownloaded)?.id).toBe('d');
    expect(nextDownloaded({ ...session, autoplay: false }, isDownloaded)).toBeNull();
  });

  it('copes with a long queue at once', () => {
    const queue = Array.from({ length: 5000 }, (_, index) => entry(`t${index}`, 'ready'));
    queue.push(entry('b', 'ready'));
    expect(nextDownloaded({ autoplay: false, queue, autoplayQueue: [] }, isDownloaded)?.id).toBe('b');
  });
});
