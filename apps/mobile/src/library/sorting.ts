import type { LibraryItemsSort, LibrarySort } from '@squirmy/contracts';

export const sortOptions = {
  'Recently played': 'played', 'Recently added': 'recent', Title: 'title', Artist: 'artist', Year: 'year',
} as const satisfies Record<string, LibraryItemsSort>;
export type SortName = keyof typeof sortOptions;
export const sortNames = Object.keys(sortOptions) as SortName[];
export const defaultSort: SortName = 'Recently played';

/**
 * The server's albums (On this server) sort as the album lists do: no one's plays order them,
 * so they open newest first, as Home's New on this server does.
 */
export type ServerSortName = Exclude<SortName, 'Recently played'>;
export const serverSortNames = sortNames.filter((name): name is ServerSortName => sortOptions[name] !== 'played');
export const serverDefaultSort: ServerSortName = 'Recently added';
export const serverSort = (name: ServerSortName): LibrarySort => sortOptions[name];
