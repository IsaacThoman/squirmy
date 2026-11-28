import type { SignalPath } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { trackInfoNote, trackInfoSections } from './trackInfo';

const signal: SignalPath = {
  entryId: 'e1', trackId: '00000000-0000-4000-8000-000000000001', deviceId: 'tv',
  source: { codec: 'flac', lossless: true, bitrate: 1_000_000, sampleRate: 44_100, bitDepth: 16, channels: 2, bytes: 30_000_000 },
  delivery: { profile: 'original', transcoded: false, codec: 'flac', lossless: true, bitrate: 1_000_000, sampleRate: 44_100, bitDepth: 16, reason: null, local: false },
  normalization: { mode: 'off', applied: null, gainDb: null },
};
const tv = { name: 'Living Room', isThisDevice: false };

describe('track info', () => {
  it('says where the song plays, then what that device says of it', () => {
    expect(trackInfoSections({ signal, output: tv }).map(section => section.title)).toEqual(['Playing on', 'File', 'Playback', 'Volume normalization']);
    expect(trackInfoSections({ signal, output: tv })[0]!.rows).toEqual([{ label: 'Device', value: 'Living Room' }]);
    expect(trackInfoNote({ signal, output: tv })).toBeNull();
  });

  it('says why there is nothing about the audio', () => {
    expect(trackInfoSections({ signal: null, output: tv }).map(section => section.title)).toEqual(['Playing on']);
    expect(trackInfoNote({ signal: null, output: tv })).toBe('Living Room hasn’t said how it plays this song. It may need an update.');
    expect(trackInfoNote({ signal: null, output: { name: 'This iPhone', isThisDevice: true } })).toBe('Loading the song…');
    expect(trackInfoNote({ signal: null, output: null })).toBe('Play the song to see how it plays.');
  });
});
