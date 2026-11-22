import { queryKeys, type AlbumSummary, type AlbumType, type HistoryItem, type PlaybackContext, type TrackSummary } from '@squirmy/contracts';
import { formatTotalDuration } from '@squirmy/client-core';
import { useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, FlatList, Platform, Pressable, Share, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Extrapolation, interpolate, interpolateColor, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { useAccount, useSignedInApi, useWantlistEnabled, type Api } from '../account/AccountProvider';
import { albumExpanding } from '../data/albums';
import { fallbackTint } from '../data/color';
import { useLibraryActions, useLiked, usePlaylistActions } from '../data/library';
import { useAlbum, useArtist, useGenreAlbums, useHistory, useLikedTracks, usePlaylist } from '../data/queries';
import type { BrowseProps } from '../Library';
import { useRealtime } from '../data/realtime';
import {
  useAvailability, useDownloadActions, useDownloadedAlbum, useDownloadedLikes, useDownloadedPlaylist,
} from '../downloads/DownloadsProvider';
import { albumCollectionId, likedId as likedDownloadId, playlistCollectionId } from '../downloads/model';
import { useNotice } from '../Notice';
import { usePlaybackActions } from '../playback';
import { createThemedStyles, useColors } from '../theme';
import { AlbumNavButton, AlbumPlaybackButtons, type AlbumNavProps, type AlbumPlaybackProps } from './AlbumButtons';
import { AlbumStatusBlur } from './AlbumStatusBlur';
import { AlbumMetadata, type AlbumMetadataProps } from './AlbumMetadata';
import { CollectionGridRow } from './BrowseControls';
import { useDownloadControl } from './DownloadControl';
import {
  albumCollection, artistCollection, CollectionCover, CollectionRail, EmptyState, gutter, likedCollection, nearEnd, playlistCollection,
  QueryState, recentCollection, SectionTitle, tapFeedback, useBackSwipeOnly, useOfflineDim, type Collection,
} from './shared';
import { uniqueTracks } from './loadAll';
import { useStartGuard } from './pending';
import { underStatusBar, useRefreshControl } from './refresh';
import { displayFontScale } from '../fontScale';
import { SongList, useSongListItems, type SongListProps } from './SongList';
import { chunk, type SongListItems, type SongRowItem } from './rows';
import { usePlayAll } from './usePlayAll';
import { ZoomTarget } from './ZoomLink';

const albumNavSize = 44;
/** Rows drawn per batch, and screens' worth kept around the visible part, by long song lists. */
const listBatch = 14;
const listWindow = 7;
const gridRowKey = (row: readonly Collection[]) => row[0]!.key;

export type PageProps = BrowseProps & { id: string; onBack: () => void };

const typeNames: Record<AlbumType, string> = {
  album: 'Album', ep: 'EP', single: 'Single', compilation: 'Compilation', live: 'Live', soundtrack: 'Soundtrack', other: 'Release',
};

/** Discography groups on an artist page, in order. */
const discography: { title: string; types: readonly AlbumType[] }[] = [
  { title: 'Albums', types: ['album'] },
  { title: 'EPs & Singles', types: ['ep', 'single'] },
  { title: 'Live', types: ['live'] },
  { title: 'Compilations', types: ['compilation', 'soundtrack', 'other'] },
];

type DetailProps = {
  item: Collection;
  tint: string | null;
  title: string;
  artist?: string;
  artistLinks?: AlbumMetadataProps['artistLinks'];
  info: string;
  buttons?: AlbumPlaybackProps['actions'];
  nav: readonly (AlbumNavProps | false)[];
  /** A line under the buttons, such as the download's progress. */
  status?: ReactNode;
  description?: string | null;
  onBack: () => void;
  onEndReached?: () => void;
  /** Reloads what the page shows, for pull to refresh. */
  onRefresh: () => Promise<unknown>;
  bottomInset: number;
  /** Shown under the header; with `list`, above its rows. */
  children?: ReactNode;
  /** A long list of songs, drawn as it scrolls into view rather than all at once. */
  list?: SongListItems & { footer?: ReactElement | false };
};

/**
 * The page a collection zooms open into: its cover over the collection's tint, the title,
 * the play buttons, and the content below. Scrolling past the cover blurs the status bar;
 * once the title scrolls under the buttons, they get a bar of their own with the title in it.
 */
function DetailPage({
  item, tint, title, artist, artistLinks, info, buttons, nav, status, description, onBack, onEndReached, onRefresh, bottomInset, children, list,
}: DetailProps) {
  const colors = useColors();
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const scrollOffset = useSharedValue(0);
  const refreshControl = useRefreshControl(onRefresh, top);
  const statusBar = underStatusBar(top);
  const inset = statusBar.inset;
  const onScroll = useAnimatedScrollHandler(event => {
    // Measured from the page's top edge, so it reads the same with or without a content inset.
    scrollOffset.value = event.contentOffset.y + inset;
    if (onEndReached && nearEnd(event)) scheduleOnRN(onEndReached);
  });
  // Leave the gradient uninterrupted until the artwork approaches the status bar.
  const blurStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollOffset.value, [albumNavSize, albumNavSize + 20], [0, 1], Extrapolation.CLAMP),
  }));
  // Fill whatever shows above the header (the status bar inset, an overscroll) with its tint.
  const overscrollStyle = useAnimatedStyle(() => {
    const visible = inset - scrollOffset.value;
    return { transform: [{ translateY: visible > 0 ? visible + 1 : 0 }] };
  });
  const artSize = Math.min(238, Math.floor(width * 0.60));
  const artRadius = item.round ? artSize / 2 : 17;
  // How far the page scrolls before the header's title (below the cover's margins) reaches the bar.
  const titleUnderBar = styles.art.marginTop + artSize + styles.art.marginBottom;
  const barStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollOffset.value, [titleUnderBar, titleUnderBar + 24], [0, 1], Extrapolation.CLAMP),
  }));
  const headerColor = tint ? interpolateColor(colors.albumTint, [0, 1], [colors.background, tint], 'RGB', { gamma: 1 }) : colors.background;
  const renderRow = list?.renderItem;
  const renderItem = useCallback((info: { item: SongRowItem }) => <View style={styles.trackList}>{renderRow!(info)}</View>, [renderRow, styles]);
  const header = <>
    <View style={[styles.header, { paddingTop: statusBar.contentTop + albumNavSize + 12 }]}>
      {tint && <LinearGradient pointerEvents="none" colors={[headerColor, colors.background]}
        locations={[0, 1]} style={StyleSheet.absoluteFill} />}
      {/* The shadow needs the cover's shape and an opaque fill to be drawn efficiently. */}
      <ZoomTarget style={StyleSheet.flatten([styles.art, { borderRadius: artRadius }])}><CollectionCover item={item} size={artSize} radius={artRadius} /></ZoomTarget>
      <AlbumMetadata title={title} artist={artist} artistLinks={artistLinks} info={info} />
      {buttons && buttons.length > 0 && <AlbumPlaybackButtons title={title} actions={buttons} />}
      {status}
    </View>
    {description ? <ExpandableText text={description} lines={6} /> : null}
    {children}
  </>;

  return <View style={styles.page}>
    <Animated.View pointerEvents="none" style={[styles.overscrollFill, { backgroundColor: headerColor }, overscrollStyle]} />
    <Animated.View pointerEvents="none" style={[styles.status, { height: top }, blurStyle]}>
      <AlbumStatusBlur />
    </Animated.View>
    <Animated.View pointerEvents="none" style={[styles.status, styles.bar, { height: top + albumNavSize + 12 }, barStyle]}>
      <AlbumStatusBlur solid />
    </Animated.View>
    <View pointerEvents="box-none" style={[styles.nav, { top: top + 6 }]}>
      <AlbumNavButton icon="chevron.left" label="Go back" onPress={onBack} />
      {/* Hidden from VoiceOver: the header's own title already names the page. */}
      <Animated.Text numberOfLines={1} maxFontSizeMultiplier={displayFontScale} accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants" style={[styles.barTitle, barStyle]}>{title}</Animated.Text>
      <View style={styles.navActions}>
        {nav.filter((button): button is AlbumNavProps => Boolean(button)).map(button => <AlbumNavButton key={button.label} {...button} />)}
      </View>
    </View>
    {list ? (
      <Animated.FlatList data={list.data} renderItem={renderItem} keyExtractor={list.keyExtractor}
        ListHeaderComponent={header} ListFooterComponent={list.footer || undefined}
        initialNumToRender={listBatch} maxToRenderPerBatch={listBatch} windowSize={listWindow}
        contentInsetAdjustmentBehavior="never" onScroll={onScroll} scrollEventThrottle={16}
        refreshControl={refreshControl} {...statusBar.props} contentContainerStyle={{ paddingBottom: bottomInset }}
        showsVerticalScrollIndicator={false} />
    ) : (
      <Animated.ScrollView contentInsetAdjustmentBehavior="never" onScroll={onScroll} scrollEventThrottle={16}
        refreshControl={refreshControl} {...statusBar.props} contentContainerStyle={{ paddingBottom: bottomInset }}
        showsVerticalScrollIndicator={false}>
        {header}
      </Animated.ScrollView>
    )}
  </View>;
}

/** A bio or description cut at `lines`; when it is cut, a tap shows all of it and another cuts it again. */
function ExpandableText({ text, lines }: { text: string; lines: number }) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  return <Pressable disabled={!cut} onPress={() => { tapFeedback(); setExpanded(!expanded); }} style={styles.descriptionBlock}
    accessibilityRole={cut ? 'button' : 'text'} accessibilityHint={cut ? (expanded ? 'Shows less' : 'Shows the whole text') : undefined}>
    <Text style={styles.description} numberOfLines={expanded ? undefined : lines}>{text}</Text>
    {cut && <Text style={styles.moreLabel}>{expanded ? 'Less' : 'More'}</Text>}
    {/* The whole text, laid out unseen, to tell whether the visible copy is cut. */}
    <Text style={[styles.description, styles.measure]} onTextLayout={event => setCut(event.nativeEvent.lines.length > lines)}
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{text}</Text>
  </Pressable>;
}

/** A page whose data has not arrived: the back button, then loading or the failure. */
function PageFallback({ query, what, onBack }: { query: Parameters<typeof QueryState>[0]['query']; what: string; onBack: () => void }) {
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  return <View style={[styles.page, { paddingTop: top + 8 }]}>
    <View style={styles.fallbackNav}><AlbumNavButton icon="chevron.left" label="Go back" onPress={onBack} /></View>
    {query.isError || query.isPending
      ? <QueryState query={query} what={what} />
      : <EmptyState icon="music.note" title="Not available" description="Go back to browse your library." />}
  </View>;
}

function TrackSection({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  const styles = useStyles();
  return <>
    <View style={styles.trackListHeader}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={styles.trackListTitle}>{title}</Text>
      {detail && <Text style={styles.trackCount}>{detail}</Text>}
    </View>
    {children && <View style={styles.trackList}>{children}</View>}
  </>;
}

function songCount(tracks: readonly TrackSummary[], durationMs = tracks.reduce((sum, track) => sum + track.durationMs, 0)) {
  return `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'} · ${formatTotalDuration(durationMs)}`;
}

function share(message: string) {
  tapFeedback();
  void Share.share({ message }).catch(() => Alert.alert('Sharing unavailable'));
}

/** Play and Shuffle, for a list with something playable in it. */
function playButtons(
  tracks: readonly TrackSummary[], canPlay: (track: TrackSummary) => boolean, play: (shuffle: boolean) => void,
  busy: 'play' | 'shuffle' | null = null,
): AlbumPlaybackProps['actions'] {
  if (!tracks.some(canPlay)) return [];
  return [
    { label: 'Play', symbol: 'play.fill', onPress: () => play(false), busy: busy === 'play' },
    { label: 'Shuffle', symbol: 'shuffle', onPress: () => play(true), busy: busy === 'shuffle' },
  ];
}

export function AlbumScreen({ id, onBack, onOpen, onTrackMenu, link, bottomInset = 155 }: PageProps) {
  const album = useAlbum(id);
  const queryClient = useQueryClient();
  const kept = useDownloadedAlbum(id);
  const data = album.data ?? kept;
  const actions = usePlaybackActions();
  const { canPlay, offline } = useAvailability();
  const download = useDownloadActions();
  const liked = useLiked('album', id, data?.liked);
  const { setLiked, want } = useLibraryActions();
  const wantlist = useWantlistEnabled();
  const control = useDownloadControl(albumCollectionId(id), data?.title ?? '',
    album.data?.discs.some(disc => disc.tracks.some(track => track.availability === 'server')) ? () => download.album(album.data!) : null);
  useBackSwipeOnly();
  if (!data) return <PageFallback query={album} what="this album" onBack={onBack} />;
  const tracks = data.discs.flatMap(disc => disc.tracks);
  // Not "0 songs · 1 min" with a wantlist button that turns into Play under the finger.
  const expanding = album.isPlaceholderData || albumExpanding(album.data, queryClient.getQueryState(queryKeys.album(id))?.dataUpdateCount ?? 0);
  const context: PlaybackContext = { type: 'album', id: data.id, title: data.title };
  const play = (shuffle?: boolean, start?: number) => {
    tapFeedback();
    actions.playTracks(tracks, { start, shuffle, context });
  };
  const owned = data.availability === 'partial' ? `${data.ownedTrackCount} of ${data.trackCount} in your library` : null;
  const wantable = wantlist && data.availability !== 'full' && !data.wanted && !offline;
  const buttons = playButtons(tracks, canPlay, play);
  const wantButton = offline || !wantlist ? [] : [{ label: data.wanted ? 'On your wantlist' : 'Add to wantlist', symbol: data.wanted ? 'star.fill' : 'star',
    onPress: () => {
      if (data.wanted) return;
      tapFeedback();
      want('album', data.id, data.title);
    } }];

  const artistLinks = data.artists.map(artist => ({ name: artist.name, open: () => { tapFeedback(); onOpen(link('artist', artist.id)); } }));

  return <DetailPage item={albumCollection(data, link)} tint={data.artwork?.color ?? fallbackTint} title={data.title}
    artist={data.artistCredit} artistLinks={artistLinks}
    info={[typeNames[data.type], data.genres[0], data.year, owned].filter(Boolean).join('  ·  ')}
    buttons={buttons.length || expanding ? buttons : wantButton} status={control.status}
    nav={[
      // The placeholder does not know whether the album is liked.
      !album.isPlaceholderData && { icon: liked ? 'heart.fill' : 'heart', label: liked ? `Unlike ${data.title}` : `Like ${data.title}`, selected: liked,
        onPress: () => { tapFeedback(); setLiked('album', data.id, !liked); } },
      control.nav,
      buttons.length > 0 && wantable && { icon: 'star', label: `Add ${data.title} to your wantlist`,
        onPress: () => { tapFeedback(); want('album', data.id, data.title); } },
      { icon: 'square.and.arrow.up', label: `Share ${data.title}`, onPress: () => share(`${data.title} · ${data.artistCredit}`) },
    ]}
    description={data.description} onBack={onBack} onRefresh={album.refetch} bottomInset={bottomInset}>
    <TrackSection title="Tracklist" detail={tracks.length ? songCount(tracks, data.durationMs) : undefined}>
      {tracks.length ? <SongList tracks={tracks} numbered onPlay={start => play(undefined, start)} onTrackMenu={track => onTrackMenu(track)} />
        : expanding ? <ActivityIndicator style={{ marginVertical: 28 }} accessibilityLabel="Loading songs" />
          : <EmptyState icon="music.note" title="No songs listed" description="The server doesn’t know this album’s songs yet." />}
    </TrackSection>
  </DetailPage>;
}

/** Liked Songs, listening history, or one of the user's playlists. */
export function PlaylistScreen(props: PageProps) {
  if (props.id === 'liked') return <LikedScreen {...props} />;
  if (props.id === 'recent') return <HistoryScreen {...props} />;
  return <UserPlaylistScreen {...props} />;
}

type PlayAll = ReturnType<typeof usePlayAll<unknown>>;
const likedPage = (api: Api, cursor: string, limit: number) => api.userdata.likes('track', { cursor, limit });
const historyPage = (api: Api, cursor: string, limit: number) => api.userdata.history({ cursor, limit });
/** Each song once, at its latest play: the page lists songs, not every play of them. */
const historyTracks = (items: readonly HistoryItem[]) => uniqueTracks(items.map(item => item.track));

function TrackListPage({ item, title, info, tracks, playAll, context, empty, loadMore, loadingMore, refresh, download, props }: {
  item: Collection;
  title: string;
  info: string;
  tracks: readonly TrackSummary[];
  /** Loads the rest of a list shown in part before playing it; without it, `tracks` is played as it is. */
  playAll?: PlayAll;
  context: PlaybackContext;
  empty: { title: string; description: string };
  loadMore: () => void;
  loadingMore: boolean;
  refresh: () => Promise<unknown>;
  download?: ReturnType<typeof useDownloadControl>;
  props: PageProps;
}) {
  const actions = usePlaybackActions();
  const { canPlay } = useAvailability();
  const play = (shuffle?: boolean, start?: number) => {
    tapFeedback();
    const playTracks = (all: readonly TrackSummary[]) => actions.playTracks(all, { start, shuffle, context });
    if (playAll) playAll.run(start, Boolean(shuffle), playTracks);
    else playTracks(tracks);
  };
  const songs = useSongListItems({ tracks, onPlay: start => play(undefined, start), onTrackMenu: track => props.onTrackMenu(track) });
  return <DetailPage item={item} tint={null} title={title} info={info} buttons={playButtons(tracks, canPlay, play, playAll?.busy)}
    nav={download ? [download.nav] : []} status={download?.status}
    onBack={props.onBack} onEndReached={loadMore} onRefresh={refresh} bottomInset={props.bottomInset ?? 155}
    list={tracks.length ? { ...songs, footer: loadingMore && <ActivityIndicator style={{ marginVertical: 20 }} /> } : undefined}>
    {tracks.length ? <TrackSection title="Songs" detail={songCount(tracks)} />
      : <EmptyState icon={item.special === 'liked' ? 'heart' : 'clock.arrow.circlepath'} {...empty} />}
  </DetailPage>;
}

function LikedScreen(props: PageProps) {
  const liked = useLikedTracks();
  const playAll = usePlayAll({ list: liked, fetchPage: likedPage, tracksOf: items => [...items] });
  const kept = useDownloadedLikes();
  const download = useDownloadActions();
  const tracks = liked.data ? liked.items : kept;
  const control = useDownloadControl(likedDownloadId, 'Liked Songs',
    liked.items.some(track => track.availability === 'server') ? () => download.liked(liked.items) : null);
  useBackSwipeOnly();
  if (!tracks) return <PageFallback query={liked} what="your liked songs" onBack={props.onBack} />;
  return <TrackListPage item={likedCollection(props.link)} title="Liked Songs" info="Playlist" tracks={tracks} download={control}
    playAll={liked.data ? playAll : undefined}
    context={{ type: 'liked', id: null, title: 'Liked Songs' }} loadMore={liked.loadMore} loadingMore={liked.isFetchingNextPage} refresh={liked.refetch}
    empty={{ title: 'No liked songs yet', description: 'Tap the heart on any song to add it to Liked Songs.' }} props={props} />;
}

function HistoryScreen(props: PageProps) {
  const history = useHistory();
  const playAll = usePlayAll({ list: history, fetchPage: historyPage, tracksOf: historyTracks });
  const tracks = useMemo(() => historyTracks(history.items), [history.items]);
  useBackSwipeOnly();
  if (!history.data) return <PageFallback query={history} what="your history" onBack={props.onBack} />;
  return <TrackListPage item={recentCollection(props.link)} title="Recently Played" info="Listening history"
    tracks={tracks} playAll={playAll} context={{ type: 'history', id: null, title: 'Recently Played' }}
    loadMore={history.loadMore} loadingMore={history.isFetchingNextPage} refresh={history.refetch}
    empty={{ title: 'Nothing played yet', description: 'Play a song and it will appear in your history.' }} props={props} />;
}

function UserPlaylistScreen({ id, onBack, onOpen, onTrackMenu, link, bottomInset = 155 }: PageProps) {
  const { state } = useAccount();
  const playlist = usePlaylist(id);
  const kept = useDownloadedPlaylist(id);
  const data = playlist.data ?? kept;
  const actions = usePlaybackActions();
  const { canPlay } = useAvailability();
  const { offline } = useRealtime();
  const edits = usePlaylistActions();
  const download = useDownloadActions();
  const [editing, setEditing] = useState(false);
  const control = useDownloadControl(playlistCollectionId(id), data?.name ?? '',
    playlist.data?.items.some(item => item.track.availability === 'server') ? () => download.playlist(playlist.data!) : null);
  const items = data?.items;
  const tracks = useMemo(() => items?.map(item => item.track) ?? [], [items]);
  // The kept copy has no item ids, and edits need the server.
  const mine = Boolean(data) && state.status === 'signedIn' && data!.ownerId === state.user.id && Boolean(playlist.data) && !offline;
  const play = (shuffle?: boolean, start?: number) => {
    if (!data) return;
    tapFeedback();
    actions.playTracks(tracks, { start, shuffle, context: { type: 'playlist', id: data.id, title: data.name } });
  };
  const itemIds = useMemo(() => items?.map(item => item.itemId) ?? [], [items]);
  const songListProps: SongListProps = {
    tracks,
    onPlay: start => play(undefined, start),
    onTrackMenu: (track, index) => onTrackMenu(track, mine ? { id, itemId: itemIds[index]! } : undefined),
    playlist: mine ? {
      id, itemIds, editing,
      onMove: (itemId, toIndex) => edits.move(id, itemId, toIndex),
      onRemove: itemId => edits.removeItem(id, itemId),
    } : undefined,
  };
  const songs = useSongListItems(songListProps);
  useBackSwipeOnly();
  if (!data) return <PageFallback query={playlist} what="this playlist" onBack={onBack} />;
  const rename = () => onOpen({ pathname: '/name-playlist', params: { mode: 'rename', id: data.id, name: data.name } });
  const remove = () => Alert.alert(`Delete “${data.name}”?`, 'This can’t be undone.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete Playlist', style: 'destructive', onPress: () => {
      edits.remove(data.id);
      onBack();
    } },
  ]);
  const manage = () => {
    tapFeedback();
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({
        title: data.name, options: ['Rename', 'Delete Playlist', 'Cancel'], destructiveButtonIndex: 1, cancelButtonIndex: 2,
      }, index => {
        if (index === 0) rename();
        if (index === 1) remove();
      });
    } else {
      Alert.alert(data.name, undefined, [
        { text: 'Delete Playlist', style: 'destructive', onPress: remove },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  return <DetailPage item={playlistCollection(data, link)} tint={data.artworks[0]?.color ?? null} title={data.name}
    artist={state.status === 'signedIn' && data.ownerId === state.user.id ? undefined : data.ownerName} info="Playlist"
    buttons={playButtons(tracks, canPlay, play)} description={data.description} status={control.status}
    nav={[
      control.nav,
      mine && Platform.OS === 'ios' && tracks.length > 1 && { icon: editing ? 'checkmark' : 'arrow.up.arrow.down',
        label: editing ? 'Finish reordering' : 'Reorder songs', selected: editing, onPress: () => { tapFeedback(); setEditing(!editing); } },
      mine && { icon: 'ellipsis', label: `Manage ${data.name}`, onPress: manage },
      { icon: 'square.and.arrow.up', label: `Share ${data.name}`, onPress: () => share(data.name) },
    ]}
    // Reordering drags rows within one native list, so while editing every row is drawn.
    onBack={onBack} onRefresh={playlist.refetch} bottomInset={bottomInset} list={tracks.length && !editing ? songs : undefined}>
    {tracks.length ? <TrackSection title="Songs" detail={songCount(tracks, data.durationMs)}>
      {editing && <SongList {...songListProps} />}
    </TrackSection> : <EmptyState icon="music.note.list" title="No songs yet"
      description="Add songs from any song’s menu with Add to playlist." />}
  </DetailPage>;
}

export function ArtistScreen({ id, onBack, onTrackMenu, link, bottomInset = 155 }: PageProps) {
  const styles = useStyles();
  const api = useSignedInApi();
  const notify = useNotice();
  const artist = useArtist(id);
  const actions = usePlaybackActions();
  const { canPlay, offline } = useAvailability();
  const liked = useLiked('artist', id, artist.data?.liked);
  const { setLiked } = useLibraryActions();
  const starts = useStartGuard();
  useBackSwipeOnly();
  if (!artist.data) return <PageFallback query={artist} what="this artist" onBack={onBack} />;
  const data = artist.data;
  const top = data.topTracks;
  const context: PlaybackContext = { type: 'artist', id: data.id, title: data.name };
  const play = (shuffle?: boolean, start?: number) => {
    tapFeedback();
    actions.playTracks(top, { start, shuffle, context });
  };
  const owned = (album: AlbumSummary) => album.availability === 'full' || album.availability === 'partial';
  const radio = () => {
    if (!api) return;
    tapFeedback();
    starts.run('radio', () => api.radio.artist(data.id).then(actions.playRadio, () => notify(`Couldn’t start a radio for ${data.name}.`)));
  };
  const startingRadio = starts.pending('radio');
  const groups = discography
    .map(group => ({ title: group.title, albums: data.albums.filter(album => group.types.includes(album.type)) }))
    .filter(group => group.albums.length);

  return <DetailPage item={artistCollection(data, link)} tint={data.image?.color ?? null} title={data.name}
    info={['Artist', ...data.genres.slice(0, 2)].join('  ·  ')}
    buttons={playButtons(top, canPlay, play)} description={data.bio}
    nav={[
      { icon: liked ? 'heart.fill' : 'heart', label: liked ? `Unlike ${data.name}` : `Like ${data.name}`, selected: liked,
        onPress: () => { tapFeedback(); setLiked('artist', data.id, !liked); } },
      data.inLibrary && !offline && { icon: 'dot.radiowaves.left.and.right', busy: startingRadio, onPress: radio,
        label: startingRadio ? `Starting a radio for ${data.name}` : `Start a radio for ${data.name}` },
      { icon: 'square.and.arrow.up', label: `Share ${data.name}`, onPress: () => share(data.name) },
    ]}
    onBack={onBack} onRefresh={artist.refetch} bottomInset={bottomInset}>
    {top.length > 0 && <TrackSection title="Top songs">
      <SongList tracks={top.slice(0, 5)} onPlay={start => play(undefined, start)} onTrackMenu={track => onTrackMenu(track)} />
    </TrackSection>}
    {groups.map(group => <View key={group.title} style={styles.section}>
      <SectionTitle title={group.title} />
      <CollectionRail items={group.albums.map(album => ({
        ...albumCollection(album, link, [album.year, owned(album) ? null : 'Not in library'].filter(Boolean).join(' · ') || typeNames[album.type]),
        dim: !owned(album),
      }))} />
    </View>)}
    {data.similar.length > 0 && <View style={styles.section}>
      <SectionTitle title="Similar artists" />
      <CollectionRail items={data.similar.map(similar => artistCollection(similar, link))} size={110} />
    </View>}
  </DetailPage>;
}

/** The albums of one genre, from the genre tiles on Search. */
export function GenreScreen({ id, onBack, link, bottomInset = 155 }: PageProps) {
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const albums = useGenreAlbums(id);
  const offlineDim = useOfflineDim();
  const refreshControl = useRefreshControl(albums.refetch);
  const columns = width >= 650 ? 4 : 3;
  const size = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);
  const rows = useMemo(() => chunk(albums.items.map(album => offlineDim(albumCollection(album, link))), columns), [albums.items, columns, link, offlineDim]);
  const renderRow = useCallback(({ item: row }: { item: Collection[] }) => <CollectionGridRow items={row.map(item => ({
    id: item.key, title: item.title, subtitle: item.subtitle, size, cover: <CollectionCover item={item} size={size} />, href: item.href, dim: item.dim,
  }))} />, [size]);
  return <View style={[styles.page, { paddingTop: top + 8 }]}>
    <View style={styles.fallbackNav}><AlbumNavButton icon="chevron.left" label="Go back" onPress={onBack} /></View>
    <FlatList data={rows} renderItem={renderRow} keyExtractor={gridRowKey} refreshControl={refreshControl}
      initialNumToRender={listBatch} maxToRenderPerBatch={listBatch} windowSize={listWindow}
      contentContainerStyle={[styles.genreBody, { paddingBottom: bottomInset }]} showsVerticalScrollIndicator={false}
      onEndReached={albums.loadMore} onEndReachedThreshold={1.5}
      ListHeaderComponent={<>
        <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={styles.genreTitle}>{id}</Text>
        {!albums.data && <QueryState query={albums} what={id} />}
      </>}
      ListFooterComponent={albums.isFetchingNextPage ? <ActivityIndicator style={styles.more} /> : undefined} />
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  page: { flex: 1, overflow: 'hidden', backgroundColor: colors.background },
  nav: { position: 'absolute', left: 0, right: 0, zIndex: 2, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: gutter },
  barTitle: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  // Android has no blur here, so its bar is the page colour.
  bar: Platform.OS === 'android' ? { backgroundColor: colors.background } : {},
  navActions: { flexDirection: 'row', gap: 10 },
  fallbackNav: { paddingHorizontal: gutter, alignItems: 'flex-start' },
  overscrollFill: { position: 'absolute', bottom: '100%', height: '100%', left: 0, right: 0 },
  status: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 },
  header: { alignItems: 'center', paddingHorizontal: gutter },
  art: { marginTop: 8, marginBottom: 21, backgroundColor: colors.surface, shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.42, shadowRadius: 22 },
  descriptionBlock: { marginHorizontal: gutter, marginTop: 18 },
  description: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  moreLabel: { color: colors.accent, fontSize: 14, fontWeight: '600', marginTop: 4 },
  measure: { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0 },
  trackListHeader: { marginTop: 24, marginHorizontal: gutter, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: 8 },
  trackListTitle: { color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.4 },
  trackCount: { color: colors.quiet, fontSize: 12, fontWeight: '600' },
  trackList: { marginHorizontal: gutter - 4 },
  section: { marginTop: 28 },
  genreBody: { paddingHorizontal: gutter },
  genreTitle: { color: colors.text, fontSize: 34, letterSpacing: -1.4, fontWeight: '800', marginTop: 10, marginBottom: 18 },
  more: { marginVertical: 20 },
}));
