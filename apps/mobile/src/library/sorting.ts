import type { LibrarySort } from '@squirmy/contracts';

export const sortOptions = { 'Recently added': 'recent', Title: 'title', Artist: 'artist', Year: 'year' } as const satisfies Record<string, LibrarySort>;
export type SortName = keyof typeof sortOptions;

const allSorts = Object.keys(sortOptions) as SortName[];

/**
 * The orders a library list can be shown in. Songs have no year (the server refuses that
 * order), artists are always listed by name, and playlists have no menu.
 */
export function sortsFor(filter: 'All' | 'Playlists' | 'Albums' | 'Artists' | 'Songs'): SortName[] {
  switch (filter) {
    case 'Songs': return allSorts.filter(sort => sort !== 'Year');
    case 'Artists':
    case 'Playlists': return [];
    default: return allSorts;
  }
}

/** The chosen order where the list offers it, else the default: the choice is kept for when it applies again. */
export function sortFor(filter: Parameters<typeof sortsFor>[0], chosen: SortName): SortName {
  return sortsFor(filter).includes(chosen) ? chosen : 'Recently added';
}
