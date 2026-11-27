import { searchItemKey, type SearchItem } from '@squirmy/client-core';
import { chunk } from '../../library/rows';

/** Results across, as the system's music app lays them out under its keyboard. */
export const resultColumns = 3;
/** Genre tiles across. */
export const genreColumns = 4;

/** A row of Search's list: a heading, a row of result cards, or a row of genre tiles. */
export type SearchRow =
  | { kind: 'heading'; key: string; title: string; clear?: boolean }
  | { kind: 'results'; key: string; items: readonly SearchItem[] }
  | { kind: 'genres'; key: string; names: readonly string[]; start: number };

/**
 * What Search lists under its field. For a search: its results as cards, a row at a time, under
 * the heading of the filter. Before one: the results viewed lately, with Clear, then genres to
 * browse.
 */
export function searchRows({ active, title, items, recents, genres }: {
  active: boolean;
  /** The heading over the results. */
  title: string;
  items: readonly SearchItem[];
  recents: readonly SearchItem[];
  genres: readonly string[];
}): SearchRow[] {
  const cards = (list: readonly SearchItem[], prefix: string) => chunk(list, resultColumns)
    .map((row): SearchRow => ({ kind: 'results', key: `${prefix}:${searchItemKey(row[0]!)}`, items: row }));
  if (active) return items.length ? [{ kind: 'heading', key: 'h:results', title }, ...cards(items, 'r')] : [];
  return [
    ...(recents.length ? [{ kind: 'heading' as const, key: 'h:recent', title: 'Recently viewed', clear: true }, ...cards(recents, 'v')] : []),
    ...(genres.length ? [
      { kind: 'heading' as const, key: 'h:genres', title: 'Browse by genre' },
      ...chunk(genres, genreColumns).map((names, index): SearchRow => ({ kind: 'genres', key: `g:${names[0]}`, names, start: index * genreColumns })),
    ] : []),
  ];
}
