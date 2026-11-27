import { plural } from '@squirmy/client-core';
import type { LibrarySort } from '@squirmy/contracts';
import { sortNames, sortOptions, type SortName } from '../../library/sorting';

/**
 * The Library's categories, listed down its left side as the system's music app lists its own:
 * All (the phone's Library: everything saved, the pins first), then one kind at a time as on
 * web, the server's music, and the library's genres.
 */
export type CategoryId = 'all' | 'playlists' | 'artists' | 'albums' | 'songs' | 'server' | `genre:${string}`;

export type Category = { id: CategoryId; title: string; icon: string };

export const categories: readonly Category[] = [
  { id: 'all', title: 'All', icon: 'square.stack' },
  { id: 'playlists', title: 'Playlists', icon: 'music.note.list' },
  { id: 'artists', title: 'Artists', icon: 'music.mic' },
  { id: 'albums', title: 'Albums', icon: 'square.stack.fill' },
  { id: 'songs', title: 'Songs', icon: 'music.note' },
];

export const serverCategory: Category = { id: 'server', title: 'On this server', icon: 'music.note.house' };

export const genreCategory = (name: string): Category => ({ id: `genre:${name}`, title: name, icon: 'guitars' });

export const genreOf = (id: CategoryId): string | null => (id.startsWith('genre:') ? id.slice('genre:'.length) : null);

/**
 * The orders a category can be shown in, in the phone's words. All alone has Recently played
 * (what is played is a collection); songs have no year, which the server refuses; artists and
 * genres are listed by name, and playlists in the server's order, as on web.
 */
export function categorySorts(id: CategoryId): SortName[] {
  switch (id) {
    case 'all': return sortNames;
    case 'albums':
    case 'server': return sortNames.filter(name => name !== 'Recently played');
    case 'songs': return sortNames.filter(name => name !== 'Recently played' && name !== 'Year');
    default: return [];
  }
}

/** The order a category opens in: recently played for All, recently added for the rest. */
export const defaultCategorySort = (id: CategoryId): SortName => (id === 'all' ? 'Recently played' : 'Recently added');

/** The order chosen for a category, where it offers it; otherwise its own default. */
export function categorySort(id: CategoryId, chosen: SortName | undefined): SortName {
  return chosen && categorySorts(id).includes(chosen) ? chosen : defaultCategorySort(id);
}

/** The server's name of a sort, for the lists that have no Recently played. */
export function listSort(name: SortName): LibrarySort {
  const sort = sortOptions[name];
  return sort === 'played' ? 'recent' : sort;
}

/** "12 albums", or "60+ albums" for a list with more pages still to load, whose count would undercount. */
export function countLabel(count: number, complete: boolean, one: string, many?: string): string {
  if (!complete) return `${count.toLocaleString()}+ ${many ?? `${one}s`}`;
  return plural(count, one, many);
}
