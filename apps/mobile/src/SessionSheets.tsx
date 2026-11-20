import type { PlaylistSummary } from '@squirmy/contracts';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { useAccount } from './account/AccountProvider';
import { closeSheet } from './closeSheet';
import { usePlaylistActions, useTrack } from './data/library';
import { useRealtime } from './data/realtime';
import { useCanPlay } from './downloads/DownloadsProvider';
import { usePlaylists } from './data/queries';
import { matches } from './library/shared';
import { useRunTrackAction, useTrackActions } from './library/trackActions';
import { usePlaybackState } from './playback';
import { useVolumeSlider } from './player/volume';
import { SheetAction, SheetField, SheetFrame, SheetRows, SheetRow, SheetScroll, SheetSlider, TrackSummary } from './SheetUI';
import { useColors } from './theme';

/** Up to this many playlists the sheet fits them all; beyond, they scroll under a search field. */
const fittingPlaylists = 8;
const playlistListHeight = 392;

function Sheet({ title, children }: { title: string; children?: ReactNode }) {
  const router = useRouter();
  return <SheetFrame title={title} onClose={() => closeSheet(router)}>{children}</SheetFrame>;
}

export function DeviceSheet() {
  const colors = useColors();
  const { track, devices, output, volume, session, actions } = usePlaybackState();
  const [shownVolume, setVolume] = useVolumeSlider(volume, value => actions.setVolume(output.id, value));
  return (
    <Sheet title="Playback device">
      <TrackSummary track={track} subtitle={session.activeDeviceId ? `Playing on ${output.name}` : undefined} />
      <SheetRows>
        {devices.map(device => (
          <SheetRow key={device.id} title={device.name} icon={device.icon} subtitle={device.subtitle}
            selected={device.active}
            color={device.active ? colors.accent : colors.text}
            onPress={() => {
              void Haptics.selectionAsync();
              if (!device.active) actions.transfer(device.id);
            }} />
        ))}
      </SheetRows>
      {session.activeDeviceId && <SheetSlider label={`Volume on ${output.name}`} value={shownVolume} onChange={setVolume} />}
    </Sheet>
  );
}

export function TrackActionSheet({ id, albumId, playlistId, itemId }: { id: string; albumId?: string; playlistId?: string; itemId?: string }) {
  const track = useTrack(id, albumId || null);
  const actions = useTrackActions(track, { playlist: playlistId && itemId ? { id: playlistId, itemId } : undefined });
  const playable = useCanPlay(track);
  const { offline } = useRealtime();
  const run = useRunTrackAction(true);
  if (!track) return <Sheet title="Track options" />;
  return (
    <Sheet title="Track options">
      <TrackSummary track={track} subtitle={!playable ? `${track.artistCredit} · ${offline && track.availability !== 'none' ? 'Not downloaded' : 'Not in your library'}` : undefined} />
      <SheetRows>
        {actions.map(action => <SheetRow key={action.id} title={action.title} icon={action.icon} onPress={() => {
          void Haptics.selectionAsync();
          run(action);
        }} />)}
      </SheetRows>
    </Sheet>
  );
}

/**
 * Opened from a track's actions: adds the track to one of the user's playlists, most
 * recently changed first, or to a new one. Many playlists scroll under a search field.
 */
export function AddToPlaylistSheet({ trackId, albumId }: { trackId: string; albumId?: string }) {
  const router = useRouter();
  const track = useTrack(trackId, albumId || null);
  const { state } = useAccount();
  const userId = state.status === 'signedIn' ? state.user.id : null;
  const list = usePlaylists();
  const owned = list.items.filter(playlist => playlist.ownerId === userId);
  const [query, setQuery] = useState('');
  const playlists = usePlaylistActions();
  useEffect(() => {
    if (list.hasNextPage) list.loadMore();
  }, [list.hasNextPage, list.items.length]);
  const add = (playlist: Pick<PlaylistSummary, 'id' | 'name'>) => {
    if (!track) return;
    void Haptics.selectionAsync();
    playlists.add(playlist, [track]);
    closeSheet(router);
  };
  const create = () => {
    void Haptics.selectionAsync();
    router.replace({ pathname: '/name-playlist', params: { mode: 'create', name: track?.title ?? '', trackId, albumId: albumId ?? '' } });
  };
  const rows = (items: readonly PlaylistSummary[]) => items.map(playlist => (
    <SheetRow key={playlist.id} title={playlist.name} icon="music.note.list"
      subtitle={`${playlist.trackCount} ${playlist.trackCount === 1 ? 'song' : 'songs'}`} onPress={() => add(playlist)} />
  ));
  const many = owned.length > fittingPlaylists;
  return (
    <Sheet title="Add to playlist">
      <TrackSummary track={track} />
      {many && <SheetField label="Find a playlist" value={query} onChange={setQuery} onSubmit={() => undefined} />}
      <SheetRows>
        <SheetRow title="New playlist" icon="plus" onPress={create} />
        {!many && rows(owned)}
      </SheetRows>
      {many && <SheetScroll height={playlistListHeight}>{rows(owned.filter(playlist => matches(query, playlist.name)))}</SheetScroll>}
    </Sheet>
  );
}

/** Names a new playlist (adding `trackId` to it, when given) or renames one. */
export function NamePlaylistSheet({ mode, id, name, trackId, albumId }: {
  mode: 'create' | 'rename'; id?: string; name?: string; trackId?: string; albumId?: string;
}) {
  const router = useRouter();
  const track = useTrack(trackId || null, albumId || null);
  const playlists = usePlaylistActions();
  const [value, setValue] = useState(name ?? '');
  const ready = Boolean(value.trim()) && (mode === 'create' || value.trim() !== name);
  const save = () => {
    if (!ready) return;
    void Haptics.selectionAsync();
    if (mode === 'rename' && id) playlists.rename(id, value.trim());
    else {
      void playlists.create(value.trim()).then(playlist => {
        if (track) playlists.add(playlist, [track]);
      }, () => undefined);
    }
    closeSheet(router);
  };
  return (
    <Sheet title={mode === 'rename' ? 'Rename playlist' : 'New playlist'}>
      <SheetField label="Playlist name" value={value} onChange={setValue} onSubmit={save} autoFocus />
      <SheetAction title={mode === 'rename' ? 'Save' : track ? 'Create and add' : 'Create'} disabled={!ready} onPress={save} />
    </Sheet>
  );
}
