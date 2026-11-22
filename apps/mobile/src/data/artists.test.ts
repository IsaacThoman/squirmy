import type { AlbumSummary, ArtistSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { artistPending, artistPlaceholder, findArtistSummary, releaseGroups } from './artists';

const artist: ArtistSummary = { id: 'ar1', mbid: null, name: 'Grimes', image: null, inLibrary: false };
const album = (id: string, type: AlbumSummary['type']): AlbumSummary => ({
  id, mbid: null, title: id, artistCredit: 'Grimes', artists: [{ id: artist.id, name: artist.name }], year: 2020, type, artwork: null,
  trackCount: 1, ownedTrackCount: 1, availability: 'full',
});

describe('artist placeholders', () => {
  it('finds the artist in cached answers, not an album or track crediting them', () => {
    const cached = [{ items: [{ ...album('al1', 'album'), id: 'ar1' }] }, { sections: [{ artists: [artist] }] }];
    expect(findArtistSummary(cached, 'ar1')).toBe(artist);
    expect(findArtistSummary(cached, 'nobody')).toBeUndefined();
  });

  it('draws the header from the summary, with nothing under it', () => {
    const page = artistPlaceholder(artist);
    expect(page.name).toBe('Grimes');
    expect([page.albums, page.topTracks, page.similar]).toEqual([[], [], []]);
  });

  it('asks again only while the server says it is filling the page in, for a while', () => {
    const pending = { ...artistPlaceholder(artist), detailPending: true as const };
    expect(artistPending(pending, 1)).toBe(true);
    expect(artistPending(pending, 100)).toBe(false);
    expect(artistPending(artistPlaceholder(artist), 1)).toBe(false);
  });
});

describe('releaseGroups', () => {
  it('files releases by type, soundtracks and other releases apart from compilations, appearances last', () => {
    const groups = releaseGroups({
      albums: [album('s1', 'single'), album('a1', 'album'), album('e1', 'ep'), album('st', 'soundtrack'), album('o', 'other'), album('c', 'compilation'), album('l', 'live')],
      appearsOn: [album('x', 'album')],
    });
    expect(groups.map(group => [group.title, group.albums.map(item => item.id)])).toEqual([
      ['Albums', ['a1']],
      ['EPs & Singles', ['s1', 'e1']],
      ['Compilations', ['c']],
      ['Live Albums', ['l']],
      ['Soundtracks', ['st']],
      ['Other Releases', ['o']],
      ['Appears On', ['x']],
    ]);
  });
});
