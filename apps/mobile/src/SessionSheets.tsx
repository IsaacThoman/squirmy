import type { PlaylistSummary } from '@squirmy/contracts';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { useAccount } from './account/AccountProvider';
import { closeSheet } from './closeSheet';
import { usePlaylistActions, useTrack } from './data/library';
import { usePlaylists } from './data/queries';
import { promptForName } from './library/shared';
import { useRunTrackAction, useTrackActions } from './library/trackActions';
import { usePlaybackState } from './playback';
import { useVolumeSlider } from './player/volume';
import { SheetFrame, SheetRows, SheetRow, SheetSlider, TrackSummary } from './SheetUI';
import { useColors } from './theme';

/** The sheet fits its content; the most recently changed playlists are the likely targets. */
const recentPlaylists = 8;

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
  const run = useRunTrackAction(true);
  if (!track) return <Sheet title="Track options" />;
  return (
    <Sheet title="Track options">
      <TrackSummary track={track} subtitle={track.availability === 'none' ? `${track.artistCredit} · Not in your library` : undefined} />
      <SheetRows>
        {actions.map(action => <SheetRow key={action.id} title={action.title} icon={action.icon} onPress={() => {
          void Haptics.selectionAsync();
          run(action);
        }} />)}
      </SheetRows>
    </Sheet>
  );
}

/** Opened from a track's actions: adds the track to a playlist, or to a new one. */
export function AddToPlaylistSheet({ trackId, albumId }: { trackId: string; albumId?: string }) {
  const router = useRouter();
  const track = useTrack(trackId, albumId || null);
  const { state } = useAccount();
  const userId = state.status === 'signedIn' ? state.user.id : null;
  const owned = usePlaylists().items.filter(playlist => playlist.ownerId === userId);
  const playlists = usePlaylistActions();
  const add = (playlist: Pick<PlaylistSummary, 'id' | 'name'>) => {
    if (!track) return;
    void Haptics.selectionAsync();
    playlists.add(playlist, [track]);
    closeSheet(router);
  };
  const create = () => promptForName('New playlist', track?.title ?? '', name => {
    void playlists.create(name).then(add, () => undefined);
  });
  return (
    <Sheet title="Add to playlist">
      <TrackSummary track={track} />
      <SheetRows>
        <SheetRow title="New playlist" icon="plus" onPress={create} />
        {owned.slice(0, recentPlaylists).map(playlist => (
          <SheetRow key={playlist.id} title={playlist.name} icon="music.note.list"
            subtitle={`${playlist.trackCount} ${playlist.trackCount === 1 ? 'song' : 'songs'}`} onPress={() => add(playlist)} />
        ))}
      </SheetRows>
    </Sheet>
  );
}
