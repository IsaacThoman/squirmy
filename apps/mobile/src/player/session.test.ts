import type { DeviceInfo, QueueEntry, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import {
  codecsFor, deviceRows, isPlayable, queueRow, isRemote, nextDownloaded, nextRepeat, outputDevice, playableSeeds, qualityFor,
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
  const playingOn = (activeDeviceId: string) => ({ activeDeviceId, playing: true });
  const idle = { activeDeviceId: null, playing: false };

  it('puts this device first, keeps only other devices that can play, and marks the active one', () => {
    const rows = deviceRows([web, phone, remote], phone, playingOn('web'));
    expect(rows.map(row => [row.id, row.name, row.subtitle, row.icon, row.active])).toEqual([
      ['phone', 'This iPhone', 'This device', 'iphone', false],
      ['web', 'Firefox on Mac', 'Playing', 'laptopcomputer', true],
    ]);
  });

  it('says the active device is paused while the session is', () => {
    const rows = deviceRows([web, phone], phone, { activeDeviceId: 'web', playing: false });
    expect(rows.map(row => [row.id, row.subtitle, row.active])).toEqual([
      ['phone', 'This device', false],
      ['web', 'Paused', true],
    ]);
    expect(deviceRows([web, phone], phone, { activeDeviceId: 'phone', playing: false })[0]!.subtitle).toBe('Paused');
  });

  it('says how long a quiet device has been idle, so two of the same name can be told apart', () => {
    const now = Date.UTC(2026, 10, 22, 12);
    const tab = (id: string, minutes: number): DeviceInfo => ({ id, name: 'Chrome on macOS', kind: 'web', canPlay: true, isActive: false, lastSeenAt: now - minutes * 60_000 });
    const rows = deviceRows([tab('now', 1), tab('minutes', 20), tab('hours', 180), tab('days', 3 * 24 * 60), { ...web, isActive: false }], phone, idle, now);
    expect(rows.slice(1).map(row => row.subtitle)).toEqual([
      'Web browser', 'Web browser · Active 20 min ago', 'Web browser · Active 3 h ago', 'Web browser · Active 3 days ago', 'Web browser',
    ]);
  });

  it('lists this device even before the server has', () => {
    expect(deviceRows([], phone, idle).map(row => row.id)).toEqual(['phone']);
  });

  it('names a player the device list does not know yet instead of falling back to this device', () => {
    const rows = deviceRows([phone], phone, playingOn('new'));
    expect(rows.map(row => [row.id, row.name, row.subtitle, row.active])).toEqual([
      ['phone', 'This iPhone', 'This device', false],
      ['new', 'Another device', 'Playing', true],
    ]);
    expect(outputDevice(rows).id).toBe('new');
  });

  it('names the active device as the output, or this one when nothing plays', () => {
    expect(outputDevice(deviceRows([web, phone], phone, playingOn('web'))).id).toBe('web');
    expect(outputDevice(deviceRows([web, phone], phone, idle)).id).toBe('phone');
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

describe('queueRow', () => {
  const requester = { role: 'member', canAcquire: true } as const;
  const song = track('a', 'on_demand');

  it('shows a waiting or fetching entry like any other', () => {
    expect(queueRow(entry('a', 'preparing'), song, { playable: true, offline: false, viewer: requester })).toEqual({ detail: 'Artist', unavailable: false });
    expect(queueRow(entry('a', 'ready'), song, { playable: true, offline: false, viewer: requester })).toEqual({ detail: 'Artist', unavailable: false });
  });

  it('says "Not available" for a failed entry and "Not downloaded" offline', () => {
    expect(queueRow(entry('a', 'failed'), song, { playable: true, offline: false, viewer: requester })).toEqual({ detail: 'Not available', unavailable: true });
    expect(queueRow(entry('a', 'ready'), song, { playable: false, offline: true, viewer: requester })).toEqual({ detail: 'Not downloaded', unavailable: true });
  });

  it('does not gray an entry whose summary is still loading', () => {
    expect(queueRow(entry('a', 'ready'), undefined, { playable: false, offline: true, viewer: requester })).toEqual({ detail: '', unavailable: false });
  });
});
