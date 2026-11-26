import { describe, expect, it } from 'vitest';
import { carPlayResume, carPlayStart } from './playback';

describe('CarPlay output', () => {
  it('claims the phone without briefly starting the old song when picking a new one', () => {
    const command = { type: 'playQueueEntry', entryId: 'song' } as const;
    expect(carPlayStart({ activeDeviceId: 'laptop', playing: true }, 'phone', command)).toEqual([
      { type: 'transfer', deviceId: 'phone', play: false }, command,
    ]);
    expect(carPlayStart({ activeDeviceId: null, playing: false }, 'phone', command)).toEqual([command]);
    expect(carPlayStart({ activeDeviceId: 'phone', playing: false }, 'phone', command)).toEqual([command]);
  });

  it('uses a single play command with servers that advertise the capability', () => {
    const remote = { activeDeviceId: 'laptop', playing: true };
    expect(carPlayStart(remote, 'phone', { type: 'playQueueEntry', entryId: 'song' }, true)).toEqual([
      { type: 'playQueueEntry', entryId: 'song', playHere: true },
    ]);
    expect(carPlayResume(remote, 'phone', true)).toEqual([{ type: 'play', playHere: true }]);
  });

  it('leaves a playing remote device alone on an unsolicited Play', () => {
    expect(carPlayResume({ activeDeviceId: 'laptop', playing: true }, 'phone')).toEqual([]);
    expect(carPlayResume({ activeDeviceId: 'laptop', playing: false }, 'phone')).toEqual([
      { type: 'transfer', deviceId: 'phone', play: false }, { type: 'play' },
    ]);
    expect(carPlayResume({ activeDeviceId: 'phone', playing: false }, 'phone')).toEqual([{ type: 'play' }]);
  });
});
