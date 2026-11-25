import { albumPresentation, type Viewer } from '@squirmy/client-core';
import type { AlbumSummary, ArtistSummary, Artwork, PlaylistSummary } from '@squirmy/contracts';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import type { Href } from 'expo-router';
import { useCallback, useMemo } from 'react';
import {
  ActivityIndicator, FlatList, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { loadFailure } from '../data/errors';
import { useRealtime } from '../data/realtime';
import { useKeptCollections, useViewer } from '../downloads/DownloadsProvider';
import { Cover, Icon } from '../ui';
import { BrowseButton, CollectionTile } from './BrowseControls';
import { useCollectionActions } from './collectionActions';
import type { Page } from './links';
import { mosaicCovers } from './mosaic';
import { displayFontScale, secondaryFontScale } from '../fontScale';
import { createThemedStyles, useColors } from '../theme';

export const gutter = 22;

/** What an album's type is called in a subtitle ("Single · Tate McRae"). */
export const albumTypeLabels: Record<AlbumSummary['type'], string> = {
  album: 'Album', ep: 'EP', single: 'Single', compilation: 'Compilation', live: 'Live', soundtrack: 'Soundtrack', other: 'Release',
};
/** From this text scale (the accessibility sizes) grids and tiles make room for the text. */
export const largeTextScale = 1.6;
/** From this one (the third accessibility size) a phone's grid has one column: in two, a one-word credit no longer fits. */
const largestTextScale = 2.5;

/**
 * Columns of a grid of tiles. At accessibility text sizes a phone shows two, wider, so a
 * title keeps more than its first few letters, and at the largest sizes one.
 */
export function gridColumns(width: number, fontScale: number): number {
  if (width >= 650) return fontScale >= largeTextScale ? 3 : 4;
  if (fontScale >= largestTextScale) return 1;
  return fontScale >= largeTextScale ? 2 : 3;
}

/**
 * How wide a rail's tiles are: `size`, or at accessibility text sizes most of the screen's
 * width, so a title wraps into words rather than letters and the next tile still peeks in.
 */
export function railTileSize(size: number, width: number, fontScale: number): number {
  return fontScale >= largeTextScale ? Math.max(size, Math.floor((width - gutter * 2) * 0.72)) : size;
}
/** Start loading the next page this far before the end of the list. */
const endThreshold = 900;

export function tapFeedback() {
  void Haptics.selectionAsync();
}

/** Anything the browse screens show as a tile or row: an album, artist, playlist, or one of the built-in lists. */
export type Collection = {
  key: string;
  kind: 'album' | 'artist' | 'playlist' | 'liked' | 'recent';
  title: string;
  subtitle: string;
  href: Href;
  artwork?: Artwork | null;
  /** A playlist's covers, shown as a mosaic. */
  artworks?: readonly Artwork[];
  special?: 'liked' | 'recent' | 'playlist';
  round?: boolean;
  /** Nothing on it plays for this viewer, or not downloaded while offline: drawn gray, cover and title alike. */
  dim?: boolean;
  /** An album's availability, which `useCollectionDim` reads with the viewer's rights. */
  availability?: AlbumSummary['availability'];
  /** An album's credited artists, for its menu's "Go to artist". */
  artists?: readonly { name: string; href: Href }[];
  /** Pinned to the top of the Library; known only for the Library's own list, whose first page starts with the pins. */
  pinned?: boolean;
};

type Link = (page: Page, id: string) => Href;

export const likedId = 'liked';
export const recentId = 'recent';

/** An album as a tile. Gray when nothing on it plays for anyone; `useCollectionDim` adds what the viewer can't fetch. */
export function albumCollection(album: AlbumSummary, link: Link, subtitle = album.artistCredit): Collection {
  return {
    key: album.id, kind: 'album', title: album.title, subtitle, href: link('album', album.id), artwork: album.artwork,
    dim: album.availability === 'none', availability: album.availability,
    artists: album.artists.map(artist => ({ name: artist.name, href: link('artist', artist.id) })),
  };
}

/** An artist as a tile. Never gray online: an artist's page lists their music whether or not it is in the library. */
export function artistCollection(artist: ArtistSummary, link: Link): Collection {
  return { key: artist.id, kind: 'artist', title: artist.name, subtitle: 'Artist', href: link('artist', artist.id), artwork: artist.image, round: true };
}

export function playlistCollection(playlist: PlaylistSummary, link: Link): Collection {
  return {
    key: playlist.id, kind: 'playlist', title: playlist.name, subtitle: `Playlist · ${playlist.ownerName}`, href: link('playlist', playlist.id),
    artworks: playlist.artworks, special: 'playlist',
  };
}

export function likedCollection(link: Link): Collection {
  return { key: likedId, kind: 'liked', title: 'Liked Songs', subtitle: 'Playlist', href: link('playlist', likedId), special: 'liked' };
}

export function recentCollection(link: Link): Collection {
  return { key: recentId, kind: 'recent', title: 'Recently Played', subtitle: 'Listening history', href: link('playlist', recentId), special: 'recent' };
}

const gradients = {
  liked: { colors: ['#C6B4FA', '#7862B4', '#30274A'], icon: 'heart.fill' },
  recent: { colors: ['#49665F', '#324747', '#212F3B'], icon: 'clock.arrow.circlepath' },
  playlist: { colors: ['#6C5A8E', '#47395F', '#272033'], icon: 'music.note.list' },
} as const;

export function CollectionCover({ item, size, radius = 13 }: { item: Collection; size: number; radius?: number }) {
  const styles = useStyles();
  const covers = mosaicCovers(item.artworks ?? []);
  let cover;
  if (covers.length >= 4) {
    const half = size / 2;
    cover = <View style={[styles.mosaic, { width: size, height: size, borderRadius: radius }]}>
      {covers.slice(0, 4).map(artwork => <Cover key={artwork.id} artwork={artwork} size={half} radius={0} />)}
    </View>;
  } else if (covers[0]) {
    cover = <Cover artwork={covers[0]} size={size} radius={radius} />;
  } else if (item.special) {
    const gradient = gradients[item.special];
    cover = <LinearGradient colors={gradient.colors} start={{ x: 0.05, y: 0.05 }} end={{ x: 0.95, y: 0.95 }}
      style={[styles.specialCover, { width: size, height: size, borderRadius: radius }]}>
      <View style={[styles.coverRing, { width: size * 0.75, height: size * 0.75, borderRadius: size }]} />
      <View style={[styles.coverRing, { width: size * 0.57, height: size * 0.57, borderRadius: size }]} />
      <Icon name={gradient.icon} size={Math.max(18, size * 0.28)} color="#FFF8FF" />
    </LinearGradient>;
  } else {
    cover = <Cover artwork={item.artwork} size={size} radius={item.round ? size / 2 : radius} icon={item.round ? 'music.mic' : 'music.note'} />;
  }
  return cover;
}

/**
 * Whether a tile is gray: an album nothing on which plays for this viewer (client-core's
 * `albumPresentation`), and offline also albums, artists and playlists with nothing
 * downloaded. Liked Songs and history stay lit; their pages show what was saved.
 */
export function collectionDim(item: Collection, { viewer, offline, kept }: {
  viewer: Viewer | null | undefined; offline: boolean; kept: { albums: ReadonlySet<string>; artists: ReadonlySet<string>; playlists: ReadonlySet<string> };
}): boolean {
  if (item.dim) return true;
  if (item.kind === 'album' && item.availability && albumPresentation({ availability: item.availability }, viewer) === 'dimmed') return true;
  if (!offline) return false;
  return item.kind === 'album' ? !kept.albums.has(item.key)
    : item.kind === 'artist' ? !kept.artists.has(item.key)
      : item.kind === 'playlist' ? !kept.playlists.has(item.key) : false;
}

/** `collectionDim` for the signed-in viewer, as a function that returns the tile with `dim` set. */
export function useCollectionDim() {
  const { offline } = useRealtime();
  const kept = useKeptCollections();
  const viewer = useViewer();
  return useCallback((item: Collection): Collection => {
    const dim = collectionDim(item, { viewer, offline, kept });
    return dim === Boolean(item.dim) ? item : { ...item, dim };
  }, [kept, offline, viewer]);
}

/** Says the server cannot be reached, next to (or under) a page's title. */
export function OfflineBadge({ style }: { style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const styles = useStyles();
  const { offline } = useRealtime();
  if (!offline) return null;
  return <View style={[styles.offline, style]} accessibilityRole="text" accessibilityLabel="Offline. Only downloaded and cached music plays.">
    <Icon name="wifi.slash" size={13} color={colors.muted} />
    <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.offlineText}>Offline</Text>
  </View>;
}

const railKey = (item: Collection) => item.key;
function RailGap() {
  return <View style={{ width: 12 }} />;
}

/**
 * A horizontal rail of tiles. Each tile is a native view of its own, so the rail draws only
 * those near the screen: an artist with thousands of releases mounted them all and froze.
 * A long press on a tile shows its menu.
 */
export function CollectionRail({ items, size: baseSize = 131 }: { items: readonly Collection[]; size?: number }) {
  const styles = useStyles();
  const { width, fontScale } = useWindowDimensions();
  const size = railTileSize(baseSize, width, fontScale);
  const collectionDim = useCollectionDim();
  const actionsFor = useCollectionActions();
  const data = useMemo(() => items.map(collectionDim), [items, collectionDim]);
  const renderItem = useCallback(({ item }: { item: Collection }) => <CollectionTile title={item.title} subtitle={item.subtitle} size={size}
    dim={item.dim} cover={<CollectionCover item={item} size={size} />} href={item.href} actions={actionsFor(item)} />, [actionsFor, size]);
  return <FlatList horizontal data={data} renderItem={renderItem} keyExtractor={railKey} ItemSeparatorComponent={RailGap}
    initialNumToRender={4} maxToRenderPerBatch={4} windowSize={3} showsHorizontalScrollIndicator={false}
    contentContainerStyle={styles.railContent} />;
}

/**
 * The heading of a section of a page: a rail, a song list, About. `detail` follows the title
 * ("10 songs · 49 min"); `onPress` adds "See all". At large text sizes they wrap under it.
 */
export function SectionTitle({ title, detail, onPress, style }: { title: string; detail?: string; onPress?: () => void; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  // A native button has no text baseline to line up with, so a row with one is centred instead.
  return <View style={[styles.sectionTitle, !onPress && styles.sectionTitleText, style]}>
    <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={styles.sectionText}>{title}</Text>
    {detail && <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.sectionDetail}>{detail}</Text>}
    {onPress && <BrowseButton label={`See all ${title.toLowerCase()}`} title="See all" icon="chevron.right" onPress={onPress} />}
  </View>;
}

type EmptyAction = { title: string; onPress: () => void; busy?: boolean };

/**
 * `action.busy`: it has started and not finished; a spinner stands in for it, so one tap asks
 * once. `actions`: more than one way on, one under the other.
 */
export function EmptyState({ icon, title, description, action, actions = action ? [action] : [] }: {
  icon: string; title: string; description: string; action?: EmptyAction; actions?: readonly EmptyAction[];
}) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.empty}>
    <Icon name={icon} size={30} color={colors.accent} />
    <Text style={styles.emptyTitle}>{title}</Text>
    <Text style={styles.emptyDescription}>{description}</Text>
    {actions.length > 0 && <View style={styles.emptyAction}>{actions.map(item => item.busy
      ? <ActivityIndicator key={item.title} accessibilityLabel={`${item.title}…`} color={colors.muted} style={styles.emptyBusy} />
      : <BrowseButton key={item.title} label={item.title} title={item.title} onPress={item.onPress} />)}</View>}
  </View>;
}

/**
 * A refused change, told under the control or header where it was made (the app has no
 * toasts), as the download's status line is. Its caller announces it to VoiceOver.
 */
export function FailureLine({ message }: { message: string }) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.failure} accessibilityRole="text" accessibilityLabel={message}>
    <Icon name="exclamationmark.circle" size={13} color={colors.danger} />
    <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.failureText}>{message}</Text>
  </View>;
}

/** A query's first load, or its failure with a way to try again. Null once there is data to show. */
export function QueryState({ query, what }: {
  query: { isPending: boolean; isError: boolean; error?: unknown; refetch: () => unknown }; what: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  if (query.isPending) return <View style={styles.loading}><ActivityIndicator color={colors.muted} /></View>;
  if (query.isError) {
    const failure = loadFailure(query.error);
    return <EmptyState icon={failure.connection ? 'wifi.exclamationmark' : 'exclamationmark.circle'} title={`Couldn’t load ${what}`}
      description={failure.description} action={failure.retry ? { title: 'Try again', onPress: () => void query.refetch() } : undefined} />;
  }
  return null;
}

/** An `onScroll` that calls `onEnd` as the end of a list comes near, for loading its next page. */
export function onScrollNearEnd(onEnd: () => void) {
  return ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (nativeEvent.layoutMeasurement.height + nativeEvent.contentOffset.y > nativeEvent.contentSize.height - endThreshold) onEnd();
  };
}

/** For worklet scroll handlers: the same test as `onScrollNearEnd`. */
export function nearEnd(event: NativeScrollEvent) {
  'worklet';
  return event.layoutMeasurement.height + event.contentOffset.y > event.contentSize.height - endThreshold;
}

/** Case- and accent-insensitive match of every word of `query` against `values`. */
export function matches(query: string, ...values: string[]) {
  const normalized = (value: string) => value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const fullText = normalized(values.join(' '));
  return normalized(query).split(/\s+/).every(token => fullText.includes(token));
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  sectionTitle: {
    marginHorizontal: gutter, marginBottom: 13, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center',
    columnGap: 10, rowGap: 2,
  },
  sectionTitleText: { alignItems: 'baseline' },
  sectionText: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.65 },
  sectionDetail: { color: colors.quiet, fontSize: 12, fontWeight: '600' },
  railContent: { paddingHorizontal: gutter },
  specialCover: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  coverRing: { position: 'absolute', borderColor: '#FFF8FF50', borderWidth: StyleSheet.hairlineWidth },
  mosaic: { flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden', backgroundColor: colors.surface },
  empty: { alignItems: 'center', gap: 7, padding: 28, marginTop: 22 },
  emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  emptyDescription: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 21 },
  emptyAction: { marginTop: 4, alignItems: 'center' },
  emptyBusy: { width: 44, height: 44 },
  loading: { paddingVertical: 60, alignItems: 'center' },
  // At least 28 tall, taller when the text is large, so the word is never cut.
  offline: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, minHeight: 28, borderRadius: 14, backgroundColor: colors.surface },
  offlineText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  // Stretched and wrapping, as the download's status line is, so a long line stays on the page at large sizes.
  failure: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 14, alignSelf: 'stretch', marginHorizontal: gutter },
  failureText: { color: colors.danger, fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
}));
