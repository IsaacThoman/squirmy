import type { AlbumDetail, AlbumSummary, ArtistDetail, SearchResults, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../account/AccountProvider';
import { donationFor, intentText, runIntent, search, type IntentDeps } from './intents';

const track = (id: string, availability: TrackSummary['availability'] = 'server'): TrackSummary => ({
  id, mbid: null, title: `Song ${id}`, artistCredit: 'Mira Vale', artists: [], durationMs: 1000, album: null, disc: null, position: null,
  availability, liked: false, explicit: null, hasLyrics: false,
});
const album = (id: string, availability: AlbumSummary['availability'] = 'full'): AlbumSummary => ({
  id, mbid: null, title: `Album ${id}`, artistCredit: 'Mira Vale', artists: [], year: null, type: 'album', artwork: null, availability,
  trackCount: 2, ownedTrackCount: 2,
});
const results = (parts: Partial<SearchResults>): SearchResults => ({ artists: [], albums: [], tracks: [], provider: null, ...parts });
const page = <T>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });

function setup(api: Record<string, Record<string, unknown>> = {}, parts: Partial<IntentDeps> = {}) {
  const actions = {
    playPause: vi.fn(), play: vi.fn(), pause: vi.fn(), next: vi.fn(), previous: vi.fn(), playTracks: vi.fn(), playRadio: vi.fn(),
  };
  const deps: IntentDeps = {
    api: api as unknown as Api,
    serverUrl: 'https://music.example.com',
    viewer: { role: 'member', canAcquire: false },
    offline: false,
    canPlay: candidate => candidate.availability === 'server',
    currentTrackId: () => 't1',
    prime: vi.fn(),
    actions,
    ...parts,
  };
  return { deps, actions };
}

describe('the playback controls', () => {
  it('send session commands, answered once the server has them', async () => {
    const { deps, actions } = setup();
    await expect(runIntent('togglePlayback', {}, deps)).resolves.toEqual({ wait: 'command', result: {} });
    await runIntent('pause', {}, deps);
    await runIntent('next', {}, deps);
    await runIntent('previous', {}, deps);
    expect(actions.playPause).toHaveBeenCalledOnce();
    expect(actions.pause).toHaveBeenCalledOnce();
    expect(actions.next).toHaveBeenCalledOnce();
    expect(actions.previous).toHaveBeenCalledOnce();
    // Resuming waits for the music: iOS lets the app start it only while the intent runs.
    await expect(runIntent('resume', {}, deps)).resolves.toMatchObject({ wait: 'playback' });
    expect(actions.play).toHaveBeenCalledOnce();
  });

  it('turns down what it does not know', async () => {
    await expect(runIntent('rewind', {}, setup().deps)).rejects.toThrow(intentText.unknown);
  });
});

describe('playing something', () => {
  it('plays an album in order, or shuffled, with its context', async () => {
    const detail = { ...album('a1'), discs: [{ number: 1, title: null, tracks: [track('t1'), track('t2')] }] } as unknown as AlbumDetail;
    const { deps, actions } = setup({ catalog: { album: vi.fn(async () => detail) } });
    await expect(runIntent('play', { item: { id: 'album:a1', kind: 'album', title: 'Album a1' }, shuffle: true }, deps)).resolves.toMatchObject({ wait: 'playback' });
    expect(actions.playTracks).toHaveBeenCalledWith([track('t1'), track('t2')], { shuffle: true, context: { type: 'album', id: 'a1', title: 'Album a1' } });
    expect(deps.prime).toHaveBeenCalledWith([track('t1'), track('t2')]);
  });

  it('plays all of Liked Songs, page after page', async () => {
    const likes = vi.fn(async (_type: string, query: { cursor?: string }) => (query.cursor ? page([track('t3')]) : page([track('t1'), track('t2')], 'next')));
    const { deps, actions } = setup({ userdata: { likes } });
    await runIntent('play', { item: { id: 'liked', kind: 'liked', title: 'Liked Songs' } }, deps);
    expect(actions.playTracks).toHaveBeenCalledWith([track('t1'), track('t2'), track('t3')], { shuffle: false, context: { type: 'liked', id: null, title: 'Liked Songs' } });
  });

  it('says so when nothing in it can play, and plays nothing', async () => {
    const detail = { ...album('a1'), discs: [{ number: 1, title: null, tracks: [track('t1', 'none')] }] } as unknown as AlbumDetail;
    const { deps, actions } = setup({ catalog: { album: vi.fn(async () => detail) } });
    await expect(runIntent('play', { item: { id: 'album:a1', kind: 'album', title: 'Album a1' } }, deps)).rejects.toThrow(intentText.unplayable('Album a1'));
    expect(actions.playTracks).not.toHaveBeenCalled();
  });

  it('plays an artist’s radio when there is one, else their top songs', async () => {
    const artist = { id: 'r1', name: 'Lumen Drift', radio: true, topTracks: [track('t1')] } as unknown as ArtistDetail;
    const radio = { tracks: [{ trackId: 't5', albumId: null, durationMs: 1 }], context: { type: 'radio', id: 'artist:r1', title: 'Lumen Drift' } };
    const { deps, actions } = setup({ catalog: { artist: vi.fn(async () => artist) }, radio: { artist: vi.fn(async () => radio) } });
    await runIntent('play', { item: { id: 'artist:r1', kind: 'artist', title: 'Lumen Drift' } }, deps);
    expect(actions.playRadio).toHaveBeenCalledWith(radio);

    const quiet = setup({ catalog: { artist: vi.fn(async () => ({ ...artist, radio: false })) } });
    await runIntent('play', { item: { id: 'artist:r1', kind: 'artist', title: 'Lumen Drift' } }, quiet.deps);
    expect(quiet.actions.playTracks).toHaveBeenCalledWith([track('t1')], { shuffle: false, context: { type: 'artist', id: 'r1', title: 'Lumen Drift' } });
  });

  it('starts a Jump back in radio again from its seed', async () => {
    const radio = { tracks: [{ trackId: 't5', albumId: null, durationMs: 1 }], context: { type: 'radio', id: 'track:t9', title: null } };
    const fromTrack = vi.fn(async () => radio);
    const { deps, actions } = setup({ radio: { track: fromTrack } });
    await runIntent('play', { item: { id: 'radio:track:t9', kind: 'radio', title: 'Halo Radio' } }, deps);
    expect(fromTrack).toHaveBeenCalledWith('t9');
    expect(actions.playRadio).toHaveBeenCalledWith(radio);
  });

  it('needs the server', async () => {
    const { deps } = setup({}, { offline: true });
    await expect(runIntent('play', { item: { id: 'liked', kind: 'liked', title: 'Liked Songs' } }, deps)).rejects.toThrow(intentText.offline);
    await expect(runIntent('play', { item: { id: 'x', kind: 'podcast', title: 'x' } }, setup().deps)).rejects.toThrow(intentText.notFound);
  });
});

describe('shuffling the library and starting a radio', () => {
  it('shuffles the library’s songs, stopping at the time budget with what it loaded', async () => {
    let clock = 0;
    const tracks = vi.fn(async (query: { cursor?: string }) => {
      clock += 3000;
      return query.cursor ? page([track('t2')], 'more') : page([track('t1')], 'next');
    });
    const { deps, actions } = setup({ catalog: { tracks } }, { now: () => clock, libraryBudgetMs: 5000 });
    await runIntent('shuffleLibrary', {}, deps);
    expect(tracks).toHaveBeenCalledTimes(2);
    expect(actions.playTracks).toHaveBeenCalledWith([track('t1'), track('t2')], { shuffle: true, context: { type: 'other', id: null, title: 'Songs' } });
  });

  it('starts a radio from the song playing, and says when nothing is', async () => {
    const radio = { tracks: [{ trackId: 't5', albumId: null, durationMs: 1 }], context: { type: 'radio', id: 'track:t1', title: null } };
    const { deps, actions } = setup({ radio: { track: vi.fn(async () => radio) } });
    await runIntent('radio', {}, deps);
    expect(actions.playRadio).toHaveBeenCalledWith(radio);
    await expect(runIntent('radio', {}, setup({}, { currentTrackId: () => null }).deps)).rejects.toThrow(intentText.nothingPlaying);
  });
});

describe('search for Shortcuts and Siri', () => {
  it('lists what plays from the library and the catalog, in Search’s order, with covers from the server', async () => {
    const library = vi.fn(async () => results({ albums: [album('a1')], tracks: [track('t1'), track('gray', 'none')] }));
    const catalog = vi.fn(async () => results({ albums: [album('far', 'none')] }));
    const { deps } = setup({ search: { library, catalog } });
    const items = await search('album', deps);
    expect(items.map(item => item.id).sort()).toEqual(['album:a1', 'track:t1']);
    expect(items.find(item => item.id === 'track:t1')).toEqual({ id: 'track:t1', kind: 'track', title: 'Song t1', subtitle: 'Song · Mira Vale' });
  });

  it('does not wait long for the catalog', async () => {
    vi.useFakeTimers();
    const library = vi.fn(async () => results({ albums: [album('a1')] }));
    const catalog = vi.fn(() => new Promise<SearchResults>(() => undefined));
    const { deps } = setup({ search: { library, catalog } });
    const found = search('album', deps);
    await vi.advanceTimersByTimeAsync(1200);
    await expect(found).resolves.toHaveLength(1);
    vi.useRealTimers();
  });

  it('answers nothing for an empty query, and that the server is unreachable when both searches fail', async () => {
    await expect(search('  ', setup().deps)).resolves.toEqual([]);
    const failing = vi.fn(async () => { throw new Error('down'); });
    await expect(search('x', setup({ search: { library: failing, catalog: failing } }).deps)).rejects.toThrow(intentText.offline);
  });
});

describe('donations to Siri', () => {
  it('names what the session played from, when an intent can play it again', () => {
    expect(donationFor({ type: 'album', id: 'a1', title: 'Harbor' })).toEqual({ id: 'album:a1', kind: 'album', title: 'Harbor' });
    expect(donationFor({ type: 'liked', id: null, title: 'Liked Songs' })).toMatchObject({ id: 'liked', kind: 'liked' });
    expect(donationFor({ type: 'radio', id: 'artist:r1', title: 'Lumen Drift' })).toEqual({ id: 'radio:artist:r1', kind: 'radio', title: 'Lumen Drift' });
    expect(donationFor({ type: 'search', id: null, title: 'halo' })).toBeNull();
    expect(donationFor({ type: 'radio', id: 'track:t1', title: null })).toBeNull();
    expect(donationFor(null)).toBeNull();
  });
});
