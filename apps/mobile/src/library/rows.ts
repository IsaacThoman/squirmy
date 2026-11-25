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
  /** Whether the row names the song's artist: not on an album page, where it is the album's artist. */
  showArtist: boolean;
  /** The album whose page the row is on. */
  album?: string;
  /** Said before the artist, where songs are listed among other kinds ("Song · MGMT"). */
  kind?: string;
  /** Pressed while it can't play, the row opens the song's album (`SongListProps.onUnavailable`). */
  opens?: boolean;
};

/** What a row does when pressed. One object per list, which never changes, so no row redraws for it. */
export type SongRowHandlers = {
  play: (index: number) => void;
  unavailable: (index: number) => void;
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

export function songRows({ tracks, numbered, playlist, album, kind, opens = false }: Pick<SongListProps, 'tracks' | 'numbered' | 'playlist' | 'album' | 'kind'> & {
  /** The list has `onUnavailable`. */
  opens?: boolean;
}): SongRowItem[] {
  return tracks.map((track, index) => {
    const itemId = playlist?.itemIds[index];
    return {
      key: itemId ?? `${track.id}:${index}`,
      track,
      index,
      number: numbered ? track.position ?? index + 1 : undefined,
      playlist: playlist && itemId ? { id: playlist.id, itemId } : undefined,
      // On an album page only a song by someone else (a feature, a various-artists album) says who.
      showArtist: !album || track.artistCredit !== album.artistCredit,
      album: album?.id,
      kind,
      opens: opens && Boolean(track.album),
    };
  });
}

export const songRowKey = (row: SongRowItem) => row.key;

/**
 * Stable handlers that always reach the latest props. Pressing the song that is playing (or
 * paused) pauses or resumes it, as on the web, rather than starting it over: `toggleIfCurrent`
 * is the playback action of that name, which says whether it did.
 */
export function useSongRowHandlers(
  { tracks, onPlay, onUnavailable, onTrackMenu, playlist }: Pick<SongListProps, 'tracks' | 'onPlay' | 'onUnavailable' | 'onTrackMenu' | 'playlist'>,
  toggleIfCurrent: (trackId: string) => boolean,
): SongRowHandlers {
  const latest = useRef({ tracks, onPlay, onUnavailable, onTrackMenu, playlist, toggleIfCurrent });
  latest.current = { tracks, onPlay, onUnavailable, onTrackMenu, playlist, toggleIfCurrent };
  return useMemo(() => ({
    play: index => {
      const track = latest.current.tracks[index];
      if (track && latest.current.toggleIfCurrent(track.id)) return;
      latest.current.onPlay(index);
    },
    unavailable: index => latest.current.onUnavailable?.(index),
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

/** What pressing a playable row does, for VoiceOver: the current song pauses or resumes. */
export function pressVerb(current: 'playing' | 'paused' | null): string {
  return current === 'playing' ? 'Pause' : current === 'paused' ? 'Resume' : 'Play';
}

/** Whether two rows show the same thing. */
export function sameRow(a: SongRowItem, b: SongRowItem) {
  return a === b || (a.key === b.key && a.track === b.track && a.index === b.index && a.number === b.number
    && a.playlist?.itemId === b.playlist?.itemId && a.playlist?.id === b.playlist?.id && a.showArtist === b.showArtist && a.album === b.album && a.kind === b.kind
    && a.opens === b.opens);
}
