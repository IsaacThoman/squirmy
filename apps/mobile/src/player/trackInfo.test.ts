import type { SignalPath, TrackVersion, TrackVersions } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { trackInfoNote, trackInfoSections, trackVersionRows } from './trackInfo';

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

const album = '00000000-0000-4000-8000-000000000010';
const best: TrackVersion = {
  id: '00000000-0000-4000-8000-000000000101:hi_res_lossless', title: 'Blue Hour', disambiguation: null, releaseDate: '2019-05-01',
  country: null, label: null, catalogNumber: null, format: '12" Vinyl', identified: true, albumId: album, albumTitle: 'Blue Hour',
  quality: { tier: 'hi_res_lossless', codec: 'flac', sampleRate: 96_000, bitDepth: 24, bitrate: 3_000_000 },
};
const mp3: TrackVersion = {
  ...best, id: '00000000-0000-4000-8000-000000000102:lossy', disambiguation: '2024 remaster', releaseDate: '2024-01-01', format: 'Digital Media',
  quality: { tier: 'lossy', codec: 'mp3', sampleRate: 44_100, bitDepth: null, bitrate: 320_000 },
};
const single: TrackVersion = { ...mp3, id: '00000000-0000-4000-8000-000000000103:lossless', albumId: '00000000-0000-4000-8000-000000000011', albumTitle: 'Night Drive', disambiguation: null,
  releaseDate: '2018-11-02', format: 'CD', quality: { tier: 'lossless', codec: 'flac', sampleRate: 44_100, bitDepth: 16, bitrate: 900_000 } };
const versions: TrackVersions = { trackId: signal.trackId, versions: [best, mp3, single], versionId: null, albumVersionId: null };

describe('track info versions', () => {
  it('lists Automatic, then each version with its quality, naming another album', () => {
    expect(trackVersionRows(versions, { albumId: album, playing: undefined }).map(({ title, subtitle, picked }) => ({ title, subtitle, picked }))).toEqual([
      { title: 'Automatic', subtitle: 'The best copy', picked: true },
      { title: '2019 · 12" Vinyl', subtitle: 'Hi-Res Lossless · FLAC 24-bit/96 kHz', picked: false },
      { title: '2024 remaster', subtitle: 'MP3 · 320 kbps', picked: false },
      { title: '2018 · CD · Night Drive', subtitle: 'Lossless · FLAC 16-bit/44.1 kHz', picked: false },
    ]);
  });

  it('marks the version playing and the user’s pick', () => {
    const rows = trackVersionRows({ ...versions, versionId: mp3.id }, { albumId: album, playing: best.id });
    expect(rows.find(row => row.picked)?.versionId).toBe(mp3.id);
    expect(rows[1]).toMatchObject({ subtitle: 'Hi-Res Lossless · FLAC 24-bit/96 kHz · Playing now', icon: 'speaker.wave.2.fill', picked: false });
    expect(rows[2]!.icon).toBe('square.stack');
  });

  it('says Automatic plays the album’s pick, and ignores a pick the server no longer holds', () => {
    const rows = trackVersionRows({ ...versions, albumVersionId: mp3.id, versionId: '00000000-0000-4000-8000-000000000199:lossless' }, { albumId: album, playing: undefined });
    expect(rows[0]).toMatchObject({ versionId: null, subtitle: 'The album’s pick, 2024 remaster', picked: true });
  });

  it('names albums with no album to tell them from only when the versions are on several', () => {
    expect(trackVersionRows(versions, { albumId: null, playing: undefined }).map(row => row.title).slice(1))
      .toEqual(['2019 · 12" Vinyl · Blue Hour', '2024 remaster · Blue Hour', '2018 · CD · Night Drive']);
    expect(trackVersionRows({ ...versions, versions: [best, mp3] }, { albumId: null, playing: undefined }).map(row => row.title).slice(1))
      .toEqual(['2019 · 12" Vinyl', '2024 remaster']);
  });

  it('offers nothing to choose from one version', () => {
    expect(trackVersionRows(undefined, { albumId: album, playing: undefined })).toEqual([]);
    expect(trackVersionRows({ ...versions, versions: [best] }, { albumId: album, playing: undefined })).toEqual([]);
  });
});
