import type { AlbumSummary, HomeSection } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { homeLayout } from './home';

const album = (id: string) => ({ id, title: id }) as unknown as AlbumSummary;
const rail = (id: string, ...ids: string[]): HomeSection => ({ kind: 'albums', id, title: id, albums: ids.map(album) });
const playlists: HomeSection = { kind: 'playlists', id: 'playlists', title: 'Playlists', playlists: [] };
const ids = (sections: HomeSection[]) => sections.map(section => section.kind === 'albums' ? `${section.id}:${section.albums.map(a => a.id).join(',')}` : section.id);

describe('homeLayout', () => {
  it('takes the hero out of its rail and keeps the server’s order', () => {
    const sections = [rail('recently-played', 'a', 'b'), playlists, rail('recently-added', 'a', 'c')];
    const { hero, sections: shown } = homeLayout(sections, () => true);
    expect(hero?.id).toBe('a');
    expect(ids(shown)).toEqual(['recently-played:b', 'playlists', 'recently-added:a,c']);
  });

  it('skips albums that do not play, and falls back to Recently added', () => {
    const playable = (item: AlbumSummary) => item.id !== 'x';
    expect(homeLayout([rail('recently-played', 'x', 'b')], playable).hero?.id).toBe('b');
    const { hero, sections } = homeLayout([rail('recently-played', 'x'), rail('recently-added', 'c', 'd')], playable);
    expect(hero?.id).toBe('c');
    expect(ids(sections)).toEqual(['recently-played:x', 'recently-added:d']);
  });

  it('drops a rail that held only the hero', () => {
    const { sections } = homeLayout([rail('recently-played', 'a'), playlists], () => true);
    expect(ids(sections)).toEqual(['playlists']);
  });

  it('leaves Home alone without a hero', () => {
    const sections = [playlists, rail('recently-added', 'x')];
    expect(homeLayout(sections, () => false)).toEqual({ hero: undefined, sections });
  });
});
