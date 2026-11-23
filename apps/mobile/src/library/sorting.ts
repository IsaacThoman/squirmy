import type { LibrarySort } from '@squirmy/contracts';

export const sortOptions = { 'Recently added': 'recent', Title: 'title', Artist: 'artist', Year: 'year' } as const satisfies Record<string, LibrarySort>;
export type SortName = keyof typeof sortOptions;
export type LibraryFilterName = 'All' | 'Playlists' | 'Albums' | 'Artists' | 'Songs';
/** The order last chosen under each filter. */
export type SortChoices = Partial<Record<LibraryFilterName, SortName>>;

const allSorts = Object.keys(sortOptions) as SortName[];

/**
 * The orders a library list can be shown in. Songs have no year (the server refuses that
 * order), artists are always listed by name, and playlists have no menu.
 */
export function sortsFor(filter: LibraryFilterName): SortName[] {
  switch (filter) {
    case 'Songs': return allSorts.filter(sort => sort !== 'Year');
    case 'Artists':
    case 'Playlists': return [];
    default: return allSorts;
  }
}

/**
 * The order a filter shows: the one last chosen under it, else recently added. Each filter
 * keeps its own, so choosing Year for Albums leaves Songs as it was.
 */
export function sortFor(filter: LibraryFilterName, chosen: SortChoices): SortName {
  const sort = chosen[filter];
  return sort && sortsFor(filter).includes(sort) ? sort : 'Recently added';
}
