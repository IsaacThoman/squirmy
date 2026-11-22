import type { AlbumSummary, HomeSection } from '@squirmy/contracts';

type AlbumSection = Extract<HomeSection, { kind: 'albums' }>;

/**
 * Home as drawn: the hero (the first album that plays from Recently played, else from
 * Recently added) and the sections in the order the server sent them. The hero is left out
 * of the rail it came from, which would otherwise open with the same cover right under it;
 * a rail that held only the hero goes too.
 */
export function homeLayout(
  sections: readonly HomeSection[], playable: (album: AlbumSummary) => boolean,
): { hero: AlbumSummary | undefined; sections: HomeSection[] } {
  const albums = (id: string) => sections.find((section): section is AlbumSection => section.kind === 'albums' && section.id === id);
  const source = [albums('recently-played'), albums('recently-added')].find(section => section?.albums.some(playable));
  const hero = source?.albums.find(playable);
  if (!source || !hero) return { hero: undefined, sections: [...sections] };
  return {
    hero,
    sections: sections.flatMap(section => {
      if (section !== source) return [section];
      const rest = source.albums.filter(album => album.id !== hero.id);
      return rest.length ? [{ ...source, albums: rest }] : [];
    }),
  };
}
