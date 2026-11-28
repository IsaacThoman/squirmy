import { songCountLabel } from '@squirmy/client-core';
import type { HistoryItem, PlaybackContext, TrackSummary } from '@squirmy/contracts';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useAccount, type Api } from '../../account/AccountProvider';
import { isNotFound, loadFailure } from '../../data/errors';
import { usePlaylistActions, usePlaylistFailure } from '../../data/library';
import { useHistory, useLikedTracks, usePlaylist } from '../../data/queries';
import { useRealtime } from '../../data/realtime';
import { useAvailability } from '../../downloads/DownloadsProvider';
import { playAllFailure } from '../../library/failures';
import { uniqueTracks } from '../../library/loadAll';
import { usePlayAll } from '../../library/usePlayAll';
import { usePlaybackActions } from '../../playback';
import { queuedNotice } from '../../library/trackActionList';
import { playbackStatus } from '../../player/usePlaybackStatus';
import { SystemButton } from '../Button';
import type { MenuAction } from '../Menu';
import { PageState } from '../Page';
import { colors, type } from '../theme';
import { CollectionArt, type ArtKind } from './CollectionArt';
import { artSize, TrackListPage } from './TrackListPage';

/** Liked Songs, listening history, or a playlist. */
export function PlaylistPage({ id }: { id: string }) {
  if (id === 'liked') return <LikedPage />;
  if (id === 'recent') return <HistoryPage />;
  return <UserPlaylistPage id={id} />;
}

const likedPage = (api: Api, cursor: string, limit: number) => api.userdata.likes('track', { cursor, limit });
const historyPage = (api: Api, cursor: string, limit: number) => api.userdata.history({ cursor, limit });
/** Each song once, at its latest play: the page lists songs, not every play of them. */
const historyTracks = (items: readonly HistoryItem[]) => uniqueTracks(items.map(item => item.track));
/** Play and Shuffle beside the queue entries, so a menu reaches what the buttons do not. */
const queueActions: MenuAction[] = [
  { id: 'next', title: 'Play next', image: 'text.line.first.and.arrowtriangle.forward' },
  { id: 'last', title: 'Add to queue', image: 'text.line.last.and.arrowtriangle.forward' },
];
const likedContext: PlaybackContext = { type: 'liked', id: null, title: 'Liked Songs' };
const historyContext: PlaybackContext = { type: 'history', id: null, title: 'Recently Played' };

type ListProps = {
  title: string;
  special: ArtKind;
  facts: string;
  tracks: readonly TrackSummary[];
  /** Every page is in, so the count is the whole list's. */
  complete: boolean;
  playAll: ReturnType<typeof usePlayAll<unknown>>;
  context: PlaybackContext;
  empty: { title: string; description: string };
  loadMore: () => void;
  loadingMore: boolean;
};

/** Liked Songs and history: lists loaded a page at a time, whose Play loads the rest first. */
function PagedListPage({ title, special, facts, tracks, complete, playAll, context, empty, loadMore, loadingMore }: ListProps) {
  const actions = usePlaybackActions();
  const { canPlay } = useAvailability();
  const play = (shuffle: boolean, start?: number) => playAll.run(start, shuffle,
    all => actions.playTracks(all, { start, shuffle, context }));
  // `playAll` is new each render; the rows reach the latest through a ref, so they are not all drawn again.
  const latest = useRef(play);
  latest.current = play;
  const onPlay = useCallback((index: number) => latest.current(false, index), []);
  const playable = tracks.some(canPlay);
  const count = tracks.length ? songCountLabel(tracks.length, { complete, durationMs: tracks.reduce((sum, track) => sum + track.durationMs, 0), separator: ', ' }) : null;
  return <TrackListPage
    art={<CollectionArt artworks={[]} special={special} size={artSize} />}
    title={title}
    facts={[facts, count].filter(Boolean).join(' · ')}
    buttons={tracks.length > 0 && <>
      <SystemButton label={playAll.busy === 'play' ? 'Loading…' : 'Play'} icon="play.fill" prominent disabled={!playable} onPress={() => play(false)} />
      <SystemButton icon="shuffle" accessibilityLabel="Shuffle" disabled={!playable} onPress={() => play(true)} />
    </>}
    description={playAll.failed ? playAllFailure : null}
    tracks={tracks}
    onPlay={onPlay}
    onEndReached={loadMore}
    loadingMore={loadingMore}
    empty={<Empty {...empty} />}
  />;
}

function LikedPage() {
  const liked = useLikedTracks();
  const playAll = usePlayAll({ list: liked, fetchPage: likedPage, tracksOf: items => [...items] });
  if (!liked.data) return <PageState loading={!liked.isError} message={liked.isError ? loadFailure(liked.error).description : undefined}
    onRetry={liked.isError ? () => void liked.refetch() : undefined} />;
  return <PagedListPage title="Liked Songs" special="liked" facts="Playlist" tracks={liked.items} complete={!liked.hasNextPage}
    playAll={playAll} context={likedContext} loadMore={liked.loadMore} loadingMore={liked.isFetchingNextPage}
    empty={{ title: 'No liked songs yet', description: 'Choose the heart in any song’s menu to add it to Liked Songs.' }} />;
}

function HistoryPage() {
  const history = useHistory();
  const playAll = usePlayAll({ list: history, fetchPage: historyPage, tracksOf: historyTracks });
  const tracks = useMemo(() => historyTracks(history.items), [history.items]);
  if (!history.data) return <PageState loading={!history.isError} message={history.isError ? loadFailure(history.error).description : undefined}
    onRetry={history.isError ? () => void history.refetch() : undefined} />;
  return <PagedListPage title="Recently Played" special="recent" facts="Listening history" tracks={tracks} complete={!history.hasNextPage}
    playAll={playAll} context={historyContext} loadMore={history.loadMore} loadingMore={history.isFetchingNextPage}
    empty={{ title: 'Nothing played yet', description: 'Play a song and it will appear in your history.' }} />;
}

/**
 * One of the user's playlists, or someone's public one. Your own playlist's songs can be
 * removed from their menus, and More deletes it.
 */
function UserPlaylistPage({ id }: { id: string }) {
  const { state } = useAccount();
  const router = useRouter();
  const playlist = usePlaylist(id);
  const actions = usePlaybackActions();
  const { canPlay } = useAvailability();
  const { offline } = useRealtime();
  const edits = usePlaylistActions();
  const failure = usePlaylistFailure(id);
  // Deleted on another device: the server's 404 wins over the copy loaded before it.
  const data = isNotFound(playlist.error) ? undefined : playlist.data;
  const items = data?.items;
  const tracks = useMemo(() => items?.map(item => item.track) ?? [], [items]);
  const keys = useMemo(() => items?.map(item => item.itemId), [items]);
  const mine = Boolean(data) && state.status === 'signedIn' && data!.ownerId === state.user.id && !offline;
  const context = useMemo((): PlaybackContext => ({ type: 'playlist', id, title: data?.name ?? '' }), [data?.name, id]);
  const play = useCallback((shuffle: boolean, start?: number) => actions.playTracks(tracks, { start, shuffle, context }), [actions, context, tracks]);
  const onPlay = useCallback((index: number) => play(false, index), [play]);
  // A smart playlist's songs come from its rules: none are removed by hand.
  const smart = Boolean(data?.smart);
  const rowMenu = useCallback((index: number) => (mine && !smart && keys?.[index] ? { playlist: { id, itemId: keys[index]! } } : undefined), [id, keys, mine, smart]);

  if (!data) {
    if (isNotFound(playlist.error)) return <PageState message="This playlist was deleted." />;
    if (playlist.isError) return <PageState message={loadFailure(playlist.error).description} onRetry={() => void playlist.refetch()} />;
    return <PageState loading />;
  }
  const playable = tracks.some(canPlay);
  const remove = () => Alert.alert(`Delete “${data.name}”?`, 'This can’t be undone.', [
    { text: 'Cancel', style: 'cancel' },
    // The page waits for the server, so a refusal is told here, on the playlist still there.
    { text: 'Delete Playlist', style: 'destructive', onPress: () => void edits.remove(data.id).then(() => router.back(), () => undefined) },
  ]);
  const more: MenuAction[] = [
    ...(playable ? queueActions : []),
    ...(mine ? [{ id: 'delete', title: 'Delete Playlist', image: 'trash', destructive: true }] : []),
  ];
  const onMore = (choice: string) => {
    if (choice === 'delete') return remove();
    if (choice === 'next' || choice === 'last') {
      actions.enqueue(tracks.filter(canPlay), choice);
      playbackStatus.report(queuedNotice(data.name, choice));
    }
  };
  const count = tracks.length ? songCountLabel(tracks.length, { durationMs: data.durationMs, separator: ', ' }) : null;

  return <TrackListPage
    art={<CollectionArt artworks={data.artworks} size={artSize} />}
    tint={data.artworks[0]?.color}
    title={data.name}
    credit={state.status === 'signedIn' && data.ownerId === state.user.id ? undefined : data.ownerName}
    facts={[smart ? 'Smart Playlist' : 'Playlist', count].filter(Boolean).join(' · ')}
    buttons={<>
      {tracks.length > 0 && <SystemButton label="Play" icon="play.fill" prominent disabled={!playable} onPress={() => play(false)} />}
      {tracks.length > 0 && <SystemButton icon="shuffle" accessibilityLabel="Shuffle" disabled={!playable} onPress={() => play(true)} />}
      <View style={styles.spacer} />
      {more.length > 0 && <SystemButton icon="ellipsis" accessibilityLabel={`More options for ${data.name}`} menu={{ actions: more, onAction: onMore }} />}
    </>}
    description={failure ?? data.description}
    tracks={tracks}
    keys={keys}
    rowMenu={rowMenu}
    onPlay={onPlay}
    empty={<Empty title="No songs yet" description="Add songs from any song’s menu with Add to playlist." />}
  />;
}

function Empty({ title, description }: { title: string; description: string }) {
  return <View style={styles.empty}>
    <Text style={type.title3}>{title}</Text>
    <Text style={styles.emptyText}>{description}</Text>
  </View>;
}

const styles = StyleSheet.create({
  spacer: { flex: 1 },
  empty: { marginTop: 60, gap: 12 },
  emptyText: { ...type.body, color: colors.secondary },
});
