import type { AlbumVersion } from '@squirmy/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { AlbumNavProps } from './AlbumButtons';
import { versionsButton } from './versions';

const lp: AlbumVersion = {
  id: '00000000-0000-4000-8000-000000000101:hi_res_lossless', title: 'The Dark Side of the Moon', disambiguation: null,
  releaseDate: '1973-03-01', country: 'GB', label: 'Harvest', catalogNumber: 'SHVL 804', format: '12" Vinyl', identified: true,
  trackCount: 10, ownedTrackCount: 10, quality: { tier: 'hi_res_lossless', codec: 'flac', sampleRate: 96_000, bitDepth: 24, bitrate: 3_000_000 },
};
const remaster: AlbumVersion = {
  ...lp, id: '00000000-0000-4000-8000-000000000102:lossy', disambiguation: '2011 remaster', releaseDate: '2011-09-26', format: 'CD',
  label: null, catalogNumber: null, country: null, ownedTrackCount: 9, quality: { tier: 'lossy', codec: 'mp3', sampleRate: 44_100, bitDepth: null, bitrate: 320_000 },
};
const album = { title: 'The Dark Side of the Moon', ownedVersions: [lp, remaster], versionId: null };
const idle = { busy: false, failed: false };

const shown = (button: AlbumNavProps | false) => {
  if (!button) throw new Error('No Versions button');
  return button;
};

describe('the album page’s Versions button', () => {
  it('shows from two versions; an older server says of none', () => {
    expect(versionsButton({ ...album, ownedVersions: [lp] }, idle, () => undefined)).toBe(false);
    expect(versionsButton({ title: album.title }, idle, () => undefined)).toBe(false);
    expect(shown(versionsButton(album, idle, () => undefined)).icon).toBe('square.stack');
  });

  it('lists Automatic, then each version with its quality, songs and release facts', () => {
    const [automatic, versions] = shown(versionsButton(album, idle, () => undefined)).choices!;
    expect(automatic!.heading).toBe('Plays by default');
    expect(automatic!.options.map(({ title, subtitle, checked }) => ({ title, subtitle, checked })))
      .toEqual([{ title: 'Automatic', subtitle: 'The best copy of each song', checked: true }]);
    expect(versions!.heading).toBeUndefined();
    expect(versions!.options.map(({ id, title, subtitle, checked }) => ({ id, title, subtitle, checked }))).toEqual([
      { id: lp.id, title: '1973 · 12" Vinyl', subtitle: 'Hi-Res Lossless · FLAC 24-bit/96 kHz · 10 songs\nHarvest · SHVL 804 · GB', checked: false },
      { id: remaster.id, title: '2011 remaster', subtitle: 'MP3 · 320 kbps · 9 of 10 songs\n2011 CD', checked: false },
    ]);
  });

  it('checks the pick and names it to VoiceOver; a pick the server no longer holds is Automatic', () => {
    const picked = shown(versionsButton({ ...album, versionId: remaster.id }, idle, () => undefined));
    expect(picked.label).toBe('Versions of The Dark Side of the Moon, 2011 remaster');
    expect(picked.choices!.flatMap(group => group.options).filter(option => option.checked).map(option => option.id)).toEqual([remaster.id]);
    const gone = shown(versionsButton({ ...album, versionId: '00000000-0000-4000-8000-000000000199:lossless' }, idle, () => undefined));
    expect(gone.label).toBe('Versions of The Dark Side of the Moon, Automatic');
    expect(gone.choices![0]!.options[0]!.checked).toBe(true);
  });

  it('picks a version, or Automatic, and does nothing for the one in force', () => {
    const choose = vi.fn();
    const [automatic, versions] = shown(versionsButton({ ...album, versionId: lp.id }, idle, choose)).choices!;
    versions!.options[0]!.onPress();
    expect(choose).not.toHaveBeenCalled();
    versions!.options[1]!.onPress();
    automatic!.options[0]!.onPress();
    expect(choose.mock.calls).toEqual([[remaster.id], [null]]);
  });

  it('spins while a pick is on its way, and says so when the server refused it', () => {
    expect(shown(versionsButton(album, { busy: true, failed: false }, () => undefined)).busy).toBe(true);
    const failed = shown(versionsButton(album, { busy: false, failed: true }, () => undefined));
    expect(failed).toMatchObject({ icon: 'exclamationmark.circle', failed: true, label: 'Couldn’t change the version of “The Dark Side of the Moon”. Try again.' });
    // The menu still opens, to try again.
    expect(failed.choices).toHaveLength(2);
  });
});
