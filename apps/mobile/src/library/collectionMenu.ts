import { albumPresentation, type Viewer } from '@squirmy/client-core';
import type { Href } from 'expo-router';
import type { RowAction } from './BrowseControls';
import type { Collection } from './shared';

/** What a collection's menu runs; `open` pushes a page of the tab. */
export type CollectionRunners = {
  playAlbum: (albumId: string, shuffle: boolean) => void;
  open: (href: Href) => void;
};

/**
 * The menu of a tile: an album plays, shuffles and goes to its artists, as its row in Search
 * does; anything else opens. Saving and downloading stay on the pages, which show their
 * state, and so does an artist's radio. Offline only what opens a page is offered.
 */
export function collectionActions(item: Collection, { offline, viewer }: { offline: boolean; viewer: Viewer | null | undefined }, run: CollectionRunners): RowAction[] {
  const open = { title: 'Open', icon: 'music.note.list', onPress: () => run.open(item.href) };
  if (item.kind === 'album') {
    const plays = !offline && !item.dim && (!item.availability || albumPresentation({ availability: item.availability }, viewer) === 'normal');
    const artists = item.artists ?? [];
    const entries: RowAction[] = [
      ...(plays ? [
        { title: 'Play', icon: 'play', onPress: () => run.playAlbum(item.key, false) },
        { title: 'Shuffle', icon: 'shuffle', onPress: () => run.playAlbum(item.key, true) },
      ] : []),
      ...artists.map(artist => ({ title: artists.length > 1 ? `Go to ${artist.name}` : 'Go to artist', icon: 'music.mic', onPress: () => run.open(artist.href) })),
    ];
    return entries.length ? entries : [open];
  }
  return [open];
}
