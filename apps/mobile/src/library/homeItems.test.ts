import type { HomeItem, MixSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { pinTarget } from './collectionMenu';
import type { Page } from './links';
import { homeItemCollection } from './collections';

const link = (page: Page, id: string) => `/${page}/${id}`;
const art = { id: '00000000-0000-4000-8000-000000000001', color: null, thumbhash: null };
const mix: MixSummary = {
  id: '00000000-0000-4000-8600-000000000001', name: 'Mix 1 · Indie Folk', description: 'Mara Quell and Willow Hart',
  artworks: [art], trackCount: 30, durationMs: 6_000_000, generatedAt: '2026-11-28T05:00:00.000Z',
};

describe('Home items as tiles', () => {
  it('opens a mix as a page of its songs, with its covers', () => {
    const tile = homeItemCollection({ kind: 'mix', mix }, link)!;
    expect(tile).toMatchObject({ kind: 'mix', title: 'Mix 1 · Indie Folk', subtitle: 'Mara Quell and Willow Hart', href: `/songs/mix~${mix.id}`, artworks: [art] });
    // A mix changes every day: nothing to pin.
    expect(pinTarget(tile)).toBeNull();
  });

  it('opens an artist radio at the artist, and a song radio at its album', () => {
    const artist = homeItemCollection({ kind: 'radio', radio: { seed: 'artist', id: 'a1', title: 'Neon Harbor', subtitle: null, albumId: null, artwork: art } }, link)!;
    expect(artist).toMatchObject({ title: 'Neon Harbor Radio', subtitle: 'Radio', href: '/artist/a1', round: true, artwork: art });
    const song = homeItemCollection({ kind: 'radio', radio: { seed: 'track', id: 't1', title: 'Halo', subtitle: 'Lumen Drift', albumId: 'al1', artwork: null } }, link)!;
    expect(song).toMatchObject({ title: 'Halo Radio', subtitle: 'Radio · Lumen Drift', href: '/album/al1', special: 'radio' });
    expect(pinTarget(song)).toBeNull();
  });

  it('draws Liked Songs as the Library does, and skips a kind from a newer server', () => {
    expect(homeItemCollection({ kind: 'liked' }, link)).toMatchObject({ kind: 'liked', href: '/playlist/liked' });
    expect(homeItemCollection({ kind: 'podcast' } as unknown as HomeItem, link)).toBeNull();
  });
});
