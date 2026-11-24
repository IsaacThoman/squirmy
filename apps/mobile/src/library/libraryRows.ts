import { chunk, type SongRowItem } from './rows';
import type { Collection } from './shared';

/** A row of the Library's list: a song, a row of tiles, a list row, or the heading over the songs. */
export type LibraryRow =
  | { kind: 'song'; key: string; song: SongRowItem }
  | { kind: 'tiles'; key: string; items: readonly Collection[] }
  | { kind: 'row'; key: string; item: Collection }
  | { kind: 'heading'; key: string; title: string };

/**
 * The Library's rows. Under Songs they are the songs. Otherwise they are the collections, as
 * tiles or rows (All's artists among them, in its order), and songs given there (All, while
 * searching) follow under a Songs heading, so a search that names a song finds it rather
 * than reading "Nothing found".
 */
export function libraryRows({ mode, items, songs, columns }: {
  mode: 'songs' | 'grid' | 'list'; items: readonly Collection[]; songs: readonly SongRowItem[]; columns: number;
}): LibraryRow[] {
  const songRows = songs.map((song): LibraryRow => ({ kind: 'song', key: song.key, song }));
  if (mode === 'songs') return songRows;
  const collections = (list: readonly Collection[]) => mode === 'grid'
    ? chunk(list, columns).map((row): LibraryRow => ({ kind: 'tiles', key: row[0]!.key, items: row }))
    : list.map((item): LibraryRow => ({ kind: 'row', key: item.key, item }));
  return [
    ...collections(items),
    ...(songRows.length ? [{ kind: 'heading' as const, key: 'heading:songs', title: 'Songs' }, ...songRows] : []),
  ];
}
