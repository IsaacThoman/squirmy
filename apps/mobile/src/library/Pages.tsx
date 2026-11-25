import type { AlbumDetail, AlbumSummary, ArtistDetail, HistoryItem, HomeSection, PlaybackContext, TrackSummary } from '@squirmy/contracts';
import { albumNote, albumPresentation, artistAvailabilityNote, canFetch, formatReleaseDate, relatedAlbums, releaseSubtitle, songCountLabel } from '@squirmy/client-core';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, Share, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Extrapolation, interpolate, interpolateColor, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useScrollOffset, useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { useAccount, useSignedInApi, useWantlistEnabled, type Api } from '../account/AccountProvider';
import { awaitsTrackList, trackListWaitMs } from '../data/albums';
import { fallbackTint } from '../data/color';
import { isNotFound } from '../data/errors';
import { useLibraryActions, useLiked, useLikeFailure, usePlaylistActions, usePlaylistFailure, useWanted, useWantFailure } from '../data/library';
import { appearsOnKey, isArtistSectionKey, releaseGroups } from '../data/artists';
import { useAlbum, useArtist, useArtistReleases, useGenreAlbums, useHistory, useHome, useLikedTracks, usePlaylist } from '../data/queries';
import type { BrowseProps } from '../Library';
import { useRealtime } from '../data/realtime';
import {
  useAvailability, useDownloadActions, useDownloadedAlbum, useDownloadedLikes, useDownloadedPlaylist,
} from '../downloads/DownloadsProvider';
import { albumCollectionId, likedId as likedDownloadId, playlistCollectionId } from '../downloads/model';
import { announce, useBriefFailures } from '../inlineFeedback';
import { usePlaybackActions } from '../playback';
import { createThemedStyles, useColors } from '../theme';
import { AlbumNavButton, AlbumPlaybackButtons, BrowseBackButton, type AlbumNavProps, type AlbumPlaybackProps } from './AlbumButtons';
import { AlbumMetadata, type AlbumMetadataProps } from './AlbumMetadata';
import { CollectionGridRow } from './BrowseControls';
import { useDownloadControl } from './DownloadControl';
import { playAllFailure, radioFailure, wantFailureLabel, wantFailure as wantFailureMessage } from './failures';
import { heartButton } from './heart';
import {
  albumCollection, albumTypeLabels, artistCollection, CollectionCover, CollectionRail, EmptyState, FailureLine, gridColumns, gutter, likedCollection, nearEnd,
  OfflineBadge, playlistCollection,
  QueryState, recentCollection, SectionTitle, tapFeedback, useCollectionDim, type Collection,
} from './shared';
import { albumPlaylistSheet, useCollectionActions } from './collectionActions';
import { albumActions } from './albumActions';
import { confirmQueued } from './queued';
import { uniqueTracks } from './loadAll';
import { useStartGuard } from './pending';
import { displayFontScale, secondaryFontScale } from '../fontScale';
import { scrollEdgeFade } from '../edgeFade';
import { ScrollEdge } from '../ScrollEdge';
import { SongList, useSongListItems, type SongListProps } from './SongList';
import { besideArtist } from './collectionMenu';
import { chunk, type SongListItems, type SongRowItem } from './rows';
import { usePlayAll } from './usePlayAll';
import { ZoomTarget } from './ZoomLink';

const albumNavSize = 44;
/** Rows drawn per batch, and screens' worth kept around the visible part, by long song lists. */
const listBatch = 14;
const listWindow = 7;
const gridRowKey = (row: readonly Collection[]) => row[0]!.key;

export type PageProps = BrowseProps & { id: string; onBack: () => void };

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
  /** A playlist's description, under the header. An album's and an artist's come after their music. */
  description?: string | null;
  onBack: () => void;
  onEndReached?: () => void;
  bottomInset: number;
  /** Shown under the header; with `list`, above its rows. */
  children?: ReactNode;
  /** A long list of songs, drawn as it scrolls into view rather than all at once. */
  list?: SongListItems & { footer?: ReactElement | false };
};

/**
 * The page a collection zooms open into: its cover over the collection's tint, the title,
 * the play buttons, and the content below. Scrolling past the cover blurs the status bar;
 * the content scrolls on under the floating buttons, with no bar behind them.
 */
function DetailPage({
  item, tint, title, artist, artistLinks, info, buttons, nav, status, description, onBack, onEndReached, bottomInset, children, list,
}: DetailProps) {
  const colors = useColors();
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const scrollOffset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler(event => {
    scrollOffset.value = event.contentOffset.y;
    if (onEndReached && nearEnd(event)) scheduleOnRN(onEndReached);
  });
  // Leave the gradient uninterrupted until the artwork approaches the status bar. Only the
  // opacity changes as the page scrolls, on the UI thread; the edge itself is static.
  const edgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollOffset.value, [albumNavSize, albumNavSize + 20], [0, 1], Extrapolation.CLAMP),
  }));
  // Fill whatever an overscroll shows above the header with its tint.
  const overscrollStyle = useAnimatedStyle(() => {
    const visible = -scrollOffset.value;
    return { transform: [{ translateY: visible > 0 ? visible + 1 : 0 }] };
  });
  const artSize = Math.min(238, Math.floor(width * 0.60));
  const artRadius = item.round ? artSize / 2 : 17;
  const headerColor = tint ? interpolateColor(colors.albumTint, [0, 1], [colors.background, tint], 'RGB', { gamma: 1 }) : colors.background;
  const renderRow = list?.renderItem;
  const renderItem = useCallback((info: { item: SongRowItem }) => <View style={styles.trackList}>{renderRow!(info)}</View>, [renderRow, styles]);
  const header = <>
    <View style={[styles.header, { paddingTop: top + albumNavSize + 12 }]}>
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
    {/* The native stack finds its content scroll view through the first child. */}
    {list ? (
      <Animated.FlatList data={list.data} renderItem={renderItem} keyExtractor={list.keyExtractor}
        ListHeaderComponent={header} ListFooterComponent={list.footer || undefined}
        initialNumToRender={listBatch} maxToRenderPerBatch={listBatch} windowSize={listWindow}
        contentInsetAdjustmentBehavior="never" onScroll={onScroll} scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: bottomInset }} showsVerticalScrollIndicator={false} />
    ) : (
      <Animated.ScrollView contentInsetAdjustmentBehavior="never" onScroll={onScroll} scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
        {header}
      </Animated.ScrollView>
    )}
    <Animated.View pointerEvents="none" style={[styles.overscrollFill, { backgroundColor: headerColor }, overscrollStyle]} />
    <Animated.View pointerEvents="none" style={[styles.status, { height: top + scrollEdgeFade }, edgeStyle]}>
      <ScrollEdge solid={top} fade={scrollEdgeFade} />
    </Animated.View>
    {/* No title here: the header's own, an accessibility header, names the page for VoiceOver. */}
    <View pointerEvents="box-none" style={[styles.nav, { top: top + 6 }]}>
      <View pointerEvents="box-none" style={styles.navStart}><BrowseBackButton onPress={onBack} /><OfflineBadge /></View>
      <View style={styles.navActions}>
        {nav.filter((button): button is AlbumNavProps => Boolean(button)).map(button => <AlbumNavButton key={button.label} {...button} />)}
      </View>
    </View>
  </View>;
}

/**
 * A bio or description cut at `lines`; when it is cut, a tap shows all of it and another cuts it again.
 * `link` sits beside More, such as where a biography comes from.
 */
function ExpandableText({ text, lines, flush, link }: { text: string; lines: number; flush?: boolean; link?: ReactNode }) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  // No `disabled` for an uncut text: VoiceOver would read it as dimmed. `flush`: under a section title, which spaces it already.
  return <Pressable onPress={cut ? () => { tapFeedback(); setExpanded(!expanded); } : undefined} style={[styles.descriptionBlock, flush && styles.flush]}
    accessibilityRole={cut ? 'button' : 'text'} accessibilityHint={cut ? (expanded ? 'Shows less' : 'Shows the whole text') : undefined}>
    <Text style={styles.description} numberOfLines={expanded ? undefined : lines}>{text}</Text>
    {(cut || link) && <View style={styles.moreRow}>
      {cut && <Text style={styles.moreLabel}>{expanded ? 'Less' : 'More'}</Text>}
      {link}
    </View>}
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
    <View style={[styles.fallbackNav, styles.navStart]}><BrowseBackButton onPress={onBack} /><OfflineBadge /></View>
    {query.isError || query.isPending
      ? <QueryState query={query} what={what} />
      : <EmptyState icon="music.note" title="Not available" description="Go back to browse your library." />}
  </View>;
}

/** A list of songs under the same heading as the page's other sections, closer to its first row. */
function TrackSection({ title, detail, onSeeAll, children }: { title: string; detail?: string; onSeeAll?: () => void; children?: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.section}>
    <SectionTitle title={title} detail={detail} onPress={onSeeAll} style={styles.trackListTitle} />
    {children && <View style={styles.trackList}>{children}</View>}
  </View>;
}

/** `1,234 songs · 3 hr`; `60+ songs` for a list still to load more pages, whose total would undercount. */
function songCount(tracks: readonly TrackSummary[], durationMs = tracks.reduce((sum, track) => sum + track.durationMs, 0), complete = true) {
  return songCountLabel(tracks.length, { durationMs, complete });
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

/** True once the page has waited `trackListWaitMs` for the songs of the album `id`. As on web. */
function useOverdue(awaiting: boolean, id: string): boolean {
  const [overdue, setOverdue] = useState<string | null>(null);
  useEffect(() => {
    if (!awaiting) return;
    const timer = setTimeout(() => setOverdue(id), trackListWaitMs);
    return () => clearTimeout(timer);
  }, [awaiting, id]);
  return awaiting && overdue === id;
}

export function AlbumScreen({ id, onBack, onOpen, onTrackMenu, link, bottomInset = 155 }: PageProps) {
  const styles = useStyles();
  const colors = useColors();
  const { query: album, checkAgain } = useAlbum(id);
  const kept = useDownloadedAlbum(id);
  const data = album.data ?? kept;
  const wanted = useWanted(id, data?.wanted);
  const actions = usePlaybackActions();
  const { canPlay, offline, viewer } = useAvailability();
  const download = useDownloadActions();
  const liked = useLiked('album', id, data?.liked);
  const likeFailure = useLikeFailure('album', id);
  const wantFailure = useWantFailure(id);
  const { setLiked, setWanted } = useLibraryActions();
  const wantlist = useWantlistEnabled();
  const control = useDownloadControl(albumCollectionId(id), data?.title ?? '',
    album.data?.discs.flatMap(disc => disc.tracks), () => download.album(album.data!));
  // Play pressed before the server had the track list: it starts as soon as the tracks are known.
  const [waitingPlay, setWaitingPlay] = useState<{ shuffle: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  // The server is still looking up the songs; before its first answer the page has only the tile's summary.
  const lookingUp = !album.isPlaceholderData && awaitsTrackList(album.data);
  const awaiting = album.isPlaceholderData || lookingUp;
  // After a minute of looking the page says the songs are late, and offers to check again.
  const overdue = useOverdue(lookingUp, id);
  const discs = data?.discs;
  // The lead artist's discography, for other versions and "More by" under the songs, as on web; asked once the album is here.
  const leadId = album.data?.artists[0]?.id;
  const lead = useArtist(leadId ?? '', { enabled: Boolean(leadId), poll: false });
  const leadData = lead.isPlaceholderData ? undefined : lead.data;
  const related = useMemo(() => data ? relatedAlbums(data, leadData) : { versions: [], more: [] }, [data, leadData]);
  useEffect(() => {
    if (!waitingPlay || !data) return;
    const list = data.discs.flatMap(disc => disc.tracks);
    if (list.length) actions.playTracks(list, { shuffle: waitingPlay.shuffle, context: { type: 'album', id: data.id, title: data.title } });
    if (list.length || !awaiting) setWaitingPlay(null);
  }, [actions, data, discs, awaiting, waitingPlay]);
  if (!data) return <PageFallback query={album} what="this album" onBack={onBack} />;
  const tracks = data.discs.flatMap(disc => disc.tracks);
  const context: PlaybackContext = { type: 'album', id: data.id, title: data.title };
  const play = (shuffle?: boolean, start?: number) => {
    tapFeedback();
    actions.playTracks(tracks, { start, shuffle, context });
  };
  const checkNow = async () => {
    tapFeedback();
    setChecking(true);
    try {
      await checkAgain();
    } finally {
      setChecking(false);
    }
  };
  const presentation = albumPresentation(data, viewer);
  const playable = tracks.some(canPlay);
  // Not "0 songs · 1 min" with buttons that change under the finger: while the server looks
  // up the songs of an album this viewer can play, Play and Shuffle wait for them.
  const waits = awaiting && !overdue && presentation === 'normal' && !offline;
  // The wantlist is for music this viewer can't play; for someone who may fetch music nothing is.
  const unavailable = !awaiting && !playable;
  // Added and removed alike, worded as on web. A refused change was set back; for a few seconds
  // the button says so, and a tap sends it again.
  const wantButton = offline || !wantlist || !unavailable ? [] : [{
    ...wantFailure === undefined
      ? { label: wanted ? 'Remove from wantlist' : 'Add to wantlist', symbol: wanted ? 'star.fill' : 'star' }
      : { label: wantFailureLabel(wantFailure), symbol: 'exclamationmark.circle', failed: true, spoken: wantFailureMessage(wantFailure, data.title) },
    onPress: () => {
      tapFeedback();
      setWanted('album', data.id, !wanted, data.title);
    } }];
  // Play and Shuffle keep their place: they play the songs, wait for them, or are disabled while there is nothing to play.
  const buttons: AlbumPlaybackProps['actions'] = playable ? playButtons(tracks, canPlay, play)
    : wantButton.length ? wantButton
      : (['play', 'shuffle'] as const).map(kind => ({
        label: kind === 'play' ? 'Play' : 'Shuffle', symbol: kind === 'play' ? 'play.fill' : 'shuffle', disabled: !waits,
        busy: waits && waitingPlay?.shuffle === (kind === 'shuffle'),
        onPress: () => { tapFeedback(); setWaitingPlay({ shuffle: kind === 'shuffle' }); },
      }));

  const artistLinks = data.artists.map(artist => ({ name: artist.name, open: () => { tapFeedback(); onOpen(link('artist', artist.id)); } }));
  // The ⋯ menu, as on web: what the buttons do, then the queue, a playlist, the library, the
  // artists, and Share. The placeholder does not know the songs or whether it is saved.
  const menu = albumActions({
    plays: playable, offline, songsKnown: !album.isPlaceholderData && tracks.length > 0, artists: data.artists, share: true,
    saved: album.isPlaceholderData ? undefined : { liked, failed: likeFailure !== undefined },
    want: wantButton.length ? { wanted, failed: wantFailure !== undefined } : undefined,
  }, {
    play: shuffle => play(shuffle),
    enqueue: placement => {
      actions.enqueue(tracks, placement);
      confirmQueued(placement);
    },
    addToPlaylist: () => onOpen(albumPlaylistSheet(data.id)),
    setSaved: saved => setLiked('album', data.id, saved, data.title),
    setWanted: want => setWanted('album', data.id, want, data.title),
    goToArtist: index => onOpen(link('artist', data.artists[index]!.id)),
    share: () => share(`${data.title} · ${data.artistCredit}`),
  });

  return <DetailPage item={albumCollection(data, link)} tint={data.artwork?.color ?? fallbackTint} title={data.title}
    artist={data.artistCredit} artistLinks={artistLinks}
    info={[albumTypeLabels[data.type], data.genres[0], data.year, albumNote(data, viewer)].filter(Boolean).join('  ·  ')}
    buttons={buttons} status={control.status}
    nav={[
      // The heart saves the album to the library. The placeholder does not know whether it is saved.
      !album.isPlaceholderData && { ...heartButton(liked, data.title, likeFailure),
        onPress: () => { tapFeedback(); setLiked('album', data.id, !liked, data.title); } },
      control.nav,
      { icon: 'ellipsis', label: `More options for ${data.title}`, menu },
    ]}
    onBack={onBack} bottomInset={bottomInset}>
    {/* The songs first, as on web; then what the record's back says, and any description. */}
    <TrackSection title="Tracklist" detail={tracks.length ? songCount(tracks, data.durationMs) : undefined}>
      {tracks.length ? <AlbumDiscs discs={data.discs} album={data} onPlay={start => play(undefined, start)} onTrackMenu={track => onTrackMenu(track)} />
        : awaiting && !overdue ? <View style={styles.lookingUp} accessible accessibilityLabel="Looking up the songs">
          <ActivityIndicator color={colors.muted} />
          <Text style={styles.lookingUpText}>Looking up the songs…</Text>
        </View>
          : overdue ? <EmptyState icon="music.note" title="Still looking for the songs"
            description="This is taking longer than usual. They will show up here when they arrive."
            action={{ title: 'Check again', onPress: () => void checkNow(), busy: checking }} />
            : <EmptyState icon="music.note" title="No songs listed" description="The server doesn’t know this album’s songs yet."
              action={offline ? undefined : { title: 'Check again', onPress: () => void checkNow(), busy: checking }} />}
    </TrackSection>
    <AlbumFooter album={data} />
    {data.description ? <ExpandableText text={data.description} lines={6} /> : null}
    {related.versions.length > 0 && <View style={styles.section}>
      <SectionTitle title="Other versions" />
      <CollectionRail items={related.versions.map(other => albumCollection(other, link, releaseSubtitle(other)))} />
    </View>}
    {related.more.length > 0 && leadData && <View style={styles.section}>
      <SectionTitle title={`More by ${leadData.name}`} onPress={() => onOpen(link('artist', leadData.id))} />
      <CollectionRail items={related.more.map(other => albumCollection(other, link, releaseSubtitle(other)))} />
    </View>}
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

/** Under the tracklist, as on a record's back: when it came out, and who put it out. Shown with no songs listed too, as on web. */
function AlbumFooter({ album }: { album: Pick<AlbumDetail, 'releaseDate' | 'year' | 'label'> }) {
  const styles = useStyles();
  const date = album.releaseDate ? formatReleaseDate(album.releaseDate) : null;
  const year = album.year ?? (album.releaseDate ? Number(album.releaseDate.slice(0, 4)) || null : null);
  const label = album.label ? ['℗', year, album.label].filter(Boolean).join(' ') : null;
  if (!date && !label) return null;
  return <View style={styles.albumFooter}>
    {date && <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.albumFooterText}>{date}</Text>}
    {label && <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.albumFooterText}>{label}</Text>}
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

function TrackListPage({ item, title, info, tracks, complete = true, playAll, context, empty, loadMore, loadingMore, download, props }: {
  item: Collection;
  title: string;
  info: string;
  tracks: readonly TrackSummary[];
  /** Every page of the list is loaded, so its count and length are the whole list's. */
  complete?: boolean;
  /** Loads the rest of a list shown in part before playing it; without it, `tracks` is played as it is. */
  playAll?: PlayAll;
  context: PlaybackContext;
  empty: { title: string; description: string };
  loadMore: () => void;
  loadingMore: boolean;
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
  const songs = useSongListItems({ tracks, artist: context.type === 'artist' ? context.id ?? undefined : undefined,
    onPlay: start => play(undefined, start), onTrackMenu: track => props.onTrackMenu(track) });
  // Play or Shuffle could load only part of the list: it says so under them, for a few seconds.
  return <DetailPage item={item} tint={null} title={title} info={info} buttons={playButtons(tracks, canPlay, play, playAll?.busy)}
    nav={download ? [download.nav] : []} status={<>{playAll?.failed && <FailureLine message={playAllFailure} />}{download?.status}</>}
    onBack={props.onBack} onEndReached={loadMore} bottomInset={props.bottomInset ?? 155}
    list={tracks.length ? { ...songs, footer: loadingMore && <ActivityIndicator style={{ marginVertical: 20 }} /> } : undefined}>
    {tracks.length ? <TrackSection title="Songs" detail={songCount(tracks, undefined, complete)} />
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
  // Kept songs stand in when the list can't load; with none, the page says why and offers to try again.
  if (!tracks || (liked.isError && !liked.data && !tracks.length)) return <PageFallback query={liked} what="your liked songs" onBack={props.onBack} />;
  // The songs kept on this device stand in whole; the server's list is whole once its last page is in.
  return <TrackListPage item={likedCollection(props.link)} title="Liked Songs" info="Playlist" tracks={tracks} download={control}
    complete={!liked.data || !liked.hasNextPage}
    playAll={liked.data ? playAll : undefined}
    context={{ type: 'liked', id: null, title: 'Liked Songs' }} loadMore={liked.loadMore} loadingMore={liked.isFetchingNextPage}
    empty={{ title: 'No liked songs yet', description: 'Tap the heart on any song to add it to Liked Songs.' }} props={props} />;
}

function HistoryScreen(props: PageProps) {
  const history = useHistory();
  const playAll = usePlayAll({ list: history, fetchPage: historyPage, tracksOf: historyTracks });
  const tracks = useMemo(() => historyTracks(history.items), [history.items]);
  if (!history.data) return <PageFallback query={history} what="your history" onBack={props.onBack} />;
  return <TrackListPage item={recentCollection(props.link)} title="Recently Played" info="Listening history"
    tracks={tracks} complete={!history.hasNextPage} playAll={playAll} context={{ type: 'history', id: null, title: 'Recently Played' }}
    loadMore={history.loadMore} loadingMore={history.isFetchingNextPage}
    empty={{ title: 'Nothing played yet', description: 'Play a song and it will appear in your history.' }} props={props} />;
}

function UserPlaylistScreen({ id, onBack, onOpen, onTrackMenu, link, bottomInset = 155 }: PageProps) {
  const { state } = useAccount();
  const playlist = usePlaylist(id);
  const kept = useDownloadedPlaylist(id);
  // Deleted on another device: the server's 404 wins over the copy loaded before it and over
  // a downloaded one, so the page says it is gone and offers nothing to edit.
  const data = isNotFound(playlist.error) ? undefined : playlist.data ?? kept;
  const actions = usePlaybackActions();
  const { canPlay } = useAvailability();
  const { offline } = useRealtime();
  const edits = usePlaylistActions();
  // A removal, move or deletion the server refused: put back, and said under the header.
  const failure = usePlaylistFailure(id);
  const download = useDownloadActions();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
  if (!data) return <PageFallback query={playlist} what="this playlist" onBack={onBack} />;
  const rename = () => onOpen({ pathname: '/name-playlist', params: { mode: 'rename', id: data.id, name: data.name } });
  const remove = () => Alert.alert(`Delete “${data.name}”?`, 'This can’t be undone.', [
    { text: 'Cancel', style: 'cancel' },
    // The page waits for the server, so a refusal is told here, on the playlist still there.
    { text: 'Delete Playlist', style: 'destructive', onPress: () => {
      setDeleting(true);
      edits.remove(data.id).then(onBack, () => setDeleting(false));
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
    buttons={playButtons(tracks, canPlay, play)} description={data.description}
    status={<>{failure && <FailureLine message={failure} />}{control.status}</>}
    nav={[
      control.nav,
      mine && Platform.OS === 'ios' && tracks.length > 1 && { icon: editing ? 'checkmark' : 'arrow.up.arrow.down',
        label: editing ? 'Finish reordering' : 'Reorder songs', selected: editing, onPress: () => { tapFeedback(); setEditing(!editing); } },
      mine && { icon: 'ellipsis', label: deleting ? `Deleting ${data.name}` : `Manage ${data.name}`, busy: deleting, onPress: deleting ? () => undefined : manage },
      { icon: 'square.and.arrow.up', label: `Share ${data.name}`, onPress: () => share(data.name) },
    ]}
    // Reordering drags rows within one native list, so while editing every row is drawn.
    onBack={onBack} bottomInset={bottomInset} list={tracks.length && !editing ? songs : undefined}>
    {tracks.length ? <TrackSection title="Songs" detail={songCount(tracks, data.durationMs)}>
      {editing && <SongList {...songListProps} />}
    </TrackSection> : <EmptyState icon="music.note.list" title="No songs yet"
      description="Add songs from any song’s menu with Add to playlist." />}
  </DetailPage>;
}

export function ArtistScreen({ id, onBack, onOpen, onTrackMenu, link, bottomInset = 155 }: PageProps) {
  const styles = useStyles();
  const api = useSignedInApi();
  const artist = useArtist(id);
  const actions = usePlaybackActions();
  const { canPlay, offline, viewer } = useAvailability();
  const liked = useLiked('artist', id, artist.data?.liked);
  const likeFailure = useLikeFailure('artist', id);
  const { setLiked } = useLibraryActions();
  const starts = useStartGuard();
  // A radio that didn't start says so on its button for a few seconds; a tap tries again.
  const radioFailures = useBriefFailures<true>();
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
    radioFailures.drop('radio');
    starts.run('radio', () => api.radio.artist(data.id).then(actions.playRadio, () => {
      radioFailures.fail('radio', true);
      announce(`Couldn’t start a radio for ${data.name}. Try again.`);
    }));
  };
  const startingRadio = starts.pending('radio');
  const radioFailed = radioFailures.failures.has('radio');
  const placeholder = artist.isPlaceholderData;

  // The disambiguation ("60s band from the UK") tells same-name artists apart, as on web.
  return <DetailPage item={artistCollection(data, link)} tint={data.image?.color ?? null} title={data.name}
    // Someone who may not fetch music is told how much of the discography plays, as on web.
    info={['Artist', data.disambiguation, ...data.genres.slice(0, 2), !placeholder && artistAvailabilityNote(data, viewer)].filter(Boolean).join('  ·  ')}
    buttons={playButtons(top, canPlay, play)} status={radioFailed && <FailureLine message={`${radioFailure}.`} />}
    nav={[
      // The heart saves (follows) the artist, which puts it in the library. The placeholder
      // does not know whether the artist is saved.
      !placeholder && { ...heartButton(liked, data.name, likeFailure), onPress: () => { tapFeedback(); setLiked('artist', data.id, !liked, data.name); } },
      // Only when the server says a radio starts for this user (for a requester, from what it
      // can fetch too); an older server does not say, and then the library decides.
      !placeholder && (data.radio ?? (data.inLibrary || canFetch(viewer))) && !offline && {
        icon: radioFailed ? 'exclamationmark.circle' : 'dot.radiowaves.left.and.right', busy: startingRadio, failed: radioFailed, onPress: radio,
        label: startingRadio ? `Starting a radio for ${data.name}` : radioFailed ? `${radioFailure}, ${data.name}` : `Start a radio for ${data.name}` },
      { icon: 'square.and.arrow.up', label: `Share ${data.name}`, onPress: () => share(data.name) },
    ]}
    onBack={onBack} bottomInset={bottomInset}>
    {placeholder ? <ActivityIndicator style={styles.more} accessibilityLabel="Loading" /> : <ArtistBody artist={data} link={link} onOpen={onOpen}
      onPlay={start => play(undefined, start)} onTrackMenu={onTrackMenu} />}
  </DetailPage>;
}

/**
 * What an artist page shows under its header, as on web: top songs, the discography, similar
 * artists, then About. Each rail stops at `railLimit` tiles, with "See all" for the rest: a
 * long discography (thousands of releases for a composer) mounted in full froze the app.
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
      <SongList tracks={top.slice(0, songLimit)} artist={artist.id} onPlay={onPlay} onTrackMenu={track => onTrackMenu(track)} />
    </TrackSection>}
    {groups.map(group => <View key={group.key} style={styles.section}>
      <SectionTitle title={group.title}
        onPress={(group.paged ? group.total : group.albums.length) > Math.min(group.albums.length, railLimit)
          ? () => onOpen(link('releases', releasesId(artist.id, group.key))) : undefined} />
      {/* Gray only what does not play for this viewer (`albumPresentation`, applied by the rail). */}
      <CollectionRail items={group.albums.slice(0, railLimit).map(album => releaseCollection(album, group.key, link, artist.id))} />
    </View>)}
    {artist.similar.length > 0 && <View style={styles.section}>
      <SectionTitle title="Similar Artists" />
      <CollectionRail items={artist.similar.map(similar => artistCollection(similar, link))} size={110} />
    </View>}
    {/* Three lines, with More for the rest, and Read more for where the biography comes from. */}
    {artist.bio && <View style={styles.section}>
      <SectionTitle title="About" />
      <ExpandableText text={artist.bio} lines={3} flush link={artist.bioUrl ? <Pressable accessibilityRole="link"
        accessibilityHint="Opens the whole biography in a browser" hitSlop={8} style={({ pressed }) => pressed && styles.pressed}
        onPress={() => { tapFeedback(); void WebBrowser.openBrowserAsync(artist.bioUrl!); }}>
        <Text style={styles.moreLabel}>Read more</Text>
      </Pressable> : undefined} />
    </View>}
  </>;
}

/**
 * A release tile on an artist's pages: its year and type, or for another artist's release its
 * year and who made it (web says both too). The year leads, as in `releaseSubtitle`, so a long
 * credit cut short does not take it.
 */
function releaseCollection(album: AlbumSummary, group: string, link: PageProps['link'], artistId: string) {
  return besideArtist(albumCollection(album, link, group === appearsOnKey ? [album.year, album.artistCredit].filter(Boolean).join(' · ') : releaseSubtitle(album)), artistId);
}

/** The id of a page of one discography heading, `<artist>~<heading>`. */
const releasesId = (artistId: string, group: string) => `${artistId}~${group}`;
/** The id of a page of songs, `<source>~<id>`: an artist's top songs, or a Home section. */
const songsId = (source: 'top' | 'home', id: string) => `${source}~${id}`;
const splitId = (id: string) => {
  const at = id.indexOf('~');
  return at < 0 ? [id, ''] as const : [id.slice(0, at), id.slice(at + 1)] as const;
};

/**
 * Every release under one heading of an artist's discography, from "See all": paged from the
 * server for one of its sections, or the whole list an older server already sent.
 */
export function ReleasesScreen({ id, onBack, link, bottomInset = 155 }: PageProps) {
  const [artistId, key] = splitId(id);
  const artist = useArtist(artistId);
  const group = useMemo(() => artist.data && releaseGroups(artist.data).find(item => item.key === key), [artist.data, key]);
  const paged = isArtistSectionKey(key) && Boolean(artist.data?.sections);
  const releases = useArtistReleases(artistId, isArtistSectionKey(key) ? key : 'album', paged);
  const albums = paged ? releases.items : group?.albums ?? [];
  const items = useMemo(() => albums.map(album => releaseCollection(album, key, link, artistId)), [albums, artistId, key, link]);
  const loading = !artist.data || artist.isPlaceholderData;
  return <CollectionGridPage title={group?.title ?? 'Releases'} detail={artist.data?.name} items={items} onBack={onBack}
    bottomInset={bottomInset}
    onEndReached={paged ? releases.loadMore : undefined} loadingMore={paged && releases.isFetchingNextPage}
    header={loading ? <QueryState query={{ ...artist, isPending: artist.isPending || artist.isPlaceholderData }} what="these releases" />
      : paged && !releases.data ? <QueryState query={releases} what="these releases" />
        : !albums.length && <EmptyState icon="square.stack" title="Nothing here" description="This artist has no releases under this heading." />} />;
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
    context={{ type: 'artist', id: data.id, title: data.name }} loadMore={noop} loadingMore={false}
    empty={{ title: 'No top songs', description: 'The server has no top songs for this artist yet.' }} props={props} />;
}

function HomeSongsScreen({ sectionId, props }: { sectionId: string; props: PageProps }) {
  const home = useHome();
  const section = home.data?.sections.find((item): item is Extract<HomeSection, { kind: 'tracks' }> => item.kind === 'tracks' && item.id === sectionId);
  if (!section) return <PageFallback query={home} what="these songs" onBack={props.onBack} />;
  const item: Collection = { key: section.id, kind: 'playlist', special: 'playlist', title: section.title, subtitle: 'Home', href: props.link('songs', props.id) };
  return <TrackListPage item={item} title={section.title} info="From Home" tracks={section.tracks}
    context={{ type: 'other', id: section.id, title: section.title }} loadMore={noop} loadingMore={false}
    empty={{ title: 'Nothing here yet', description: 'Play some music and it shows up here.' }} props={props} />;
}

const noop = () => undefined;

/** The albums of one genre, from the genre tiles on Search. */
export function GenreScreen({ id, onBack, link, bottomInset = 155 }: PageProps) {
  const albums = useGenreAlbums(id);
  const items = useMemo(() => albums.items.map(album => albumCollection(album, link)), [albums.items, link]);
  return <CollectionGridPage title={id} items={items} onBack={onBack} bottomInset={bottomInset}
    onEndReached={albums.loadMore} loadingMore={albums.isFetchingNextPage}
    header={!albums.data ? <QueryState query={albums} what={id} />
      : !albums.items.length && <EmptyState icon="square.stack" title="No albums yet" description={`Albums tagged ${id} show up here.`} />} />;
}

/** A titled grid of tiles, drawn as it scrolls into view: a genre's albums, or all of one discography heading. */
function CollectionGridPage({ title, detail, items, header, onBack, onEndReached, loadingMore = false, bottomInset }: {
  title: string;
  /** A line over the title, such as the artist whose releases these are. */
  detail?: string;
  items: readonly Collection[];
  /** Under the title: the loading state, or what to say when there is nothing. */
  header?: ReactNode;
  onBack: () => void;
  onEndReached?: () => void;
  loadingMore?: boolean;
  bottomInset: number;
}) {
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const contentGap = 8 + albumNavSize;
  const list = useAnimatedRef<Animated.FlatList<Collection[]>>();
  const scrollOffset = useScrollOffset(list);
  const { width, fontScale } = useWindowDimensions();
  const collectionDim = useCollectionDim();
  const actionsFor = useCollectionActions();
  const columns = gridColumns(width, fontScale);
  const size = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);
  const rows = useMemo(() => chunk(items.map(collectionDim), columns), [items, columns, collectionDim]);
  const renderRow = useCallback(({ item: row }: { item: Collection[] }) => <CollectionGridRow items={row.map(item => ({
    id: item.key, title: item.title, subtitle: item.subtitle, size, cover: <CollectionCover item={item} size={size} />, href: item.href, dim: item.dim,
    actions: actionsFor(item),
  }))} />, [actionsFor, size]);
  // The tiles scroll on under the status bar and the floating back button, as on the other pages.
  return <View style={styles.page}>
    <Animated.FlatList ref={list} data={rows} renderItem={renderRow} keyExtractor={gridRowKey}
      initialNumToRender={listBatch} maxToRenderPerBatch={listBatch} windowSize={listWindow}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={[styles.genreBody, { paddingTop: top + contentGap, paddingBottom: bottomInset }]}
      showsVerticalScrollIndicator={false}
      onEndReached={onEndReached} onEndReachedThreshold={1.5}
      ListHeaderComponent={<>
        {detail && <Text style={styles.gridDetail} numberOfLines={1}>{detail}</Text>}
        <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={[styles.genreTitle, detail ? styles.gridTitleUnderDetail : null]}>{title}</Text>
        {header}
      </>}
      ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.more} /> : undefined} />
    <ScrollEdge solid={top} fade={scrollEdgeFade} scrollOffset={scrollOffset} contentGap={contentGap} />
    <View pointerEvents="box-none" style={[styles.nav, { top: top + 8 }]}>
      <View pointerEvents="box-none" style={styles.navStart}><BrowseBackButton onPress={onBack} /><OfflineBadge /></View>
    </View>
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  page: { flex: 1, overflow: 'hidden', backgroundColor: colors.background },
  nav: {
    position: 'absolute', left: 0, right: 0, zIndex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, paddingHorizontal: gutter,
  },
  navActions: { flexDirection: 'row', gap: 10 },
  // The back button, and beside it the Offline badge when the server cannot be reached, as on the tabs' pages.
  navStart: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  fallbackNav: { paddingHorizontal: gutter, alignItems: 'flex-start' },
  overscrollFill: { position: 'absolute', bottom: '100%', height: '100%', left: 0, right: 0 },
  status: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 },
  header: { alignItems: 'center', paddingHorizontal: gutter },
  art: { marginTop: 8, marginBottom: 21, backgroundColor: colors.surface, shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.42, shadowRadius: 22 },
  descriptionBlock: { marginHorizontal: gutter, marginTop: 18 },
  flush: { marginTop: 0 },
  description: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  moreRow: { flexDirection: 'row', alignItems: 'center', gap: 20, marginTop: 4 },
  moreLabel: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  measure: { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0 },
  // The rows' own height spaces the first song from the heading.
  trackListTitle: { marginBottom: 2 },
  lookingUp: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 28, marginHorizontal: gutter },
  lookingUpText: { color: colors.muted, fontSize: 15 },
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
