import { chunk, type SongRowItem } from './rows';
import type { Collection } from './shared';

/** A row of the Library's list: a song, a row of tiles, a list row, or the heading over the songs. */
export type LibraryRow =
  | { kind: 'song'; key: string; song: SongRowItem }
  | { kind: 'tiles'; key: string; items: readonly Collection[] }
  | { kind: 'row'; key: string; item: Collection }
  | { kind: 'heading'; key: string; title: string };

/**
 * Show collections in the selected layout, with matching songs under their own heading.
 */
export function libraryRows({ mode, items, songs, columns }: {
  mode: 'grid' | 'list'; items: readonly Collection[]; songs: readonly SongRowItem[]; columns: number;
}): LibraryRow[] {
  const songRows = songs.map((song): LibraryRow => ({ kind: 'song', key: song.key, song }));
  const collections = (list: readonly Collection[]) => mode === 'grid'
    ? chunk(list, columns).map((row): LibraryRow => ({ kind: 'tiles', key: row[0]!.key, items: row }))
    : list.map((item): LibraryRow => ({ kind: 'row', key: item.key, item }));
  return [
    ...collections(items),
    ...(songRows.length ? [{ kind: 'heading' as const, key: 'heading:songs', title: 'Songs' }, ...songRows] : []),
  ];
}
