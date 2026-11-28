import type { SleepTimerChoice } from '@squirmy/client-core';
import type { PlaylistSummary, SleepTimerRequest } from '@squirmy/contracts';
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

const sleepPrefix = 'sleep:';
const sleepOff = `${sleepPrefix}off`;

/**
 * The Sleep timer submenu of Now Playing's menu: the lengths and the ends to stop at, checked
 * while set, and Turn off timer while one is.
 */
export function sleepTimerSubmenu(sleep: { choices: readonly SleepTimerChoice[]; chosen: string | null; label: string | null; on: boolean }): MenuAction {
  return {
    // A submenu has no subtitle on tvOS: the time left goes in its title, as on the phone.
    id: 'sleep', title: sleep.label ? `Sleep timer, ${sleep.label}` : 'Sleep timer', image: 'moon.zzz',
    children: [
      { id: 'sleep-choices', title: '', inline: true, children: sleep.choices.map(choice => ({ id: `${sleepPrefix}${choice.id}`, title: choice.label, checked: choice.id === sleep.chosen })) },
      ...(sleep.on ? [{ id: sleepOff, title: 'Turn off timer', image: 'moon.zzz' }] : []),
    ],
  };
}

/** What a Sleep timer entry asks for: a timer, null to turn it off, or undefined for any other entry. */
export function chosenSleepTimer(id: string, choices: readonly SleepTimerChoice[]): SleepTimerRequest | null | undefined {
  if (id === sleepOff) return null;
  if (!id.startsWith(sleepPrefix)) return undefined;
  return choices.find(choice => choice.id === id.slice(sleepPrefix.length))?.request;
}
