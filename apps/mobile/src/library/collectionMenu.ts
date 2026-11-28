import { albumPresentation, type Viewer } from '@squirmy/client-core';
import { LIKED_SONGS_ID, type LibraryPinKind } from '@squirmy/contracts';
import type { Href } from 'expo-router';
import { albumActions } from './albumActions';
import type { RowAction } from './BrowseControls';
import type { Collection } from './shared';

/** What a collection's menu runs; `open` pushes a page of the tab, `pin` pins or unpins it. */
export type CollectionRunners = {
  playAlbum: (albumId: string, shuffle: boolean) => void;
  /** Loads the album's songs when they are not cached, then queues what plays. */
  enqueueAlbum: (item: Collection, placement: 'next' | 'last') => void;
  /** Opens the add-to-playlist sheet for the whole album. */
  addAlbumToPlaylist: (albumId: string) => void;
  open: (href: Href) => void;
  pin: (item: Collection, pinned: boolean) => void;
};

/** An album tile on an artist's page: its menu goes to the album's other artists only. */
export function besideArtist(collection: Collection, artistId: string): Collection {
  const artists = collection.artists?.filter(artist => artist.id !== artistId);
  return artists && artists.length !== collection.artists?.length ? { ...collection, artists, otherArtists: true } : collection;
}

/** The kind and id that pin a collection to the top of the Library (`PUT /me/pins/:kind/:id`); null for what cannot be pinned. */
export function pinTarget(item: Collection): [LibraryPinKind, string] | null {
  switch (item.kind) {
    case 'liked': return ['liked', LIKED_SONGS_ID];
    case 'recent':
    case 'mix':
    case 'radio': return null;
    default: return [item.kind, item.key];
  }
}

/**
 * The menu of a tile: an album has its page's menu (`albumActions`) but for saving, as its
 * row in Search does; anything else opens. Saving and downloading stay on the pages, which
 * show their state, and so does an artist's radio. In the Library, where it is known whether an item is
 * pinned, Pin or Unpin ends the menu. Offline only what opens a page is offered.
 */
export function collectionActions(item: Collection, context: { offline: boolean; viewer: Viewer | null | undefined }, run: CollectionRunners): RowAction[] {
  const actions = ownActions(item, context, run);
  if (item.pinned === undefined || context.offline || !pinTarget(item)) return actions;
  const pinned = item.pinned;
  return [...actions, pinned
    ? { title: 'Unpin', icon: 'pin.slash', onPress: () => run.pin(item, false) }
    : { title: 'Pin to top', icon: 'pin', onPress: () => run.pin(item, true) }];
}

function ownActions(item: Collection, { offline, viewer }: { offline: boolean; viewer: Viewer | null | undefined }, run: CollectionRunners): RowAction[] {
  const open = { title: 'Open', icon: 'music.note.list', onPress: () => run.open(item.href) };
  if (item.kind === 'album') {
    const plays = !offline && !item.dim && (!item.availability || albumPresentation({ availability: item.availability }, viewer) === 'normal');
    const artists = item.artists ?? [];
    const entries = albumActions({ plays, offline, artists, named: item.otherArtists }, {
      play: shuffle => run.playAlbum(item.key, shuffle),
      enqueue: placement => run.enqueueAlbum(item, placement),
      addToPlaylist: () => run.addAlbumToPlaylist(item.key),
      goToArtist: index => run.open(artists[index]!.href),
    });
    return entries.length ? entries : [open];
  }
  return [open];
}
