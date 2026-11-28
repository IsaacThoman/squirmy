import { searchItemKey, type SearchItem } from '@squirmy/client-core';
import type { AlbumDetail, AlbumSummary, ArtistSummary, PlaylistSummary, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { localLibrary } from './localLibrary';
import { localMatch, localResults, localSearch, oneEditApart, type LocalLibrary } from './localSearch';

const ref = (name: string) => ({ id: `artist-${name}`, name });
const artist = (name: string, inLibrary = true): ArtistSummary => ({ id: `artist-${name}`, mbid: null, name, image: null, inLibrary });
const album = (title: string, by: string, extra: Partial<AlbumSummary> = {}): AlbumSummary => ({
  id: `album-${title}`, mbid: null, title, artistCredit: by, artists: [ref(by)], year: null, type: 'album', artwork: null,
  availability: 'full', trackCount: 1, ownedTrackCount: 1, ...extra,
});
const track = (title: string, by: string, extra: Partial<TrackSummary> = {}): TrackSummary => ({
  id: `track-${title}`, mbid: null, title, artistCredit: by, artists: [ref(by)], durationMs: 1000, album: null, disc: null, position: null,
  availability: 'server', liked: false, explicit: null, hasLyrics: false, ...extra,
});
const playlist = (name: string): PlaylistSummary => ({
  id: `playlist-${name}`, name, description: null, ownerId: 'me', ownerName: 'me', isPublic: false, trackCount: 1, durationMs: 1, artworks: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const library = (parts: Partial<LocalLibrary>): LocalLibrary => ({ tracks: [], albums: [], artists: [], playlists: [], ...parts });
const everything = () => true;
const keys = (items: readonly SearchItem[]) => items.map(searchItemKey);

describe('localMatch', () => {
  it('ranks a whole name over a prefix, a later word and a typo, as the server does', () => {
    const scores = ['karma police', 'karma police live', 'karma', 'the karma police', 'karma polise'].map(name => localMatch('karma police', name, null));
    expect(scores).toEqual([1, 0.8, 0, 0.97, 0.65]);
    expect(localMatch('karma', 'Karma Police', null)).toBe(0.8);
    expect(localMatch('pol', 'Karma Police', null)).toBe(0.6);
    expect(localMatch('xyz', 'Karma Police', null)).toBe(0);
  });

  it('finds a song by its artist and title together, and by its artist alone lower', () => {
    expect(localMatch('radiohead karma', 'Karma Police', ['Radiohead'])).toBe(0.75);
    expect(localMatch('karma police radiohead', 'Karma Police', ['Radiohead'])).toBe(1);
    expect(localMatch('radiohead', 'Karma Police', ['Radiohead'])).toBe(0.62);
  });

  it('ignores case, accents, punctuation and an edition suffix', () => {
    expect(localMatch('beyonce', 'Beyoncé', null)).toBe(1);
    expect(localMatch('ok computer', 'OK Computer (Remastered 2009)', null)).toBe(1);
    expect(localMatch('get lucky', 'Get Lucky (feat. Pharrell Williams)', null)).toBe(1);
  });

  it('allows one typo only from five characters', () => {
    expect(oneEditApart('swfit', 'swift')).toBe(true);
    expect(localMatch('radiohed', 'Radiohead', null)).toBe(0.65);
    expect(localMatch('abbx', 'abba', null)).toBe(0);
  });
});

describe('localSearch', () => {
  const kept = library({
    artists: [artist('Radiohead')],
    albums: [album('OK Computer', 'Radiohead')],
    tracks: [track('Karma Police', 'Radiohead'), track('Paranoid Android', 'Radiohead'), track('Police and Thieves', 'The Clash')],
    playlists: [playlist('Karma mix')],
  });

  it('lists every kind mixed, best match first', () => {
    expect(keys(localSearch('radiohead karma', kept, { plays: everything }))).toEqual(['track:track-Karma Police']);
    expect(keys(localSearch('radiohead', kept, { plays: everything }))).toEqual([
      'artist:artist-Radiohead', 'album:album-OK Computer', 'track:track-Karma Police', 'track:track-Paranoid Android',
    ]);
    expect(keys(localSearch('karma', kept, { plays: everything }))).toEqual(['playlist:playlist-Karma mix', 'track:track-Karma Police']);
  });

  it('lists what can’t play now after what can, and each item once', () => {
    const twice = library({ tracks: [track('Police and Thieves', 'The Clash'), track('Karma Police', 'Radiohead'), track('Karma Police', 'Radiohead')] });
    const plays = (item: SearchItem) => item.type !== 'track' || item.track.title !== 'Police and Thieves';
    expect(keys(localSearch('police', twice, { plays }))).toEqual(['track:track-Karma Police', 'track:track-Police and Thieves']);
  });

  it('ranks what the viewer hearted a little higher among equal matches', () => {
    const songs = library({ tracks: [track('Tone A', 'Fixture'), track('Tone B', 'Fixture', { liked: true })] });
    expect(keys(localSearch('tone', songs, { plays: everything }))).toEqual(['track:track-Tone B', 'track:track-Tone A']);
  });

  it('keeps to the limit of each kind and finds nothing for punctuation alone', () => {
    const many = library({ tracks: Array.from({ length: 5 }, (_, n) => ({ ...track(`Tone ${n}`, 'Fixture') })) });
    expect(localSearch('tone', many, { plays: everything, limit: 2 })).toHaveLength(2);
    expect(localSearch('  ', kept, { plays: everything })).toEqual([]);
  });

  it('answers as the server’s library search does, for the Library', () => {
    const results = localResults(localSearch('radiohead', kept, { plays: everything }));
    expect(results.artists.map(item => item.name)).toEqual(['Radiohead']);
    expect(results.albums.map(item => item.title)).toEqual(['OK Computer']);
    expect(results.tracks.map(item => item.title)).toEqual(['Karma Police', 'Paranoid Android']);
  });
});

describe('localLibrary', () => {
  const page = <T,>(items: T[]) => ({ pages: [{ items, nextCursor: null }], pageParams: [undefined] });
  const albumPage = (title: string, library: AlbumDetail['library'], tracks: TrackSummary[]): AlbumDetail => ({
    ...album(title, 'Fixture'), releaseDate: null, genres: [], description: null, label: null, durationMs: 1, liked: false, wanted: false,
    library, discs: [{ disc: 1, title: null, tracks }],
  });
  const queries = [
    { queryKey: ['library', 'items', 'recent'], data: page([{ kind: 'album', album: album('Listed', 'Fixture'), playedAt: null, pinned: false }]) },
    { queryKey: ['likes', 'track'], data: page([track('Liked tone', 'Fixture', { inLibrary: true })]) },
    { queryKey: ['playlists', 'list'], data: page([playlist('Mix')]) },
    { queryKey: ['album', 'album-Elsewhere'], data: albumPage('Elsewhere', null, [track('Played tone', 'Fixture', { inLibrary: false })]) },
    { queryKey: ['album', 'album-Saved'], data: albumPage('Saved', 'saved', []) },
    { queryKey: ['artist', 'artist-Fixture'], data: { ...artist('Fixture', false), topTracks: [track('Top tone', 'Fixture', { inLibrary: false })] } },
    { queryKey: ['search', 'library', 'tone'], data: undefined },
  ];
  const downloads = { tracks: [track('Kept tone', 'Fixture', { inLibrary: false })], albums: [], playlists: [] };
  const titles = (kept: LocalLibrary) => ({
    tracks: kept.tracks.map(item => item.title), albums: kept.albums.map(item => item.title),
    artists: kept.artists.map(item => item.name), playlists: kept.playlists.map(item => item.name),
  });

  it('reads the downloads first, then every list and page the cache holds', () => {
    expect(titles(localLibrary(queries, downloads, 'all'))).toEqual({
      tracks: ['Kept tone', 'Liked tone', 'Played tone', 'Top tone'],
      albums: ['Listed', 'Elsewhere', 'Saved'],
      artists: ['Fixture'],
      playlists: ['Mix'],
    });
  });

  it('keeps to what the Library lists for its own search, and what was downloaded', () => {
    expect(titles(localLibrary(queries, downloads, 'library'))).toEqual({
      tracks: ['Kept tone', 'Liked tone'], albums: ['Listed', 'Saved'], artists: [], playlists: ['Mix'],
    });
  });
});
