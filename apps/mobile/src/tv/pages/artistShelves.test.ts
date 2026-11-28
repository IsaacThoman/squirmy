import type { AlbumSummary, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import type { ReleaseGroup } from '../../data/artists';
import { latestRelease, topRow } from './artistShelves';

const album = (id: string, year: number | null) => ({ id, year } as AlbumSummary);
const group = (key: string, ...albums: AlbumSummary[]): ReleaseGroup => ({ key, title: key, albums, total: albums.length, paged: true });
const track = (id: string) => ({ id } as TrackSummary);

describe('latestRelease', () => {
  it('takes the newest first release of the artist’s own sections', () => {
    expect(latestRelease([group('album', album('a', 2019)), group('single', album('s', 2024)), group('appears_on', album('x', 2025))])?.id).toBe('s');
  });

  it('keeps the earlier section on a tie, and falls back to a release without a year', () => {
    expect(latestRelease([group('album', album('a', 2024)), group('single', album('s', 2024))])?.id).toBe('a');
    expect(latestRelease([group('album', album('a', null))])?.id).toBe('a');
    expect(latestRelease([group('appears_on', album('x', 2025))])).toBeNull();
  });
});

describe('topRow', () => {
  it('lays the top songs two to a column after the latest release, with See all for the rest', () => {
    const top = Array.from({ length: 13 }, (_, index) => track(`t${index}`));
    const row = topRow(album('a', 2024), top);
    expect(row.map(item => item.kind)).toEqual(['latest', 'songs', 'songs', 'songs', 'songs', 'songs', 'all']);
    expect(row[1]).toMatchObject({ start: 0, first: true });
    expect(row[2]).toMatchObject({ start: 2, first: false });
  });

  it('has no See all when every song is shown', () => {
    expect(topRow(null, [track('a'), track('b'), track('c')]).map(item => item.kind)).toEqual(['songs', 'songs']);
  });
});
