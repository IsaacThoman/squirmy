import type { AlbumSummary, Artwork, HomeResponse, LibraryItem, QueueEntry, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  artistPage, downloadsPage, homePage, libraryPage, loadingPage, messagePage, queuePage, songsPage,
  type BrowsePage, type BrowsePresentation, type BrowseRoute,
} from './templates';

const art: Artwork = { id: 'cover', color: null, thumbhash: null };
const album = (id: string): AlbumSummary => ({
  id, mbid: null, title: id, artistCredit: 'Artist', artists: [],
  year: 2025, type: 'album', artwork: art, availability: 'full', trackCount: 1, ownedTrackCount: 1,
});
const track = (id: string): TrackSummary => ({
  id, mbid: null, title: id, artistCredit: 'Artist', artists: [], durationMs: 200_000,
  album: album('Album'), disc: 1, position: 1, availability: 'server', liked: false, explicit: null, hasLyrics: false,
});
const entry = (id: string, trackId: string, state: QueueEntry['state'] = 'ready'): QueueEntry =>
  ({ id, trackId, albumId: 'Album', durationMs: 200_000, state });
const asLibraryItem = (id: string): LibraryItem => ({ kind: 'album', album: album(id), playedAt: null });

const presentation: BrowsePresentation = {
  limits: { maximumItems: 24, maximumSections: 10, maximumTabCount: 3, maximumImageRowItems: 4 },
  offline: false, viewer: null, canPlay: () => true, canOpen: () => true,
  artwork: (image, placement) => image && `file:///${placement ?? 'row'}-${image.id}.webp` || undefined,
};
const albumRoute: BrowseRoute = { type: 'album', id: 'album', title: 'Album' };
const albumContext = { type: 'album', id: 'album', title: 'Album' } as const;
const visibleRows = (page: BrowsePage) => page.list.sections.flatMap(section => section.items);
const firstPage = { offset: 0, onPage: vi.fn() };

describe('CarPlay browse templates', () => {
  it('uses native artwork rows with a distinct action for each cover', () => {
    const home: HomeResponse = { sections: [{
      kind: 'albums', id: 'recently-added', title: 'Recently Added', albums: ['First', 'Second', 'Third'].map(album),
    }] };
    const result = homePage(home, { ...presentation, limits: { ...presentation.limits, maximumImageRowItems: 2 } });
    expect(visibleRows(result)[0]?.images).toEqual([
      { id: 'home:recently-added:First', title: 'First', imageUrl: 'file:///rail-cover.webp' },
      { id: 'home:recently-added:Second', title: 'Second', imageUrl: 'file:///rail-cover.webp' },
    ]);
    expect(result.actions['home:recently-added:Second']).toEqual({ type: 'open', route: { type: 'album', id: 'Second', title: 'Second' } });
    expect(result.actions['home:recently-added:Third']).toBeUndefined();
  });

  it('falls back to individual rows for dimmed and currently playing songs', () => {
    const songs = ['Current', 'Unavailable'].map(track);
    const home: HomeResponse = { sections: [{ kind: 'tracks', id: 'popular', title: 'Most Played', tracks: songs }] };
    const result = homePage(home, { ...presentation, offline: true, currentTrackId: 'Current', canPlay: song => song.id === 'Current' });
    expect(visibleRows(result)).toMatchObject([
      { title: 'Current', playing: true, enabled: true, imageUrl: 'file:///row-cover.webp' },
      { title: 'Unavailable', detail: 'Not downloaded', playing: false, enabled: false },
    ]);
    expect(result.actions).toMatchObject({
      'home:popular:song:Current:0': { type: 'play', tracks: songs, options: { start: 0, context: { type: 'other', id: 'popular', title: 'Most Played' } } },
    });
    expect(Object.keys(result.actions)).toHaveLength(1);
  });

  it('keeps collection scope and the position of duplicate songs for playback', () => {
    const songs = ['Repeated', 'Middle', 'Repeated'].map(track);
    const loadTracks = vi.fn(async () => songs);
    const result = songsPage(albumRoute, songs, albumContext, presentation, firstPage, {
      artwork: art, subtitle: 'Artist', loadTracks,
    });
    expect(result.list.header).toEqual({
      title: 'Album', detail: 'Artist', imageUrl: 'file:///header-cover.webp', actionIds: ['play', 'shuffle'],
    });
    expect(result.actions).toMatchObject({
      play: { type: 'play', tracks: songs, options: { shuffle: false, context: albumContext }, loadTracks },
      shuffle: { type: 'play', tracks: songs, options: { shuffle: true, context: albumContext }, loadTracks },
      'song:Repeated:2': { type: 'play', tracks: songs, options: { start: 2, context: albumContext }, loadTracks },
    });
  });

  it('pages within limits and advances to the first unseen item across a short server page', () => {
    const limits = { ...presentation.limits, maximumItems: 5, maximumSections: 1 };
    const ui = { ...presentation, limits };
    const onPage = vi.fn();
    const rows = ['A', 'B', 'C', 'D'].map(asLibraryItem);
    const first = libraryPage(rows, ui, { offset: 0, onPage, hasMore: true });
    expect(visibleRows(first).map(row => row.title)).toEqual(['A', 'B', 'C', 'More']);
    expect(first.actions['next-page']).toMatchObject({ type: 'run' });
    if (first.actions['next-page']?.type === 'run') first.actions['next-page'].run();
    expect(onPage).toHaveBeenLastCalledWith(3);
    const second = libraryPage(rows, ui, { offset: 3, onPage, hasMore: true });
    expect(visibleRows(second).map(row => row.title)).toEqual(['Previous', 'D', 'More']);
    if (second.actions['next-page']?.type === 'run') second.actions['next-page'].run();
    expect(onPage).toHaveBeenLastCalledWith(4);
  });

  it('offers artist radio only when supported and online', () => {
    const route = { type: 'artist', id: 'artist', title: 'Artist' } as const;
    const artist = { id: 'artist', name: 'Artist', topTracks: [track('Song')], albums: [album('Album')] };
    expect(artistPage(route, artist, presentation, firstPage).actions.radio).toBeUndefined();
    expect(artistPage(route, { ...artist, radio: true }, { ...presentation, offline: true }, firstPage).actions.radio).toBeUndefined();
    expect(artistPage(route, { ...artist, radio: true }, presentation, firstPage).actions.radio).toEqual({ type: 'radio', artistId: 'artist' });
  });

  it('keeps download routes distinct from online routes', () => {
    const route = { ...albumRoute, downloaded: true };
    const result = downloadsPage([{ route, detail: '1 song' }], presentation, firstPage);
    expect(result.actions['downloaded:album:album']).toEqual({ type: 'open', route });
    expect(loadingPage(route).list).toMatchObject({ id: 'downloaded:album:album', loading: true });
  });

  it('offers a retry only when the failure can be retried', () => {
    expect(messagePage({ id: 'home', title: 'Home' }, 'Offline', 'Check your connection').actions).toEqual({});
    const retry = vi.fn();
    const page = messagePage({ id: 'home', title: 'Home' }, 'Couldn’t load', undefined, retry);
    expect(page.actions.retry).toEqual({ type: 'run', run: retry });
    expect(visibleRows(page)).toMatchObject([{ enabled: false }, { title: 'Try Again' }]);
  });
});

describe('CarPlay Up Next', () => {
  it('marks the current entry, skips failures and offline misses, and selects the concrete queue entry', () => {
    const current = entry('now', 'A');
    const entries = [entry('failure', 'B', 'failed'), entry('unsaved', 'C'), entry('repeat', 'A'), entry('unknown', 'D')];
    const summaries = new Map([['now', track('A')], ['failure', track('B')], ['unsaved', track('C')], ['repeat', track('A')]]);
    const offline = { ...presentation, offline: true, canPlay: (song: TrackSummary) => song.id === 'A' };
    const result = queuePage({ entries, current, tracks: summaries, presentation: offline, ...firstPage });
    expect(visibleRows(result)).toMatchObject([
      { id: 'now', playing: true, enabled: false },
      { id: 'failure', detail: 'Not available', enabled: false },
      { id: 'unsaved', detail: 'Not downloaded', enabled: false },
      { id: 'repeat', playing: false, enabled: true },
      { id: 'unknown', title: 'Song not loaded', enabled: false },
    ]);
    expect(result.actions).toEqual({ repeat: { type: 'queue', entryId: 'repeat' } });
  });
});
