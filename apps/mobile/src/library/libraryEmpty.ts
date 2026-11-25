import type { AlbumSummary, LibraryItem } from '@squirmy/contracts';

/**
 * What an empty Library says. The library is what this user hearted (their uploads are
 * hearted for them), not the server's music unless they include it in Settings, and not
 * everything that was ever played, so it starts out with Liked Songs alone. The server's
 * music is On this server (Home's New on this server and its See all); Recently played and
 * Most played carry what they listened to. Worded as web's, which also points at the heart.
 */
export const emptyLibrary = {
  icon: 'square.stack', title: 'Add music to your library',
  description: 'Albums and songs you save show up here, with the music you upload. Find something you love on this server or in Search, and tap the heart.',
} as const;

/** What On this server says before the server has any music, as on web. */
export const emptyServer = {
  icon: 'music.note.house', title: 'Nothing on this server yet',
  description: 'Music scanned from the server’s folders, uploaded or dropped in its inbox shows up here.',
} as const;

/**
 * Whether a list read to its end has nothing to show: the Library when it holds only Liked
 * Songs (which the server always lists, even for a new library), On this server when the
 * server has no album.
 */
export function listsNothing(list: { server: true; items: readonly AlbumSummary[] } | { server: false; items: readonly LibraryItem[] }): boolean {
  return list.server ? list.items.length === 0 : list.items.every(item => item.kind === 'liked');
}
