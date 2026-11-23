import type { SessionMoveResult } from '@squirmy/client-core';
import { PLAYLIST_NAME_MAX_LENGTH, type DeviceInfo, type PlaylistSummary } from '@squirmy/contracts';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { useAccount } from './account/AccountProvider';
import { closeSheet } from './closeSheet';
import { usePlaylistActions, useTrack } from './data/library';
import { useRealtime } from './data/realtime';
import { useCanPlay, useViewer } from './downloads/DownloadsProvider';
import { unavailableReason } from './downloads/model';
import { usePlaylists } from './data/queries';
import { usePageLinks } from './library/links';
import { matches } from './library/shared';
import { trackActionKey, useRunTrackAction, useTrackActions } from './library/trackActions';
import { usePlaybackState } from './playback';
import { whereItPlays } from './player/session';
import { useVolumeSlider } from './player/volume';
import { SystemVolumeSlider } from '../modules/now-playing';
import {
  SheetAction, SheetField, SheetFrame, SheetInfo, SheetNote, SheetRows, SheetRow, SheetScroll, SheetSlider, SheetSystemVolume, TrackSummary,
} from './SheetUI';
import { DETACHED_SYMBOL, detachedHeader, detachedNotice, hasQueueToBring, moveFailure, rejoinedNotice, separateRows } from './player/detach';
import { useNotice } from './Notice';
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
  const notify = useNotice();
  const { track, devices, output, volume, session, queue, actions, detached, canDetach, allDevices, thisDeviceId } = usePlaybackState();
  const [shownVolume, setVolume] = useVolumeSlider(volume, value => actions.setVolume(output.id, value));
  const [moving, setMoving] = useState(false);
  const separate = allDevices.filter(device => device.detached && device.id !== thisDeviceId);
  // Detaching and rejoining are undone by one press, so neither asks first; the notice says what happened.
  const move = (run: () => Promise<SessionMoveResult>, kind: 'detach' | 'attach', done: () => string | null) => {
    if (moving) return;
    void Haptics.selectionAsync();
    setMoving(true);
    void run().then(result => {
      setMoving(false);
      const message = result.ok ? done() : moveFailure(kind, result.error);
      if (message) notify(message);
    });
  };
  const playingHere = session.playing && output.isThisDevice;

  if (detached) {
    return (
      <Sheet title="Playback device">
        <SheetInfo icon={DETACHED_SYMBOL} {...detachedHeader(track, session.playing)} />
        <SheetRows>
          <SheetRow title="Rejoin your other devices" icon="arrow.uturn.backward"
            subtitle="This device’s queue is cleared."
            onPress={() => move(() => actions.attach(), 'attach', () => rejoinedNotice(track?.title, session.playing))} />
          {hasQueueToBring(session, queue) && <SheetRow title="Bring this queue with me" icon="arrow.triangle.merge"
            subtitle="Your other devices switch to what’s playing here"
            onPress={() => move(() => actions.attach({ bringQueue: true }), 'attach', () => null)} />}
        </SheetRows>
        {output.isThisDevice && SystemVolumeSlider && <SheetSystemVolume label="Volume on this iPhone" />}
        <SeparateDevices devices={separate} />
      </Sheet>
    );
  }

  return (
    <Sheet title="Playback device">
      <TrackSummary track={track} subtitle={session.activeDeviceId ? whereItPlays(output, session.playing ? 'Playing' : 'Paused') : undefined} />
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
      {/* This phone's volume is the system's: its own slider, which the side buttons move too. */}
      {/* A device that went away has no volume to set until it is back. */}
      {session.activeDeviceId && !output.reconnecting && (output.isThisDevice && SystemVolumeSlider
        ? <SheetSystemVolume label={`Volume on ${output.name}`} />
        : <SheetSlider label={`Volume on ${output.name}`} value={shownVolume} onChange={setVolume} />)}
      {canDetach && <SheetRows>
        <SheetRow title="Play separately on this iPhone" icon={DETACHED_SYMBOL} subtitle="Your other devices keep their own queue."
          onPress={() => move(() => actions.detach(), 'detach', () => detachedNotice(playingHere))} />
      </SheetRows>}
      <SeparateDevices devices={separate} />
    </Sheet>
  );
}

/** Devices playing their own queue: not transfer targets, listed so "why didn't the kitchen change?" has an answer. */
function SeparateDevices({ devices }: { devices: readonly DeviceInfo[] }) {
  if (!devices.length) return null;
  return <>
    <SheetNote>Playing separately</SheetNote>
    {devices.map(device => <SeparateDevice key={device.id} device={device} />)}
  </>;
}

function SeparateDevice({ device }: { device: DeviceInfo }) {
  const track = useTrack(device.detached?.trackId, device.detached?.albumId);
  const [row] = separateRows([device], '', () => track?.title);
  return row ? <SheetInfo icon={row.icon} title={row.name} subtitle={row.subtitle} /> : null;
}

export function TrackActionSheet({ id, albumId, playlistId, itemId }: { id: string; albumId?: string; playlistId?: string; itemId?: string }) {
  const track = useTrack(id, albumId || null);
  const actions = useTrackActions(track, { playlist: playlistId && itemId ? { id: playlistId, itemId } : undefined });
  const playable = useCanPlay(track);
  const { offline } = useRealtime();
  const viewer = useViewer();
  const run = useRunTrackAction(true);
  if (!track) return <Sheet title="Track options" />;
  return (
    <Sheet title="Track options">
      <TrackSummary track={track} subtitle={!playable ? `${track.artistCredit} · ${unavailableReason(track, offline, viewer)}` : undefined} />
      <SheetRows>
        {actions.map(action => <SheetRow key={trackActionKey(action)} title={action.title} icon={action.icon} onPress={() => {
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
  const add = (playlist: PlaylistSummary) => {
    if (!track) return;
    void Haptics.selectionAsync();
    // As in Apple Music, a song the playlist already has is added again only when asked to.
    // When its page was never loaded the server leaves the duplicate out, and the notice offers to add it anyway.
    if (playlists.has(playlist.id, track.id)) {
      Alert.alert(`Already in “${playlist.name}”`, `Add “${track.title}” again?`, [
        // The sheet stays open, so another playlist can be chosen.
        { text: 'Don’t Add', style: 'cancel' },
        { text: 'Add Anyway', onPress: () => {
          playlists.add(playlist, [track], { anyway: true });
          closeSheet(router);
        } },
      ]);
      return;
    }
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
  const link = usePageLinks();
  const track = useTrack(trackId || null, albumId || null);
  const playlists = usePlaylistActions();
  // A new playlist is named after the song by default, and a song's title can be longer than a name may be.
  const [value, setValue] = useState((name ?? '').slice(0, PLAYLIST_NAME_MAX_LENGTH));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // Closed by hand while the server was answering, the sheet must not close a second time: that would leave the page beneath.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const ready = Boolean(value.trim()) && (mode === 'create' || value.trim() !== name) && !saving;
  // The sheet closes once the server has the name, so a refusal leaves the text here to try again;
  // the app's notices would be hidden under the sheet, so it says so here too.
  const save = () => {
    if (!ready) return;
    void Haptics.selectionAsync();
    setSaving(true);
    setFailed(false);
    const done = mode === 'rename' && id
      ? playlists.rename(id, value.trim()).then(() => {
        if (open.current) closeSheet(router);
      })
      : playlists.create(value.trim()).then(playlist => {
        if (track) playlists.add(playlist, [track]);
        if (!open.current) return;
        closeSheet(router);
        // Made from the Library, the new playlist opens, ready for songs; made while adding a song, the person stays where they were.
        if (!track) router.navigate(link('playlist', playlist.id));
      });
    done.catch(() => {
      if (!open.current) return;
      setSaving(false);
      setFailed(true);
    });
  };
  return (
    <Sheet title={mode === 'rename' ? 'Rename playlist' : 'New playlist'}>
      <SheetField label="Playlist name" value={value} onChange={setValue} onSubmit={save} autoFocus maxLength={PLAYLIST_NAME_MAX_LENGTH} />
      {failed && <SheetNote>{mode === 'rename' ? 'Couldn’t rename the playlist. Try again.' : 'Couldn’t create the playlist. Try again.'}</SheetNote>}
      <SheetAction title={mode === 'rename' ? 'Save' : track ? 'Create and add' : 'Create'} disabled={!ready} onPress={save} />
    </Sheet>
  );
}
