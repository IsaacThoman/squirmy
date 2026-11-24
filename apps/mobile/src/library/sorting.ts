import type { LibraryItemsSort } from '@squirmy/contracts';

export const sortOptions = {
  'Recently played': 'played', 'Recently added': 'recent', Title: 'title', Artist: 'artist', Year: 'year',
} as const satisfies Record<string, LibraryItemsSort>;
export type SortName = keyof typeof sortOptions;
export const sortNames = Object.keys(sortOptions) as SortName[];
export const defaultSort: SortName = 'Recently played';
