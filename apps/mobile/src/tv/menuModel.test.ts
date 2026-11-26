import type { PlaylistSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { chosenPlaylist, playlistSubmenu, rowMenu } from './menuModel';

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
