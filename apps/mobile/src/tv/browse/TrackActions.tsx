import { useRef, useState, type ComponentProps } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { PLAYLIST_NAME_MAX_LENGTH, type PlaylistSummary } from '@squirmy/contracts';
import { useAccount, useSignedInApi } from '../../account/AccountProvider';
import { useLibraryActions, useLiked, useLikeFailure, usePlaylistActions, useTrack } from '../../data/library';
import { useAllPlaylists } from '../../data/queries';
import { useAvailability } from '../../downloads/DownloadsProvider';
import { playlistAddFailure } from '../../library/failures';
import { queuedNotice, radioStartingNotice, trackActionKey, trackActions, type TrackAction } from '../../library/trackActionList';
import { useCurrentTrackState, usePlaybackActions } from '../../playback';
import { playbackStatus } from '../../player/usePlaybackStatus';
import { TvButton, tvColors } from '../ui';
import type { BrowseProps, BrowseRoute } from './model';
import { BrowseRow } from './rows';
import { BrowseArt, BrowseHeader, BrowseLoading, BrowseMessage, BrowseQuery, BrowseScroll, browseStyles } from './view';

export function TrackMenu({ route, navigate, back }: BrowseProps & { route: Extract<BrowseRoute, { screen: 'track' }> }) {
  const live = useTrack(route.track.id, route.track.album?.id);
  const track = live ?? route.track;
  const liked = useLiked('track', track.id, track.liked);
  const likeFailure = useLikeFailure('track', track.id);
  const { setLiked } = useLibraryActions();
  const { offline, viewer, canPlay } = useAvailability();
  const current = useCurrentTrackState(track.id);
  const actions = usePlaybackActions();
  const edits = usePlaylistActions();
  const api = useSignedInApi();
  const items = trackActions(track, {
    liked, likeFailure, playable: canPlay(track), offline, viewer, current,
    download: undefined, onItsOwn: false, wantlist: false,
  }, route).filter(action => action.id !== 'download');
  const artwork = track.album?.artwork;
  const run = (action: TrackAction) => {
    if (action.page) {
      navigate({ screen: action.page.page, id: action.page.id });
      return;
    }
    switch (action.id) {
      case 'play':
        actions.playNow(track);
        back();
        return;
      case 'resume':
        actions.play();
        back();
        return;
      case 'next':
      case 'last':
        actions.enqueue([track], action.id);
        playbackStatus.report(queuedNotice(track.title, action.id));
        back();
        return;
      case 'like':
      case 'unlike':
        setLiked('track', track.id, action.id === 'like', track.title);
        return;
      case 'playlist':
        navigate({ screen: 'addToPlaylist', track });
        return;
      case 'radio': {
        if (!api) return;
        const starting = playbackStatus.report(radioStartingNotice);
        void api.radio.track(track.id).then(radio => {
          playbackStatus.withdraw(starting);
          actions.playRadio(radio);
        }, () => playbackStatus.report({ message: `Couldn’t start radio for “${track.title}”` }));
        back();
        return;
      }
      case 'remove':
        if (route.playlist) edits.removeItem(route.playlist.id, route.playlist.itemId);
        back();
        return;
    }
  };
  return <BrowseScroll>
    <View style={styles.menuPage}>
      <BrowseArt artworks={artwork ? [artwork] : undefined} size={286} />
      <View style={styles.menuItems}>
        <BrowseHeader title={track.title} subtitle={track.artistCredit} />
        {items.map(item => <BrowseRow key={item.id === 'like' || item.id === 'unlike' ? 'library' : trackActionKey(item)}
          title={item.title} subtitle={item.subtitle} onPress={() => run(item)} />)}
      </View>
    </View>
  </BrowseScroll>;
}

type Destination = Pick<PlaylistSummary, 'id' | 'name' | 'trackCount'>;

export function AddToPlaylist({ route }: BrowseProps & { route: Extract<BrowseRoute, { screen: 'addToPlaylist' }> }) {
  const { state } = useAccount();
  const { offline } = useAvailability();
  const playlists = useAllPlaylists();
  const edits = usePlaylistActions();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<{ target: Destination; duplicate: boolean } | null>(null);
  const inFlight = useRef(false);
  const owned = state.status === 'signedIn' ? playlists.items.filter(item => item.ownerId === state.user.id) : [];

  const submit = async (playlist?: Destination, anyway?: boolean) => {
    if (inFlight.current || offline || (!playlist && !name.trim())) return;
    inFlight.current = true;
    setBusy(playlist?.id ?? 'new');
    setFailure(null);
    setResult(null);
    let target = playlist;
    try {
      if (!target) {
        target = await edits.create(name.trim());
        // The playlist already exists even if the append is refused.
        setCreating(false);
        setName('');
      }
      const { skipped } = await edits.add(target, [route.track], { anyway });
      setResult({ target, duplicate: skipped });
    } catch {
      setFailure(target ? playlistAddFailure(target.name) : 'Couldn’t create the playlist. Try again.');
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const header = <>
    <BrowseHeader title="Add to playlist" subtitle={route.track.title} />
    {offline && <Text accessibilityRole="alert" style={browseStyles.subtitle}>Connect to your server to edit playlists.</Text>}
    {failure && <Text accessibilityRole="alert" style={styles.error}>{failure}</Text>}
    {result && <View style={styles.result}>
      <Text accessibilityRole="alert" style={browseStyles.subtitle}>
        {result.duplicate ? `Already in “${result.target.name}”` : `Added to “${result.target.name}”`}
      </Text>
      {result.duplicate && <TvButton label="Add again" disabled={busy !== null || offline} onPress={() => { void submit(result.target, true); }} />}
    </View>}
    <View style={styles.create}>
      {creating ? <>
        <PlaylistName value={name} onChangeText={setName} onSubmitEditing={() => { void submit(); }} editable={busy === null && !offline} />
        <View style={browseStyles.actions}>
          <TvButton label={busy === 'new' ? 'Creating…' : 'Create and add'} tone="primary"
            disabled={busy !== null || !name.trim() || offline} onPress={() => { void submit(); }} />
          <TvButton label="Cancel" tone="quiet" disabled={busy !== null} onPress={() => setCreating(false)} />
        </View>
      </> : <TvButton label="New playlist" disabled={busy !== null || offline} onPress={() => setCreating(true)} />}
    </View>
    {!playlists.data && <BrowseQuery query={playlists} what="your playlists" />}
    {playlists.data && !playlists.hasNextPage && !owned.length && !creating
      && <BrowseMessage title="No playlists yet" detail="Create a playlist to keep songs together." />}
  </>;

  return <FlatList data={owned} keyExtractor={item => item.id} contentInsetAdjustmentBehavior="never"
    contentContainerStyle={[browseStyles.padding, styles.playlists]} ListHeaderComponent={header}
    ListFooterComponent={playlists.isFetchingNextPage ? <BrowseLoading label="Loading playlists" />
      : playlists.isFetchNextPageError ? <BrowseMessage title="Couldn’t load more playlists"
        action={<TvButton label="Try again" onPress={playlists.loadMore} />} /> : undefined}
    showsVerticalScrollIndicator={false} removeClippedSubviews={false}
    renderItem={({ item }) => <BrowseRow title={item.name} artworks={item.artworks} glyph="♫"
      subtitle={busy === item.id ? 'Adding…' : undefined} onPress={() => { void submit(item); }} />} />;
}

function PlaylistName(props: ComponentProps<typeof TextInput>) {
  const [focused, setFocused] = useState(false);
  return <TextInput {...props} accessibilityLabel="Playlist name" autoCapitalize="words" maxLength={PLAYLIST_NAME_MAX_LENGTH}
    returnKeyType="done" placeholder="Playlist name" placeholderTextColor={tvColors.muted} keyboardAppearance="dark" selectionColor={tvColors.accent}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={[styles.input, focused && styles.inputFocused]} />;
}

const styles = StyleSheet.create({
  menuPage: { flexDirection: 'row', alignItems: 'flex-start', gap: 48, paddingTop: 34, maxWidth: 1260 },
  menuItems: { flex: 1 },
  playlists: { width: '100%', maxWidth: 1120 },
  error: { color: tvColors.danger, fontSize: 22, marginBottom: 12 },
  result: { alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  create: { alignItems: 'flex-start', gap: 14, paddingVertical: 14, marginBottom: 10 },
  input: {
    alignSelf: 'stretch', minHeight: 64, borderWidth: 2, borderColor: tvColors.border,
    borderRadius: 15, backgroundColor: tvColors.surface, color: tvColors.text, paddingHorizontal: 18, fontSize: 25,
  },
  inputFocused: { borderColor: tvColors.accent },
});
