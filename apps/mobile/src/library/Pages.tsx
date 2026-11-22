import {
  queryKeys, type AlbumDetail, type AlbumSummary, type AlbumType, type ArtistDetail, type HistoryItem, type HomeSection, type PlaybackContext, type TrackSummary,
} from '@squirmy/contracts';
import { albumNote, albumPresentation, canFetch, formatReleaseDate, formatTotalDuration, releaseSubtitle } from '@squirmy/client-core';
import { useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
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
import { appearsOnKey, releaseGroups } from '../data/artists';
import { useAlbum, useArtist, useGenreAlbums, useHistory, useHome, useLikedTracks, usePlaylist } from '../data/queries';
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
import { BrowseButton, CollectionGridRow } from './BrowseControls';
import { useDownloadControl } from './DownloadControl';
import { heartButton } from './heart';
import {
  albumCollection, artistCollection, CollectionCover, CollectionRail, EmptyState, gutter, likedCollection, nearEnd, playlistCollection,
  QueryState, recentCollection, SectionTitle, tapFeedback, useBackSwipeOnly, useCollectionDim, type Collection,
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

/** Tiles in a discography rail before "See all"; the rest open on a page of their own. */
const railLimit = 20;
/** Songs in a page's song section before "See all". */
const songLimit = 5;

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
    {/* Its softened bottom edge falls below the buttons, so rows scrolling up are hidden before they reach them. */}
    <Animated.View pointerEvents="none" style={[styles.status, styles.bar, { height: top + albumNavSize + 22 }, barStyle]}>
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
  // No `disabled` for an uncut text: VoiceOver would read it as dimmed.
  return <Pressable onPress={cut ? () => { tapFeedback(); setExpanded(!expanded); } : undefined} style={styles.descriptionBlock}
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

function TrackSection({ title, detail, onSeeAll, children }: { title: string; detail?: string; onSeeAll?: () => void; children?: ReactNode }) {
  const styles = useStyles();
  return <>
    <View style={styles.trackListHeader}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={styles.trackListTitle}>{title}</Text>
      {detail && <Text style={styles.trackCount}>{detail}</Text>}
      {onSeeAll && <BrowseButton label={`See all ${title.toLowerCase()}`} title="See all" icon="chevron.right" onPress={onSeeAll} />}
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
  const { canPlay, offline, viewer } = useAvailability();
  const download = useDownloadActions();
  const liked = useLiked('album', id, data?.liked);
  const { setLiked, want } = useLibraryActions();
  const wantlist = useWantlistEnabled();
  const control = useDownloadControl(albumCollectionId(id), data?.title ?? '',
    album.data?.discs.flatMap(disc => disc.tracks), () => download.album(album.data!));
  // Play pressed before the server had the track list: it starts as soon as the tracks are known.
  const [waitingPlay, setWaitingPlay] = useState<{ shuffle: boolean } | null>(null);
  const expanding = album.isPlaceholderData || albumExpanding(album.data, queryClient.getQueryState(queryKeys.album(id))?.dataUpdateCount ?? 0);
  const discs = data?.discs;
  useEffect(() => {
    if (!waitingPlay || !data) return;
    const list = data.discs.flatMap(disc => disc.tracks);
    if (list.length) actions.playTracks(list, { shuffle: waitingPlay.shuffle, context: { type: 'album', id: data.id, title: data.title } });
    if (list.length || !expanding) setWaitingPlay(null);
  }, [actions, data, discs, expanding, waitingPlay]);
  useBackSwipeOnly();
  if (!data) return <PageFallback query={album} what="this album" onBack={onBack} />;
  const tracks = data.discs.flatMap(disc => disc.tracks);
  const context: PlaybackContext = { type: 'album', id: data.id, title: data.title };
  const play = (shuffle?: boolean, start?: number) => {
    tapFeedback();
    actions.playTracks(tracks, { start, shuffle, context });
  };
  const presentation = albumPresentation(data, viewer);
  // Not "0 songs · 1 min" with buttons that change under the finger: while the server looks
  // up the songs of an album this viewer can play, Play and Shuffle wait for them.
  const waitButtons = expanding && !tracks.length && presentation === 'normal' && !offline ? (['play', 'shuffle'] as const).map(kind => ({
    label: kind === 'play' ? 'Play' : 'Shuffle', symbol: kind === 'play' ? 'play.fill' : 'shuffle', busy: waitingPlay?.shuffle === (kind === 'shuffle'),
    onPress: () => { tapFeedback(); setWaitingPlay({ shuffle: kind === 'shuffle' }); },
  })) : null;
  const buttons = waitButtons ?? playButtons(tracks, canPlay, play);
  // The wantlist is for music this viewer can't play; for someone who may fetch music nothing is.
  const unavailable = !expanding && !buttons.length;
  const wantButton = offline || !wantlist || !unavailable ? [] : [{ label: data.wanted ? 'On your wantlist' : 'Add to wantlist', symbol: data.wanted ? 'star.fill' : 'star',
    onPress: () => {
      if (data.wanted) return;
      tapFeedback();
      want('album', data.id, data.title);
    } }];

  const artistLinks = data.artists.map(artist => ({ name: artist.name, open: () => { tapFeedback(); onOpen(link('artist', artist.id)); } }));

  return <DetailPage item={albumCollection(data, link)} tint={data.artwork?.color ?? fallbackTint} title={data.title}
    artist={data.artistCredit} artistLinks={artistLinks}
    info={[typeNames[data.type], data.genres[0], data.year, albumNote(data, viewer)].filter(Boolean).join('  ·  ')}
    buttons={buttons.length ? buttons : wantButton} status={control.status}
    nav={[
      // The heart saves the album to the library. The placeholder does not know whether it is saved.
      !album.isPlaceholderData && { ...heartButton(liked, data.title),
        onPress: () => { tapFeedback(); setLiked('album', data.id, !liked, data.title); } },
      control.nav,
      { icon: 'square.and.arrow.up', label: `Share ${data.title}`, onPress: () => share(`${data.title} · ${data.artistCredit}`) },
    ]}
    description={data.description} onBack={onBack} onRefresh={album.refetch} bottomInset={bottomInset}>
    <TrackSection title="Tracklist" detail={tracks.length ? songCount(tracks, data.durationMs) : undefined}>
      {tracks.length ? <AlbumDiscs discs={data.discs} album={data} onPlay={start => play(undefined, start)} onTrackMenu={track => onTrackMenu(track)} />
        : expanding ? <ActivityIndicator style={{ marginVertical: 28 }} accessibilityLabel="Loading songs" />
          : <EmptyState icon="music.note" title="No songs listed" description="The server doesn’t know this album’s songs yet." />}
    </TrackSection>
    {tracks.length > 0 && <AlbumFooter album={data} />}
  </DetailPage>;
}

/**
 * An album's songs, under a heading per disc when there is more than one, as each disc's
 * numbering starts again at 1. `onPlay` takes the index in the whole album.
 */
function AlbumDiscs({ discs, album, onPlay, onTrackMenu }: {
  discs: readonly AlbumDetail['discs'][number][]; album: Pick<AlbumDetail, 'id' | 'artistCredit'>;
  onPlay: (start: number) => void; onTrackMenu: (track: TrackSummary) => void;
}) {
  const styles = useStyles();
  const filled = discs.filter(disc => disc.tracks.length);
  const page = useMemo(() => ({ id: album.id, artistCredit: album.artistCredit }), [album.id, album.artistCredit]);
  if (filled.length <= 1) {
    const tracks = filled[0]?.tracks ?? [];
    return <SongList tracks={tracks} numbered album={page} onPlay={onPlay} onTrackMenu={onTrackMenu} />;
  }
  let offset = 0;
  return <>
    {filled.map(disc => {
      const start = offset;
      offset += disc.tracks.length;
      return <View key={disc.disc}>
        <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={styles.discHeader}>
          {disc.title ? `Disc ${disc.disc} · ${disc.title}` : `Disc ${disc.disc}`}
        </Text>
        <SongList tracks={disc.tracks} numbered album={page} onPlay={index => onPlay(start + index)} onTrackMenu={onTrackMenu} />
      </View>;
    })}
  </>;
}

/** Under the tracklist, as on a record's back: when it came out, and who put it out. */
function AlbumFooter({ album }: { album: Pick<AlbumDetail, 'releaseDate' | 'year' | 'label'> }) {
  const styles = useStyles();
  const date = album.releaseDate ? formatReleaseDate(album.releaseDate) : null;
  const year = album.year ?? (album.releaseDate ? Number(album.releaseDate.slice(0, 4)) || null : null);
  const label = album.label ? ['℗', year, album.label].filter(Boolean).join(' ') : null;
  if (!date && !label) return null;
  return <View style={styles.albumFooter}>
    {date && <Text style={styles.albumFooterText}>{date}</Text>}
    {label && <Text style={styles.albumFooterText}>{label}</Text>}
  </View>;
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
    liked.items, () => download.liked(liked.items));
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
    playlist.data?.items.map(item => item.track), () => download.playlist(playlist.data!));
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

export function ArtistScreen({ id, onBack, onOpen, onTrackMenu, link, bottomInset = 155 }: PageProps) {
  const styles = useStyles();
  const api = useSignedInApi();
  const notify = useNotice();
  const artist = useArtist(id);
  const actions = usePlaybackActions();
  const { canPlay, offline, viewer } = useAvailability();
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
  const radio = () => {
    if (!api) return;
    tapFeedback();
    starts.run('radio', () => api.radio.artist(data.id).then(actions.playRadio, () => notify(`Couldn’t start a radio for ${data.name}.`)));
  };
  const startingRadio = starts.pending('radio');
  const placeholder = artist.isPlaceholderData;

  return <DetailPage item={artistCollection(data, link)} tint={data.image?.color ?? null} title={data.name}
    info={['Artist', ...data.genres.slice(0, 2)].join('  ·  ')}
    buttons={playButtons(top, canPlay, play)} description={data.bio}
    nav={[
      // The heart saves (follows) the artist, which puts it in the library. The placeholder
      // does not know whether the artist is saved.
      !placeholder && { ...heartButton(liked, data.name), onPress: () => { tapFeedback(); setLiked('artist', data.id, !liked, data.name); } },
      // Only when the server says a radio starts for this user (for a requester, from what it
      // can fetch too); an older server does not say, and then the library decides.
      !placeholder && (data.radio ?? (data.inLibrary || canFetch(viewer))) && !offline && { icon: 'dot.radiowaves.left.and.right', busy: startingRadio, onPress: radio,
        label: startingRadio ? `Starting a radio for ${data.name}` : `Start a radio for ${data.name}` },
      { icon: 'square.and.arrow.up', label: `Share ${data.name}`, onPress: () => share(data.name) },
    ]}
    onBack={onBack} onRefresh={artist.refetch} bottomInset={bottomInset}>
    {placeholder ? <ActivityIndicator style={styles.more} accessibilityLabel="Loading" /> : <ArtistBody artist={data} link={link} onOpen={onOpen}
      onPlay={start => play(undefined, start)} onTrackMenu={onTrackMenu} />}
  </DetailPage>;
}

/**
 * What an artist page shows under its header. Each rail stops at `railLimit` tiles, with
 * "See all" for the rest: a long discography (thousands of releases for a composer) mounted
 * in full froze the app.
 */
function ArtistBody({ artist, link, onOpen, onPlay, onTrackMenu }: {
  artist: ArtistDetail; onPlay: (start: number) => void;
} & Pick<PageProps, 'link' | 'onOpen' | 'onTrackMenu'>) {
  const styles = useStyles();
  const top = artist.topTracks;
  const groups = useMemo(() => releaseGroups(artist), [artist]);
  return <>
    {top.length > 0 && <TrackSection title="Top Songs"
      onSeeAll={top.length > songLimit ? () => onOpen(link('songs', songsId('top', artist.id))) : undefined}>
      <SongList tracks={top.slice(0, songLimit)} onPlay={onPlay} onTrackMenu={track => onTrackMenu(track)} />
    </TrackSection>}
    {groups.map(group => <View key={group.key} style={styles.section}>
      <SectionTitle title={group.title}
        onPress={group.albums.length > railLimit ? () => onOpen(link('releases', releasesId(artist.id, group.key))) : undefined} />
      {/* Gray only what does not play for this viewer (`albumPresentation`, applied by the rail). */}
      <CollectionRail items={group.albums.slice(0, railLimit).map(album => releaseCollection(album, group.key, link))} />
    </View>)}
    {artist.similar.length > 0 && <View style={styles.section}>
      <SectionTitle title="Similar Artists" />
      <CollectionRail items={artist.similar.map(similar => artistCollection(similar, link))} size={110} />
    </View>}
  </>;
}

/** A release tile on an artist's pages: its year and type, or for another artist's release, who made it. */
function releaseCollection(album: AlbumSummary, group: string, link: PageProps['link']) {
  return albumCollection(album, link, group === appearsOnKey ? album.artistCredit : releaseSubtitle(album));
}

/** The id of a page of one discography heading, `<artist>~<heading>`. */
const releasesId = (artistId: string, group: string) => `${artistId}~${group}`;
/** The id of a page of songs, `<source>~<id>`: an artist's top songs, or a Home section. */
const songsId = (source: 'top' | 'home', id: string) => `${source}~${id}`;
const splitId = (id: string) => {
  const at = id.indexOf('~');
  return at < 0 ? [id, ''] as const : [id.slice(0, at), id.slice(at + 1)] as const;
};

/** Every release under one heading of an artist's discography, from "See all". */
export function ReleasesScreen({ id, onBack, link, bottomInset = 155 }: PageProps) {
  const [artistId, key] = splitId(id);
  const artist = useArtist(artistId);
  const group = useMemo(() => artist.data && releaseGroups(artist.data).find(item => item.key === key), [artist.data, key]);
  const items = useMemo(() => group?.albums.map(album => releaseCollection(album, key, link)) ?? [], [group, key, link]);
  return <CollectionGridPage title={group?.title ?? 'Releases'} detail={artist.data?.name} items={items} onBack={onBack}
    onRefresh={artist.refetch} bottomInset={bottomInset}
    header={!artist.data || artist.isPlaceholderData ? <QueryState query={{ ...artist, isPending: artist.isPending || artist.isPlaceholderData }} what="these releases" />
      : !group && <EmptyState icon="square.stack" title="Nothing here" description="This artist has no releases under this heading." />} />;
}

/** Every song of a section that shows only its first few: an artist's top songs, or a Home row. */
export function SongsScreen(props: PageProps) {
  const [source, ref] = splitId(props.id);
  return source === 'home' ? <HomeSongsScreen sectionId={ref} props={props} /> : <TopSongsScreen artistId={ref} props={props} />;
}

function TopSongsScreen({ artistId, props }: { artistId: string; props: PageProps }) {
  const artist = useArtist(artistId);
  if (!artist.data || artist.isPlaceholderData) return <PageFallback query={artist} what="these songs" onBack={props.onBack} />;
  const data = artist.data;
  return <TrackListPage item={artistCollection(data, props.link)} title="Top Songs" info={data.name} tracks={data.topTracks}
    context={{ type: 'artist', id: data.id, title: data.name }} loadMore={noop} loadingMore={false} refresh={artist.refetch}
    empty={{ title: 'No top songs', description: 'The server has no top songs for this artist yet.' }} props={props} />;
}

function HomeSongsScreen({ sectionId, props }: { sectionId: string; props: PageProps }) {
  const home = useHome();
  const section = home.data?.sections.find((item): item is Extract<HomeSection, { kind: 'tracks' }> => item.kind === 'tracks' && item.id === sectionId);
  if (!section) return <PageFallback query={home} what="these songs" onBack={props.onBack} />;
  const item: Collection = { key: section.id, kind: 'playlist', special: 'playlist', title: section.title, subtitle: 'Home', href: props.link('songs', props.id) };
  return <TrackListPage item={item} title={section.title} info="From Home" tracks={section.tracks}
    context={{ type: 'other', id: section.id, title: section.title }} loadMore={noop} loadingMore={false} refresh={home.refetch}
    empty={{ title: 'Nothing here yet', description: 'Play some music and it shows up here.' }} props={props} />;
}

const noop = () => undefined;

/** The albums of one genre, from the genre tiles on Search. */
export function GenreScreen({ id, onBack, link, bottomInset = 155 }: PageProps) {
  const albums = useGenreAlbums(id);
  const items = useMemo(() => albums.items.map(album => albumCollection(album, link)), [albums.items, link]);
  return <CollectionGridPage title={id} items={items} onBack={onBack} onRefresh={albums.refetch} bottomInset={bottomInset}
    onEndReached={albums.loadMore} loadingMore={albums.isFetchingNextPage}
    header={!albums.data ? <QueryState query={albums} what={id} />
      : !albums.items.length && <EmptyState icon="square.stack" title="No albums yet" description={`Albums tagged ${id} show up here.`} />} />;
}

/** A titled grid of tiles, drawn as it scrolls into view: a genre's albums, or all of one discography heading. */
function CollectionGridPage({ title, detail, items, header, onBack, onRefresh, onEndReached, loadingMore = false, bottomInset }: {
  title: string;
  /** A line over the title, such as the artist whose releases these are. */
  detail?: string;
  items: readonly Collection[];
  /** Under the title: the loading state, or what to say when there is nothing. */
  header?: ReactNode;
  onBack: () => void;
  onRefresh: () => Promise<unknown>;
  onEndReached?: () => void;
  loadingMore?: boolean;
  bottomInset: number;
}) {
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const collectionDim = useCollectionDim();
  const refreshControl = useRefreshControl(onRefresh);
  const columns = width >= 650 ? 4 : 3;
  const size = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);
  const rows = useMemo(() => chunk(items.map(collectionDim), columns), [items, columns, collectionDim]);
  const renderRow = useCallback(({ item: row }: { item: Collection[] }) => <CollectionGridRow items={row.map(item => ({
    id: item.key, title: item.title, subtitle: item.subtitle, size, cover: <CollectionCover item={item} size={size} />, href: item.href, dim: item.dim,
  }))} />, [size]);
  return <View style={[styles.page, { paddingTop: top + 8 }]}>
    <View style={styles.fallbackNav}><AlbumNavButton icon="chevron.left" label="Go back" onPress={onBack} /></View>
    <FlatList data={rows} renderItem={renderRow} keyExtractor={gridRowKey} refreshControl={refreshControl}
      initialNumToRender={listBatch} maxToRenderPerBatch={listBatch} windowSize={listWindow}
      contentContainerStyle={[styles.genreBody, { paddingBottom: bottomInset }]} showsVerticalScrollIndicator={false}
      onEndReached={onEndReached} onEndReachedThreshold={1.5}
      ListHeaderComponent={<>
        {detail && <Text style={styles.gridDetail} numberOfLines={1}>{detail}</Text>}
        <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={[styles.genreTitle, detail ? styles.gridTitleUnderDetail : null]}>{title}</Text>
        {header}
      </>}
      ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.more} /> : undefined} />
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
  discHeader: { color: colors.muted, fontSize: 13, fontWeight: '600', marginTop: 14, marginBottom: 4, marginHorizontal: 9 },
  albumFooter: { marginHorizontal: gutter, marginTop: 18, gap: 3 },
  albumFooterText: { color: colors.quiet, fontSize: 13 },
  section: { marginTop: 28 },
  genreBody: { paddingHorizontal: gutter },
  genreTitle: { color: colors.text, fontSize: 34, letterSpacing: -1.4, fontWeight: '800', marginTop: 10, marginBottom: 18 },
  gridDetail: { color: colors.muted, fontSize: 15, fontWeight: '600', marginTop: 10 },
  gridTitleUnderDetail: { marginTop: 2 },
  more: { marginVertical: 20 },
}));
