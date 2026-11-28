import type { AlbumSummary, HomeResponse, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { recentItems, snapshotKey, surfaceSnapshot, type SnapshotInput } from './snapshot';

const art = (n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, color: '#7862b4', thumbhash: null });
const album = (id: string, artwork = art(1)): AlbumSummary => ({
  id, mbid: null, title: `Album ${id}`, artistCredit: 'Mira Vale', artists: [], year: null, type: 'album', artwork, availability: 'full',
  trackCount: 10, ownedTrackCount: 10,
});
const track: TrackSummary = {
  id: 't1', mbid: null, title: 'Low Tide', artistCredit: 'Mira Vale', artists: [], durationMs: 200_000,
  album: { id: 'a1', title: 'Harbor', artwork: art(2) } as TrackSummary['album'], disc: null, position: null,
  availability: 'server', liked: false, explicit: null, hasLyrics: false,
};
const home: HomeResponse = {
  sections: [
    { kind: 'albums', id: 'new', title: 'New on this server', albums: [album('x')] },
    {
      kind: 'items', id: 'jump-back-in', title: 'Jump back in', items: [
        { kind: 'liked' },
        { kind: 'album', album: album('a1') },
        { kind: 'artist', artist: { id: 'r1', mbid: null, name: 'Lumen Drift', image: art(3), inLibrary: true } },
        { kind: 'playlist', playlist: {
          id: 'p1', name: 'Night Drive', description: null, ownerId: 'me', ownerName: 'Sam', isPublic: false, trackCount: 3, durationMs: 1,
          artworks: [art(4), art(5)], updatedAt: '2026-11-01T00:00:00.000Z',
        } },
        { kind: 'radio', radio: { seed: 'track', id: 't9', title: 'Halo', subtitle: 'Lumen Drift', albumId: 'a9', artwork: null } },
      ],
    },
  ],
};

const input = (parts: Partial<SnapshotInput> = {}): SnapshotInput => ({
  signedIn: true,
  serverUrl: 'https://music.example.com',
  now: 1_000_000,
  playing: { current: { trackId: 't1', durationMs: 0 }, track, playing: true, positionMs: 30_000, device: null },
  home,
  keptArtwork: () => null,
  ...parts,
});

describe('the widgets’ snapshot', () => {
  it('shows the song playing with its cover, fetched from the server unless the phone keeps it', () => {
    const { snapshot, artwork } = surfaceSnapshot(input({ keptArtwork: id => id === art(2).id ? 'file:///downloads/cover.jpg' : null }));
    expect(snapshot.nowPlaying).toEqual({
      title: 'Low Tide', artist: 'Mira Vale', album: 'Harbor', artwork: `${art(2).id}.jpg`, color: '#7862b4',
      playing: true, positionMs: 30_000, anchorAt: 1_000_000, durationMs: 200_000,
    });
    expect(artwork[`${art(2).id}.jpg`]).toBe('file:///downloads/cover.jpg');
    expect(artwork[`${art(1).id}.jpg`]).toBe(`https://music.example.com/api/v1/art/${art(1).id}/600.webp`);
  });

  it('names the device playing while this phone is a remote', () => {
    const { snapshot } = surfaceSnapshot(input({ playing: { current: { trackId: 't1', durationMs: 201_000 }, track, playing: false, positionMs: 5, device: 'Living Room TV' } }));
    expect(snapshot.nowPlaying).toMatchObject({ device: 'Living Room TV', playing: false, durationMs: 201_000 });
  });

  it('has nothing playing until the song’s details are in', () => {
    expect(surfaceSnapshot(input({ playing: { current: { trackId: 't1', durationMs: 1 }, track: undefined, playing: true, positionMs: 0, device: null } })).snapshot.nowPlaying).toBeNull();
  });

  it('keeps nothing of the account once it signs out', () => {
    const { snapshot, artwork } = surfaceSnapshot(input({ signedIn: false }));
    expect(snapshot).toMatchObject({ signedIn: false, nowPlaying: null, recent: [] });
    expect(artwork).toEqual({});
  });
});

describe('Jump back in for the widget', () => {
  it('takes Home’s Jump back in, each opening its page, a playlist with its first cover', () => {
    expect(recentItems(home).map(({ id, link, title, art }) => ({ id, link, title, art: art?.id ?? null }))).toEqual([
      { id: 'liked', link: 'playlist/liked', title: 'Liked Songs', art: null },
      { id: 'album:a1', link: 'album/a1', title: 'Album a1', art: art(1).id },
      { id: 'artist:r1', link: 'artist/r1', title: 'Lumen Drift', art: art(3).id },
      { id: 'playlist:p1', link: 'playlist/p1', title: 'Night Drive', art: art(4).id },
      { id: 'radio:track:t9', link: 'album/a9', title: 'Halo Radio', art: null },
    ]);
  });

  it('is empty before Home has loaded, and holds a large widget’s worth', () => {
    expect(recentItems(undefined)).toEqual([]);
    const many: HomeResponse = { sections: [{ kind: 'items', id: 'jump-back-in', title: 'Jump back in', items: Array.from({ length: 12 }, (_, n) => ({ kind: 'album', album: album(`a${n}`) })) }] };
    expect(recentItems(many)).toHaveLength(8);
  });
});

describe('snapshotKey', () => {
  it('stays the same while a song plays on, and changes for a seek, a pause or another song', () => {
    const later = (positionMs: number, now: number, playing = true) => snapshotKey(surfaceSnapshot(input({
      now, playing: { current: { trackId: 't1', durationMs: 0 }, track, playing, positionMs, device: null },
    })));
    const first = later(30_000, 1_000_000);
    expect(later(40_000, 1_010_000)).toBe(first);
    expect(later(90_000, 1_010_000)).not.toBe(first);
    expect(later(40_000, 1_010_000, false)).not.toBe(first);
    expect(snapshotKey(surfaceSnapshot(input({ playing: { current: { trackId: 't2', durationMs: 0 }, track: { ...track, id: 't2', title: 'Halo' }, playing: true, positionMs: 30_000, device: null } })))).not.toBe(first);
  });
});
