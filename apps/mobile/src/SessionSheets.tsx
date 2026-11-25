import { plural, type SessionMoveResult } from '@squirmy/client-core';
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
import { useAllPlaylists } from './data/queries';
import { usePageLinks } from './library/links';
import { matches } from './library/shared';
import { trackActionKey, useRunTrackAction, useTrackActions } from './library/trackActions';
import { usePlaybackState } from './playback';
import { whereItPlays } from './player/session';
import { useVolumeSlider } from './player/volume';
import NowPlaying, { SystemVolumeSlider } from '../modules/now-playing';
import {
  SheetAction, SheetField, SheetFrame, SheetInfo, SheetNote, SheetRows, SheetRow, SheetScroll, SheetSlider, SheetSystemVolume, TrackSummary,
} from './SheetUI';
import { DETACHED_SYMBOL, detachedHeader, hasQueueToBring, moveFailure, separateRows } from './player/detach';
import { announce } from './inlineFeedback';
import { playlistAddFailure } from './library/failures';
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
  const { track, devices, output, volume, session, queue, actions, detached, canDetach, allDevices, thisDeviceId } = usePlaybackState();
  const [shownVolume, setVolume] = useVolumeSlider(volume, value => actions.setVolume(output.id, value));
  const [moving, setMoving] = useState<'detach' | 'attach' | 'bring' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The sheet turns to the other way of playing: what failed in the last one is no longer on screen.
  useEffect(() => setFailure(null), [detached]);
  const separate = allDevices.filter(device => device.detached && device.id !== thisDeviceId);
  // Detaching and rejoining are undone by one press, so neither asks first. The sheet changes to
  // say where the phone now plays, which is the confirmation; a refusal is told here.
  const move = (run: () => Promise<SessionMoveResult>, kind: 'detach' | 'attach' | 'bring') => {
    if (moving) return;
    void Haptics.selectionAsync();
    setMoving(kind);
    setFailure(null);
    void run().then(result => {
      setMoving(null);
      if (result.ok) return;
      const message = moveFailure(kind === 'detach' ? 'detach' : 'attach', result.error);
      setFailure(message);
      announce(message);
    });
  };

  if (detached) {
    return (
      <Sheet title="Playback device">
        <SheetInfo icon={DETACHED_SYMBOL} {...detachedHeader(track, session.playing)} />
        <SheetRows>
          <SheetRow title="Rejoin your other devices" icon="arrow.uturn.backward"
            subtitle="This device’s queue is cleared." busy={moving === 'attach'}
            onPress={() => move(() => actions.attach(), 'attach')} />
          {hasQueueToBring(session, queue) && <SheetRow title="Bring this queue with me" icon="arrow.triangle.merge"
            subtitle="Your other devices switch to what’s playing here" busy={moving === 'bring'}
            onPress={() => move(() => actions.attach({ bringQueue: true }), 'bring')} />}
        </SheetRows>
        {failure && <SheetNote error>{failure}</SheetNote>}
        {output.isThisDevice && SystemVolumeSlider && <SheetSystemVolume label="Volume on this iPhone" />}
        {output.isThisDevice && <RouteRow />}
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
      {output.isThisDevice && !output.reconnecting && <RouteRow />}
      {canDetach && <SheetRows>
        <SheetRow title="Play separately on this iPhone" icon={DETACHED_SYMBOL} subtitle="Your other devices keep their own queue."
          busy={moving === 'detach'} onPress={() => move(() => actions.detach(), 'detach')} />
      </SheetRows>}
      {failure && <SheetNote error>{failure}</SheetNote>}
      <SeparateDevices devices={separate} />
    </Sheet>
  );
}

/**
 * Where this phone's own sound goes: AirPlay, Bluetooth or the speaker, in the system's picker.
 * Only while this phone plays; another device's sound is its own business. iOS only.
 */
function RouteRow() {
  if (!NowPlaying?.showRoutePicker) return null;
  return <SheetRows>
    <SheetRow title="AirPlay and Bluetooth" icon="airplay.audio" subtitle="Choose where this iPhone’s sound plays"
      onPress={() => { void Haptics.selectionAsync(); void NowPlaying?.showRoutePicker?.(); }} />
  </SheetRows>;
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
  const list = useAllPlaylists();
  const owned = list.items.filter(playlist => playlist.ownerId === userId);
  const [query, setQuery] = useState('');
  const playlists = usePlaylistActions();
  // The playlist being added to: the sheet waits for the server with a spinner on its row.
  const [adding, setAdding] = useState<string | null>(null);
  // Read by the Alert's buttons too, which keep the render they were made in.
  const sending = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);
  const open = useOpenRef();
  // As in Apple Music, a song the playlist already has is added again only when asked to.
  // The sheet stays open while it asks, so another playlist can be chosen instead.
  const askAnyway = (playlist: PlaylistSummary) => {
    if (!track) return;
    Alert.alert(`Already in “${playlist.name}”`, `Add “${track.title}” again?`, [
      { text: 'Don’t Add', style: 'cancel' },
      { text: 'Add Anyway', onPress: () => send(playlist, true) },
    ]);
  };
  // The sheet closes once the server has the song: the playlist's new count is the confirmation.
  // A refusal is said here, and the sheet stays to try again.
  const send = (playlist: PlaylistSummary, anyway: boolean) => {
    if (!track || sending.current) return;
    sending.current = true;
    setAdding(playlist.id);
    setFailed(null);
    playlists.add(playlist, [track], { anyway }).then(({ skipped }) => {
      sending.current = false;
      if (!open.current) return;
      setAdding(null);
      // The server left out a duplicate the phone didn't know of (the playlist's page was never loaded).
      if (skipped) askAnyway(playlist);
      else closeSheet(router);
    }, () => {
      sending.current = false;
      if (!open.current) return;
      setAdding(null);
      const message = playlistAddFailure(playlist.name);
      setFailed(message);
      announce(message);
    });
  };
  const add = (playlist: PlaylistSummary) => {
    if (!track || sending.current) return;
    void Haptics.selectionAsync();
    if (playlists.has(playlist.id, track.id)) askAnyway(playlist);
    else send(playlist, false);
  };
  const create = () => {
    void Haptics.selectionAsync();
    router.replace({ pathname: '/name-playlist', params: { mode: 'create', name: track?.title ?? '', trackId, albumId: albumId ?? '' } });
  };
  const rows = (items: readonly PlaylistSummary[]) => items.map(playlist => (
    <SheetRow key={playlist.id} title={playlist.name} icon="music.note.list" busy={adding === playlist.id}
      subtitle={plural(playlist.trackCount, 'song')} onPress={() => add(playlist)} />
  ));
  const many = owned.length > fittingPlaylists;
  return (
    <Sheet title="Add to playlist">
      <TrackSummary track={track} />
      {failed && <SheetNote error>{failed}</SheetNote>}
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
  const [failed, setFailed] = useState<string | null>(null);
  const open = useOpenRef();
  // Made, but the song not added to it: trying again adds the song to this one rather than making another.
  const created = useRef<PlaylistSummary | null>(null);
  const ready = Boolean(value.trim()) && (mode === 'create' || value.trim() !== name) && !saving;
  // The sheet closes once the server has the name (and the song), so a refusal leaves the text
  // here to try again, and says so here.
  const save = () => {
    if (!ready) return;
    void Haptics.selectionAsync();
    setSaving(true);
    setFailed(null);
    const fail = (message: string) => () => {
      if (!open.current) return;
      setSaving(false);
      setFailed(message);
      announce(message);
    };
    if (mode === 'rename' && id) {
      playlists.rename(id, value.trim()).then(() => {
        if (open.current) closeSheet(router);
      }, fail('Couldn’t rename the playlist. Try again.'));
      return;
    }
    const made = created.current ? Promise.resolve(created.current) : playlists.create(value.trim()).then(playlist => {
      created.current = playlist;
      return playlist;
    });
    made.then(playlist => {
      const added = track ? playlists.add(playlist, [track]) : Promise.resolve();
      added.then(() => {
        if (!open.current) return;
        closeSheet(router);
        // Made from the Library, the new playlist opens, ready for songs; made while adding a song, the person stays where they were.
        if (!track) router.navigate(link('playlist', playlist.id));
      }, fail(`Made “${playlist.name}”, but couldn’t add the song. Try again.`));
    }, fail('Couldn’t create the playlist. Try again.'));
  };
  return (
    <Sheet title={mode === 'rename' ? 'Rename playlist' : 'New playlist'}>
      <SheetField label="Playlist name" value={value} onChange={setValue} onSubmit={save} autoFocus maxLength={PLAYLIST_NAME_MAX_LENGTH} />
      {failed && <SheetNote error>{failed}</SheetNote>}
      <SheetAction title={mode === 'rename' ? 'Save' : track ? 'Create and add' : 'Create'} disabled={!ready} onPress={save} />
    </Sheet>
  );
}

/** False once the sheet has closed: closed by hand while the server was answering, it must not close a second time, which would leave the page beneath. */
function useOpenRef() {
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  return open;
}
