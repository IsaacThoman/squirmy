import type { LibraryItemsSort } from '@squirmy/contracts';

export const sortOptions = {
  'Recently played': 'played', 'Recently added': 'recent', Title: 'title', Artist: 'artist', Year: 'year',
} as const satisfies Record<string, LibraryItemsSort>;
export type SortName = keyof typeof sortOptions;
export type LibraryFilterName = 'All' | 'Playlists' | 'Albums' | 'Artists' | 'Songs';
/** The order last chosen under each filter, for as long as the screen is open: it is not stored. */
export type SortChoices = Partial<Record<LibraryFilterName, SortName>>;

const listSorts: SortName[] = ['Recently added', 'Title', 'Artist', 'Year'];

/**
 * The orders a library list can be shown in. All alone has recently played (what was played
 * is a collection: an album, artist or playlist). Songs have no year (the server refuses that
 * order), artists are always listed by name, and playlists have no menu.
 */
export function sortsFor(filter: LibraryFilterName): SortName[] {
  switch (filter) {
    case 'All': return ['Recently played', ...listSorts];
    case 'Songs': return listSorts.filter(sort => sort !== 'Year');
    case 'Artists':
    case 'Playlists': return [];
    default: return listSorts;
  }
}

/**
 * The order a filter shows: the one last chosen under it, else recently played for All and
 * recently added for the rest. Each filter keeps its own, so choosing Year for Albums leaves Songs as it was.
 */
export function sortFor(filter: LibraryFilterName, chosen: SortChoices): SortName {
  const sort = chosen[filter];
  if (sort && sortsFor(filter).includes(sort)) return sort;
  return filter === 'All' ? 'Recently played' : 'Recently added';
}

/** The order of a list other than All, which never has recently played. */
export const listSort = (sort: LibraryItemsSort) => (sort === 'played' ? 'recent' : sort);
