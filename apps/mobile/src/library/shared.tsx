import type { AlbumSummary, ArtistSummary, Artwork, PlaylistSummary } from '@squirmy/contracts';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { usePreventZoomTransitionDismissal, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Cover, Icon } from '../ui';
import { BrowseButton, CollectionTile } from './BrowseControls';
import type { Page } from './links';
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
  title: string;
  subtitle: string;
  href: Href;
  artwork?: Artwork | null;
  /** A playlist's covers, shown as a mosaic. */
  artworks?: readonly Artwork[];
  special?: 'liked' | 'recent' | 'playlist';
  round?: boolean;
  /** Not in the library: drawn gray. */
  dim?: boolean;
};

type Link = (page: Page, id: string) => Href;

export const likedId = 'liked';
export const recentId = 'recent';

export function albumCollection(album: AlbumSummary, link: Link, subtitle = album.artistCredit): Collection {
  return {
    key: album.id, title: album.title, subtitle, href: link('album', album.id), artwork: album.artwork,
    dim: album.availability === 'none',
  };
}

export function artistCollection(artist: ArtistSummary, link: Link): Collection {
  return { key: artist.id, title: artist.name, subtitle: 'Artist', href: link('artist', artist.id), artwork: artist.image, round: true, dim: !artist.inLibrary };
}

export function playlistCollection(playlist: PlaylistSummary, link: Link): Collection {
  return {
    key: playlist.id, title: playlist.name, subtitle: `Playlist · ${playlist.ownerName}`, href: link('playlist', playlist.id),
    artworks: playlist.artworks, special: 'playlist',
  };
}

export function likedCollection(link: Link): Collection {
  return { key: likedId, title: 'Liked Songs', subtitle: 'Playlist', href: link('playlist', likedId), special: 'liked' };
}

export function recentCollection(link: Link): Collection {
  return { key: recentId, title: 'Recently Played', subtitle: 'Listening history', href: link('playlist', recentId), special: 'recent' };
}

const gradients = {
  liked: { colors: ['#C6B4FA', '#7862B4', '#30274A'], icon: 'heart.fill' },
  recent: { colors: ['#49665F', '#324747', '#212F3B'], icon: 'clock.arrow.circlepath' },
  playlist: { colors: ['#6C5A8E', '#47395F', '#272033'], icon: 'music.note.list' },
} as const;

export function CollectionCover({ item, size, radius = 13 }: { item: Collection; size: number; radius?: number }) {
  const styles = useStyles();
  const covers = item.artworks ?? [];
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
  return item.dim ? <View style={styles.dim}>{cover}</View> : cover;
}

export function CollectionRail({ items, size = 131 }: { items: readonly Collection[]; size?: number }) {
  const styles = useStyles();
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.railContent}>
    {items.map(item => <CollectionTile key={item.key} title={item.title} subtitle={item.subtitle} size={size}
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

/** Asks for a name; iOS shows a text field in the alert, other platforms keep `initial`. */
export function promptForName(title: string, initial: string, onName: (name: string) => void) {
  if (Platform.OS !== 'ios') {
    if (initial.trim()) onName(initial.trim());
    return;
  }
  Alert.prompt(title, undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Save', isPreferred: true, onPress: (name?: string) => { if (name?.trim()) onName(name.trim()); } },
  ], 'plain-text', initial);
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
  dim: { opacity: 0.45 },
  empty: { alignItems: 'center', gap: 7, padding: 28, marginTop: 22 },
  emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  emptyDescription: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 21 },
  emptyAction: { marginTop: 4 },
  loading: { paddingVertical: 60, alignItems: 'center' },
}));
