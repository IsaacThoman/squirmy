import type { TrackSummary } from '@squirmy/contracts';
import { useMemo, useRef, type ReactElement } from 'react';
import type { SongListProps } from './SongList';

/** One row of a song list. It holds no callbacks, so a row redraws only when its own data changes. */
export type SongRowItem = {
  key: string;
  track: TrackSummary;
  /** Its index in the list's `tracks`. */
  index: number;
  /** The position shown instead of the cover, in a numbered list. */
  number?: number;
  /** The playlist the row is an item of, when it can be edited. */
  playlist?: { id: string; itemId: string };
};

/** What a row does when pressed. One object per list, which never changes, so no row redraws for it. */
export type SongRowHandlers = {
  play: (index: number) => void;
  menu: (track: TrackSummary, index: number) => void;
  remove: (itemId: string) => void;
};

/** The rows of a long list, for a virtualized list (`FlatList`) to render. */
export type SongListItems = {
  data: readonly SongRowItem[];
  renderItem: (info: { item: SongRowItem }) => ReactElement;
  keyExtractor: (item: SongRowItem) => string;
  rowHeight: number;
};

export function songRows({ tracks, numbered, playlist }: Pick<SongListProps, 'tracks' | 'numbered' | 'playlist'>): SongRowItem[] {
  return tracks.map((track, index) => {
    const itemId = playlist?.itemIds[index];
    return {
      key: itemId ?? `${track.id}:${index}`,
      track,
      index,
      number: numbered ? track.position ?? index + 1 : undefined,
      playlist: playlist && itemId ? { id: playlist.id, itemId } : undefined,
    };
  });
}

export const songRowKey = (row: SongRowItem) => row.key;

/** Stable handlers that always reach the latest props. */
export function useSongRowHandlers({ onPlay, onTrackMenu, playlist }: Pick<SongListProps, 'onPlay' | 'onTrackMenu' | 'playlist'>): SongRowHandlers {
  const latest = useRef({ onPlay, onTrackMenu, playlist });
  latest.current = { onPlay, onTrackMenu, playlist };
  return useMemo(() => ({
    play: index => latest.current.onPlay(index),
    menu: (track, index) => latest.current.onTrackMenu(track, index),
    remove: itemId => latest.current.playlist?.onRemove(itemId),
  }), []);
}

/** `items` in consecutive groups of `size`, the last one possibly shorter: the rows of a grid. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += size) groups.push(items.slice(start, start + size));
  return groups;
}

/** Whether two rows show the same thing. */
export function sameRow(a: SongRowItem, b: SongRowItem) {
  return a === b || (a.key === b.key && a.track === b.track && a.index === b.index && a.number === b.number
    && a.playlist?.itemId === b.playlist?.itemId && a.playlist?.id === b.playlist?.id);
}
