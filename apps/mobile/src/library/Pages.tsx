import type { AlbumSummary, AlbumType, PlaybackContext, TrackSummary } from '@squirmy/contracts';
import { formatTotalDuration } from '@squirmy/client-core';
import { LinearGradient } from 'expo-linear-gradient';
import { useState, type ReactNode } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Share, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Extrapolation, interpolate, interpolateColor, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { useAccount, useSignedInApi, useWantlistEnabled } from '../account/AccountProvider';
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
import { usePlaybackState } from '../playback';
import { createThemedStyles, useColors } from '../theme';
import { AlbumNavButton, AlbumPlaybackButtons, type AlbumNavProps, type AlbumPlaybackProps } from './AlbumButtons';
import { AlbumStatusBlur } from './AlbumStatusBlur';
import { AlbumMetadata, CollectionGrid, type AlbumMetadataProps } from './BrowseControls';
import { useDownloadControl } from './DownloadControl';
import {
  albumCollection, artistCollection, CollectionCover, CollectionRail, EmptyState, gutter, likedCollection, nearEnd, playlistCollection,
  QueryState, recentCollection, SectionTitle, tapFeedback, useBackSwipeOnly, useOfflineDim, type Collection,
} from './shared';
import { useStartGuard } from './pending';
import { underStatusBar, useRefreshControl } from './refresh';
import { displayFontScale } from '../fontScale';
import { SongList } from './SongList';
import { ZoomTarget } from './ZoomLink';

const albumNavSize = 44;

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
  children: ReactNode;
};

/**
 * The page a collection zooms open into: its cover over the collection's tint, the title,
 * the play buttons, and the content below. Scrolling past the cover blurs the status bar.
 */
function DetailPage({
  item, tint, title, artist, artistLinks, info, buttons, nav, status, description, onBack, onEndReached, onRefresh, bottomInset, children,
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
  const headerColor = tint ? interpolateColor(colors.albumTint, [0, 1], [colors.background, tint], 'RGB', { gamma: 1 }) : colors.background;

  return <View style={styles.page}>
    <Animated.View pointerEvents="none" style={[styles.overscrollFill, { backgroundColor: headerColor }, overscrollStyle]} />
    <Animated.View pointerEvents="none" style={[styles.status, { height: top }, blurStyle]}>
      <AlbumStatusBlur />
    </Animated.View>
    <View pointerEvents="box-none" style={[styles.nav, { top: top + 6 }]}>
      <AlbumNavButton icon="chevron.left" label="Go back" onPress={onBack} />
      <View style={styles.navActions}>
        {nav.filter((button): button is AlbumNavProps => Boolean(button)).map(button => <AlbumNavButton key={button.label} {...button} />)}
      </View>
    </View>
    <Animated.ScrollView contentInsetAdjustmentBehavior="never" onScroll={onScroll} scrollEventThrottle={16}
      refreshControl={refreshControl} {...statusBar.props} contentContainerStyle={{ paddingBottom: bottomInset }}
      showsVerticalScrollIndicator={false}>
      <View style={[styles.header, { paddingTop: statusBar.contentTop + albumNavSize + 12 }]}>
        {tint && <LinearGradient pointerEvents="none" colors={[headerColor, colors.background]}
          locations={[0, 1]} style={StyleSheet.absoluteFill} />}
        {/* The shadow needs the cover's shape and an opaque fill to be drawn efficiently. */}
        <ZoomTarget style={StyleSheet.flatten([styles.art, { borderRadius: artRadius }])}><CollectionCover item={item} size={artSize} radius={artRadius} /></ZoomTarget>
        <AlbumMetadata title={title} artist={artist} artistLinks={artistLinks} info={info} />
        {buttons && buttons.length > 0 && <AlbumPlaybackButtons title={title} actions={buttons} />}
        {status}
      </View>
      {description ? <Text style={styles.description} numberOfLines={6}>{description}</Text> : null}
      {children}
    </Animated.ScrollView>
  </View>;
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

function TrackSection({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  const styles = useStyles();
  return <>
    <View style={styles.trackListHeader}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={styles.trackListTitle}>{title}</Text>
      {detail && <Text style={styles.trackCount}>{detail}</Text>}
    </View>
    <View style={styles.trackList}>{children}</View>
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
function playButtons(tracks: readonly TrackSummary[], canPlay: (track: TrackSummary) => boolean, play: (shuffle: boolean) => void): AlbumPlaybackProps['actions'] {
  if (!tracks.some(canPlay)) return [];
  return [
    { label: 'Play', symbol: 'play.fill', onPress: () => play(false) },
    { label: 'Shuffle', symbol: 'shuffle', onPress: () => play(true) },
  ];
}

export function AlbumScreen({ id, onBack, onOpen, onTrackMenu, link, bottomInset = 155 }: PageProps) {
  const album = useAlbum(id);
  const kept = useDownloadedAlbum(id);
  const data = album.data ?? kept;
  const { actions } = usePlaybackState();
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
    buttons={buttons.length ? buttons : wantButton} status={control.status}
    nav={[
      { icon: liked ? 'heart.fill' : 'heart', label: liked ? `Unlike ${data.title}` : `Like ${data.title}`, selected: liked,
        onPress: () => { tapFeedback(); setLiked('album', data.id, !liked); } },
      control.nav,
      buttons.length > 0 && wantable && { icon: 'star', label: `Add ${data.title} to your wantlist`,
        onPress: () => { tapFeedback(); want('album', data.id, data.title); } },
      { icon: 'square.and.arrow.up', label: `Share ${data.title}`, onPress: () => share(`${data.title} · ${data.artistCredit}`) },
    ]}
    description={data.description} onBack={onBack} onRefresh={album.refetch} bottomInset={bottomInset}>
    <TrackSection title="Tracklist" detail={songCount(tracks, data.durationMs)}>
      <SongList tracks={tracks} numbered onPlay={start => play(undefined, start)} onTrackMenu={track => onTrackMenu(track)} />
    </TrackSection>
  </DetailPage>;
}

/** Liked Songs, listening history, or one of the user's playlists. */
export function PlaylistScreen(props: PageProps) {
  if (props.id === 'liked') return <LikedScreen {...props} />;
  if (props.id === 'recent') return <HistoryScreen {...props} />;
  return <UserPlaylistScreen {...props} />;
}

function TrackListPage({ item, title, info, tracks, context, empty, loadMore, loadingMore, refresh, download, props }: {
  item: Collection;
  title: string;
  info: string;
  tracks: readonly TrackSummary[];
  context: PlaybackContext;
  empty: { title: string; description: string };
  loadMore: () => void;
  loadingMore: boolean;
  refresh: () => Promise<unknown>;
  download?: ReturnType<typeof useDownloadControl>;
  props: PageProps;
}) {
  const { actions } = usePlaybackState();
  const { canPlay } = useAvailability();
  const play = (shuffle?: boolean, start?: number) => {
    tapFeedback();
    actions.playTracks(tracks, { start, shuffle, context });
  };
  return <DetailPage item={item} tint={null} title={title} info={info} buttons={playButtons(tracks, canPlay, play)}
    nav={download ? [download.nav] : []} status={download?.status}
    onBack={props.onBack} onEndReached={loadMore} onRefresh={refresh} bottomInset={props.bottomInset ?? 155}>
    {tracks.length ? <TrackSection title="Songs" detail={songCount(tracks)}>
      <SongList tracks={tracks} onPlay={start => play(undefined, start)} onTrackMenu={track => props.onTrackMenu(track)} />
      {loadingMore && <ActivityIndicator style={{ marginVertical: 20 }} />}
    </TrackSection> : <EmptyState icon={item.special === 'liked' ? 'heart' : 'clock.arrow.circlepath'} {...empty} />}
  </DetailPage>;
}

function LikedScreen(props: PageProps) {
  const liked = useLikedTracks();
  const kept = useDownloadedLikes();
  const download = useDownloadActions();
  const tracks = liked.data ? liked.items : kept;
  const control = useDownloadControl(likedDownloadId, 'Liked Songs',
    liked.items.some(track => track.availability === 'server') ? () => download.liked(liked.items) : null);
  useBackSwipeOnly();
  if (!tracks) return <PageFallback query={liked} what="your liked songs" onBack={props.onBack} />;
  return <TrackListPage item={likedCollection(props.link)} title="Liked Songs" info="Playlist" tracks={tracks} download={control}
    context={{ type: 'liked', id: null, title: 'Liked Songs' }} loadMore={liked.loadMore} loadingMore={liked.isFetchingNextPage} refresh={liked.refetch}
    empty={{ title: 'No liked songs yet', description: 'Tap the heart on any song to add it to Liked Songs.' }} props={props} />;
}

function HistoryScreen(props: PageProps) {
  const history = useHistory();
  useBackSwipeOnly();
  if (!history.data) return <PageFallback query={history} what="your history" onBack={props.onBack} />;
  return <TrackListPage item={recentCollection(props.link)} title="Recently Played" info="Listening history"
    tracks={history.items.map(item => item.track)} context={{ type: 'history', id: null, title: 'Recently Played' }}
    loadMore={history.loadMore} loadingMore={history.isFetchingNextPage} refresh={history.refetch}
    empty={{ title: 'Nothing played yet', description: 'Play a song and it will appear in your history.' }} props={props} />;
}

function UserPlaylistScreen({ id, onBack, onOpen, onTrackMenu, link, bottomInset = 155 }: PageProps) {
  const { state } = useAccount();
  const playlist = usePlaylist(id);
  const kept = useDownloadedPlaylist(id);
  const data = playlist.data ?? kept;
  const { actions } = usePlaybackState();
  const { canPlay } = useAvailability();
  const { offline } = useRealtime();
  const edits = usePlaylistActions();
  const download = useDownloadActions();
  const [editing, setEditing] = useState(false);
  const control = useDownloadControl(playlistCollectionId(id), data?.name ?? '',
    playlist.data?.items.some(item => item.track.availability === 'server') ? () => download.playlist(playlist.data!) : null);
  useBackSwipeOnly();
  if (!data) return <PageFallback query={playlist} what="this playlist" onBack={onBack} />;
  const tracks = data.items.map(item => item.track);
  // The kept copy has no item ids, and edits need the server.
  const mine = state.status === 'signedIn' && data.ownerId === state.user.id && Boolean(playlist.data) && !offline;
  const context: PlaybackContext = { type: 'playlist', id: data.id, title: data.name };
  const play = (shuffle?: boolean, start?: number) => {
    tapFeedback();
    actions.playTracks(tracks, { start, shuffle, context });
  };
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
    onBack={onBack} onRefresh={playlist.refetch} bottomInset={bottomInset}>
    {tracks.length ? <TrackSection title="Songs" detail={songCount(tracks, data.durationMs)}>
      <SongList tracks={tracks} onPlay={start => play(undefined, start)}
        onTrackMenu={(track, index) => onTrackMenu(track, mine ? { id: data.id, itemId: data.items[index]!.itemId } : undefined)}
        playlist={mine ? {
          id: data.id, itemIds: data.items.map(item => item.itemId), editing,
          onMove: (itemId, toIndex) => edits.move(data.id, itemId, toIndex),
          onRemove: itemId => edits.removeItem(data.id, itemId),
        } : undefined} />
    </TrackSection> : <EmptyState icon="music.note.list" title="No songs yet"
      description="Add songs from any song’s menu with Add to playlist." />}
  </DetailPage>;
}

export function ArtistScreen({ id, onBack, onTrackMenu, link, bottomInset = 155 }: PageProps) {
  const styles = useStyles();
  const api = useSignedInApi();
  const notify = useNotice();
  const artist = useArtist(id);
  const { actions } = usePlaybackState();
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
  const onScroll = useAnimatedScrollHandler(event => {
    if (nearEnd(event)) scheduleOnRN(albums.loadMore);
  });
  const refreshControl = useRefreshControl(albums.refetch);
  const columns = width >= 650 ? 4 : 3;
  const size = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);
  return <View style={[styles.page, { paddingTop: top + 8 }]}>
    <View style={styles.fallbackNav}><AlbumNavButton icon="chevron.left" label="Go back" onPress={onBack} /></View>
    <Animated.ScrollView contentContainerStyle={[styles.genreBody, { paddingBottom: bottomInset }]} showsVerticalScrollIndicator={false}
      onScroll={onScroll} scrollEventThrottle={100} refreshControl={refreshControl}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={styles.genreTitle}>{id}</Text>
      {!albums.data && <QueryState query={albums} what={id} />}
      <CollectionGrid columns={columns} items={albums.items.map(album => {
        const item = offlineDim(albumCollection(album, link));
        return { id: item.key, title: item.title, subtitle: item.subtitle, size, cover: <CollectionCover item={item} size={size} />, href: item.href, dim: item.dim };
      })} />
      {albums.isFetchingNextPage && <ActivityIndicator style={styles.more} />}
    </Animated.ScrollView>
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  page: { flex: 1, overflow: 'hidden', backgroundColor: colors.background },
  nav: { position: 'absolute', left: 0, right: 0, zIndex: 2, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: gutter },
  navActions: { flexDirection: 'row', gap: 10 },
  fallbackNav: { paddingHorizontal: gutter, alignItems: 'flex-start' },
  overscrollFill: { position: 'absolute', bottom: '100%', height: '100%', left: 0, right: 0 },
  status: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 },
  header: { alignItems: 'center', paddingHorizontal: gutter },
  art: { marginTop: 8, marginBottom: 21, backgroundColor: colors.surface, shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.42, shadowRadius: 22 },
  description: { marginHorizontal: gutter, color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 18 },
  trackListHeader: { marginTop: 24, marginHorizontal: gutter, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: 8 },
  trackListTitle: { color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.4 },
  trackCount: { color: colors.quiet, fontSize: 12, fontWeight: '600' },
  trackList: { marginHorizontal: gutter - 4 },
  section: { marginTop: 28 },
  genreBody: { paddingHorizontal: gutter },
  genreTitle: { color: colors.text, fontSize: 34, letterSpacing: -1.4, fontWeight: '800', marginTop: 10, marginBottom: 18 },
  more: { marginVertical: 20 },
}));
