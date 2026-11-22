import type { DeviceInfo, QueueEntry } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { detachedNotice, hasQueueToBring, moveFailure, rejoinedNotice, separateRows } from './detach';

const entry: QueueEntry = { id: 'e1', trackId: 't1', albumId: null, durationMs: 1, state: 'ready' };

describe('moveFailure', () => {
  it('words each refusal as the spec does', () => {
    expect(moveFailure('detach', 'offline')).toBe('Can’t do that while offline.');
    expect(moveFailure('detach', 'too_many_detached')).toBe('Eight devices are already playing separately. Re-attach one first.');
    expect(moveFailure('detach', 'timeout')).toBe('Couldn’t play separately. Try again.');
    expect(moveFailure('detach', 'cannot_play')).toBe('Couldn’t play separately.');
    expect(moveFailure('attach', 'disconnected')).toBe('Couldn’t rejoin. Try again.');
    expect(moveFailure('attach', 'offline')).toBe('Can’t do that while offline.');
  });
});

describe('notices', () => {
  it('says the other devices paused only when this phone was playing', () => {
    expect(detachedNotice(true)).toBe('Playing only on this device. Your other devices are paused where they were.');
    expect(detachedNotice(false)).toBe('Playing only on this device.');
  });

  it('names the song a rejoin stopped, and says nothing when nothing played', () => {
    expect(rejoinedNotice('Roygbiv', true)).toBe('Rejoined your other devices. Stopped “Roygbiv”.');
    expect(rejoinedNotice(undefined, true)).toBe('Rejoined your other devices.');
    expect(rejoinedNotice('Roygbiv', false)).toBeNull();
  });
});

describe('hasQueueToBring', () => {
  it('is false only with no current entry and an empty queue', () => {
    expect(hasQueueToBring({ current: null }, { queue: [] })).toBe(false);
    expect(hasQueueToBring({ current: entry }, { queue: [] })).toBe(true);
    expect(hasQueueToBring({ current: null }, { queue: [entry] })).toBe(true);
  });
});

describe('separateRows', () => {
  const devices: DeviceInfo[] = [
    { id: 'phone', name: 'This phone', kind: 'ios', canPlay: false, isActive: false, detached: { playing: true, trackId: 't1', albumId: null } },
    { id: 'kitchen', name: 'Kitchen', kind: 'web', canPlay: false, isActive: false, detached: { playing: false, trackId: 't2', albumId: 'a2' } },
    { id: 'tablet', name: 'Tablet', kind: 'ios', canPlay: false, isActive: false, detached: { playing: false, trackId: null, albumId: null } },
    { id: 'laptop', name: 'Laptop', kind: 'web', canPlay: true, isActive: true },
  ];
  const titles: Record<string, string> = { t1: 'One', t2: 'Two' };

  it('lists the other detached devices with what they play', () => {
    expect(separateRows(devices, 'phone', trackId => titles[trackId])).toEqual([
      { id: 'kitchen', name: 'Kitchen', icon: 'laptopcomputer', subtitle: 'Two · Paused' },
      { id: 'tablet', name: 'Tablet', icon: 'iphone', subtitle: 'Nothing playing' },
    ]);
  });

  it('includes this phone’s group on a device that is not detached', () => {
    expect(separateRows(devices, 'laptop', trackId => titles[trackId]).map(row => row.subtitle)).toEqual(['One', 'Two · Paused', 'Nothing playing']);
  });
});
