import type { PlaylistSummary } from '@squirmy/contracts';
import type { RowAction } from '../library/BrowseControls';
import type { MenuAction } from '../../modules/tv-menu';

const playlistPrefix = 'playlist:';

/** The Add to playlist submenu: one entry per playlist the viewer owns. */
export function playlistSubmenu(playlists: readonly PlaylistSummary[]): MenuAction {
  return {
    id: 'playlist', title: 'Add to playlist', image: 'text.badge.plus',
    children: playlists.length
      ? playlists.map(playlist => ({ id: `${playlistPrefix}${playlist.id}`, title: playlist.name, image: 'music.note.list' }))
      : [{ id: 'none', title: 'No playlists yet', disabled: true }],
  };
}

/** The playlist an Add to playlist entry stands for. */
export function chosenPlaylist(id: string, playlists: readonly PlaylistSummary[]): PlaylistSummary | undefined {
  return id.startsWith(playlistPrefix) ? playlists.find(playlist => playlist.id === id.slice(playlistPrefix.length)) : undefined;
}

/** Turns the phone's menu rows into menu entries; the row whose `onPress` is `addToPlaylist` becomes the playlists submenu. */
export function rowMenu(rows: readonly RowAction[], playlists: readonly PlaylistSummary[], addToPlaylist?: () => void): MenuAction[] {
  return rows.map((row, index) => row.onPress === addToPlaylist ? playlistSubmenu(playlists)
    : { id: String(index), title: row.title, image: row.icon });
}
