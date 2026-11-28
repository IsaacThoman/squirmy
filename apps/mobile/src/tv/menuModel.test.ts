import type { PlaylistSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { sleepTimerChoices } from '@squirmy/client-core';
import { chosenPlaylist, chosenSleepTimer, playlistSubmenu, rowMenu, sleepTimerSubmenu } from './menuModel';

const playlist = (id: string, name: string) => ({ id, name }) as PlaylistSummary;

describe('playlistSubmenu', () => {
  it('lists each playlist under Add to playlist', () => {
    const menu = playlistSubmenu([playlist('a', 'Late Night'), playlist('b', 'Workout')]);
    expect(menu.title).toBe('Add to playlist');
    expect(menu.children?.map(item => item.title)).toEqual(['Late Night', 'Workout']);
  });

  it('says so, disabled, when there are none', () => {
    expect(playlistSubmenu([]).children).toEqual([{ id: 'none', title: 'No playlists yet', disabled: true }]);
  });
});

describe('chosenPlaylist', () => {
  const playlists = [playlist('a', 'Late Night'), playlist('b', 'Workout')];

  it('finds the playlist an entry stands for', () => {
    const id = playlistSubmenu(playlists).children![1]!.id;
    expect(chosenPlaylist(id, playlists)?.name).toBe('Workout');
  });

  it('ignores other entries and playlists that are gone', () => {
    expect(chosenPlaylist('0', playlists)).toBeUndefined();
    expect(chosenPlaylist('playlist:gone', playlists)).toBeUndefined();
  });
});

describe('rowMenu', () => {
  it('numbers the rows and puts the playlists in place of the add row', () => {
    const add = () => undefined;
    const rows = [
      { title: 'Play next', icon: 'text.insert', onPress: () => undefined },
      { title: 'Add to playlist', icon: 'text.badge.plus', onPress: add },
      { title: 'Go to artist', icon: 'music.mic', onPress: () => undefined },
    ];
    const menu = rowMenu(rows, [playlist('a', 'Late Night')], add);
    expect(menu.map(item => item.id)).toEqual(['0', 'playlist', '2']);
    expect(menu[1]!.children?.[0]?.title).toBe('Late Night');
  });
});

describe('sleepTimerSubmenu', () => {
  const choices = sleepTimerChoices({ type: 'album', id: null, title: 'Blue Hour' });

  it('offers the lengths and the ends, checking the one set, with Turn off timer while one is', () => {
    const menu = sleepTimerSubmenu({ choices, chosen: '30', label: '29:59', on: true });
    expect(menu.title).toBe('Sleep timer, 29:59');
    const [inline, off] = menu.children!;
    expect(inline!.children!.map(item => [item.title, item.checked])).toEqual([
      ['5 minutes', false], ['10 minutes', false], ['15 minutes', false], ['30 minutes', true], ['45 minutes', false], ['1 hour', false],
      ['End of song', false], ['End of album', false],
    ]);
    expect(off!.title).toBe('Turn off timer');
    expect(sleepTimerSubmenu({ choices, chosen: null, label: null, on: false }).children).toHaveLength(1);
  });

  it('tells what an entry asks for, and nothing for other entries', () => {
    const menu = sleepTimerSubmenu({ choices, chosen: null, label: null, on: true });
    expect(menu.title).toBe('Sleep timer');
    const [inline, off] = menu.children!;
    expect(chosenSleepTimer(inline!.children![0]!.id, choices)).toEqual({ kind: 'time', durationMs: 5 * 60_000 });
    expect(chosenSleepTimer(inline!.children![6]!.id, choices)).toEqual({ kind: 'track' });
    expect(chosenSleepTimer(off!.id, choices)).toBeNull();
    expect(chosenSleepTimer('0', choices)).toBeUndefined();
  });
});
