import type { AlbumDetail } from '@squirmy/contracts';

export type AlbumLibraryButton = {
  icon: string;
  label: string;
  selected: boolean;
  /** `add` and `remove` change the user's library; `none` explains that a collection album always stays. */
  action: 'add' | 'remove' | 'none';
};

/**
 * The library button on an album page: a plus to add it, a check to remove what the user
 * added, and for an album on the server's own collection a check that removes nothing (it
 * is everyone's). Null when the server does not say (an older server) or the phone is offline.
 * `saved` is what the user just did here, ahead of the server's answer.
 */
export function albumLibraryButton(album: Pick<AlbumDetail, 'title' | 'library'>, saved: boolean | undefined, offline: boolean): AlbumLibraryButton | null {
  if (album.library === undefined || offline) return null;
  if (album.library === 'collection') return { icon: 'checkmark', label: 'On this server', selected: true, action: 'none' };
  const inLibrary = saved ?? album.library === 'saved';
  return inLibrary
    ? { icon: 'checkmark', label: `Remove ${album.title} from library`, selected: true, action: 'remove' }
    : { icon: 'plus', label: `Add ${album.title} to library`, selected: false, action: 'add' };
}
