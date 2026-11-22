import type { AlbumSummary, ArtistSummary, Artwork, PlaylistSummary } from '@squirmy/contracts';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { usePreventZoomTransitionDismissal, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useRealtime } from '../data/realtime';
import { useKeptCollections } from '../downloads/DownloadsProvider';
import { Cover, Icon } from '../ui';
import { BrowseButton, CollectionTile } from './BrowseControls';
import type { Page } from './links';
import { mosaicCovers } from './mosaic';
import { createThemedStyles, useColors } from '../theme';

export const gutter = 22;
/** How far in from the left edge a swipe can start and still close a zoomed collection. */
const backSwipeEdge = 40;
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
  /** Not in the library, or not downloaded while offline: drawn gray, cover and title alike. */
  dim?: boolean;
};

type Link = (page: Page, id: string) => Href;

export const likedId = 'liked';
export const recentId = 'recent';

export function albumCollection(album: AlbumSummary, link: Link, subtitle = album.artistCredit): Collection {
  return {
    key: album.id, kind: 'album', title: album.title, subtitle, href: link('album', album.id), artwork: album.artwork,
    dim: album.availability === 'none',
  };
}

export function artistCollection(artist: ArtistSummary, link: Link): Collection {
  return { key: artist.id, kind: 'artist', title: artist.name, subtitle: 'Artist', href: link('artist', artist.id), artwork: artist.image, round: true, dim: !artist.inLibrary };
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
 * Grays what cannot be opened usefully offline: albums, artists and playlists with
 * nothing downloaded. Liked Songs and history stay lit; their pages show what was saved.
 */
export function useOfflineDim() {
  const { offline } = useRealtime();
  const kept = useKeptCollections();
  return useCallback((item: Collection): Collection => {
    if (!offline || item.dim) return item;
    const lit = item.kind === 'album' ? kept.albums.has(item.key)
      : item.kind === 'artist' ? kept.artists.has(item.key)
        : item.kind === 'playlist' ? kept.playlists.has(item.key) : true;
    return lit ? item : { ...item, dim: true };
  }, [kept, offline]);
}

/** Says the server cannot be reached, next to (or under) a page's title. */
export function OfflineBadge({ style }: { style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const styles = useStyles();
  const { offline } = useRealtime();
  if (!offline) return null;
  return <View style={[styles.offline, style]} accessibilityRole="text" accessibilityLabel="Offline. Only downloaded music plays.">
    <Icon name="wifi.slash" size={13} color={colors.muted} />
    <Text style={styles.offlineText}>Offline</Text>
  </View>;
}

export function CollectionRail({ items, size = 131 }: { items: readonly Collection[]; size?: number }) {
  const styles = useStyles();
  const offlineDim = useOfflineDim();
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.railContent}>
    {items.map(offlineDim).map(item => <CollectionTile key={item.key} title={item.title} subtitle={item.subtitle} size={size} dim={item.dim}
      cover={<CollectionCover item={item} size={size} />} href={item.href} />)}
  </ScrollView>;
}

export function SectionTitle({ title, onPress }: { title: string; onPress?: () => void }) {
  const styles = useStyles();
  return <View style={styles.sectionTitle}>
    <Text accessibilityRole="header" style={styles.sectionText}>{title}</Text>
    {onPress && <BrowseButton label={`See ${title.toLowerCase()}`} title="See all" icon="chevron.right" onPress={onPress} />}
  </View>;
}

export function EmptyState({ icon, title, description, action }: {
  icon: string; title: string; description: string; action?: { title: string; onPress: () => void };
}) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.empty}>
    <Icon name={icon} size={30} color={colors.accent} />
    <Text style={styles.emptyTitle}>{title}</Text>
    <Text style={styles.emptyDescription}>{description}</Text>
    {action && <View style={styles.emptyAction}><BrowseButton label={action.title} title={action.title} onPress={action.onPress} /></View>}
  </View>;
}

/** A query's first load, or its failure with a way to try again. Null once there is data to show. */
export function QueryState({ query, what }: { query: { isPending: boolean; isError: boolean; refetch: () => unknown }; what: string }) {
  const colors = useColors();
  const styles = useStyles();
  if (query.isPending) return <View style={styles.loading}><ActivityIndicator color={colors.muted} /></View>;
  if (query.isError) {
    return <EmptyState icon="wifi.exclamationmark" title={`Couldn’t load ${what}`}
      description="Check your connection to the server." action={{ title: 'Try again', onPress: () => void query.refetch() }} />;
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

/**
 * Only a swipe from the left edge closes a page that zoomed open; pulling down scrolls it instead.
 * The bounds go on after the first render because the zoom transition registers itself in an
 * effect, and the hook only applies bounds when one of them changes.
 */
export function useBackSwipeOnly() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  usePreventZoomTransitionDismissal({ unstable_dismissalBoundsRect: mounted ? { maxX: backSwipeEdge } : undefined });
}

/** Case- and accent-insensitive match of every word of `query` against `values`. */
export function matches(query: string, ...values: string[]) {
  const normalized = (value: string) => value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const fullText = normalized(values.join(' '));
  return normalized(query).split(/\s+/).every(token => fullText.includes(token));
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  sectionTitle: { marginHorizontal: gutter, marginBottom: 13, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  sectionText: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.65 },
  railContent: { paddingHorizontal: gutter, gap: 12 },
  specialCover: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  coverRing: { position: 'absolute', borderColor: '#FFF8FF50', borderWidth: StyleSheet.hairlineWidth },
  mosaic: { flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden', backgroundColor: colors.surface },
  empty: { alignItems: 'center', gap: 7, padding: 28, marginTop: 22 },
  emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  emptyDescription: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 21 },
  emptyAction: { marginTop: 4 },
  loading: { paddingVertical: 60, alignItems: 'center' },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 28, borderRadius: 14, backgroundColor: colors.surface },
  offlineText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
}));
