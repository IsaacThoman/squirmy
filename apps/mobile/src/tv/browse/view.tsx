import { albumPresentation } from '@squirmy/client-core';
import type { Artwork } from '@squirmy/contracts';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView } from 'expo-symbols';
import { useState, type PropsWithChildren, type ReactNode } from 'react';
import {
  ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View,
} from 'react-native';
import { useArtworkImage } from '../../data/artwork';
import { shade } from '../../data/color';
import { loadFailure } from '../../data/errors';
import { useViewer } from '../../downloads/DownloadsProvider';
import { fadedArtOpacity } from '../../faded';
import { mosaicCovers } from '../../library/mosaic';
import { TvButton, tvColors } from '../ui';
import type { BrowseProps, Card } from './model';

export const browseInset = 74;
const gridGap = 24;
const railStart = 12;

export const browseStyles = StyleSheet.create({
  header: { gap: 8, paddingTop: 14, paddingBottom: 20 },
  title: { color: tvColors.text, fontSize: 55, fontWeight: '700', letterSpacing: -1.6 },
  subtitle: { color: tvColors.muted, fontSize: 23, lineHeight: 31 },
  section: { color: tvColors.text, fontSize: 32, fontWeight: '700', letterSpacing: -0.7 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 14 },
  page: { flex: 1 },
  padding: { paddingHorizontal: browseInset, paddingBottom: 48 },
});

export function BrowseHeader({ title, subtitle, children }: PropsWithChildren<{ title: string; subtitle?: string }>) {
  return <View style={browseStyles.header}>
    <Text accessibilityRole="header" style={browseStyles.title}>{title}</Text>
    {subtitle ? <Text style={browseStyles.subtitle}>{subtitle}</Text> : null}
    {children}
  </View>;
}

export function BrowseScroll({ children }: PropsWithChildren) {
  return <ScrollView contentInsetAdjustmentBehavior="never" contentContainerStyle={browseStyles.padding}
    showsVerticalScrollIndicator={false} style={browseStyles.page}>{children}</ScrollView>;
}

export function BrowseMessage({ title, detail, action, alert }: { title: string; detail?: string; action?: ReactNode; alert?: boolean }) {
  return <View style={styles.message}>
    <Text accessibilityRole={alert ? 'alert' : 'header'} style={styles.messageTitle}>{title}</Text>
    {detail && <Text style={browseStyles.subtitle}>{detail}</Text>}
    {action}
  </View>;
}

type QueryState = { isPending: boolean; isFetching: boolean; error: unknown; refetch: () => Promise<unknown> };

export function BrowseQuery({ query, what }: { query: QueryState; what: string }) {
  if (query.isPending || query.isFetching) return <BrowseLoading label={`Loading ${what}`} />;
  const failure = loadFailure(query.error);
  return <BrowseMessage title={`Couldn’t load ${what}`} detail={failure.description} alert
    action={failure.retry && <TvButton label="Try again" onPress={() => { void query.refetch(); }} />} />;
}

export function BrowseLoading({ label = 'Loading' }: { label?: string }) {
  return <ActivityIndicator accessibilityLabel={label} color={tvColors.accent} size="large" style={styles.loading} />;
}

type PageControls = {
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed?: boolean;
  loadMore: () => void;
};

export function BrowseMore({ hasMore, loadingMore, moreFailed, loadMore }: PageControls) {
  if (!hasMore) return null;
  return <View style={styles.more}>
    {moreFailed && <Text accessibilityRole="alert" style={browseStyles.subtitle}>Couldn’t load more.</Text>}
    <TvButton label={loadingMore ? 'Loading more…' : moreFailed ? 'Try again' : 'Load more'}
      onPress={loadMore} tone="surface" disabled={loadingMore} />
  </View>;
}

const noArt = {
  '♥': { colors: ['#7965B5', '#372950'], symbol: 'heart.fill' },
  '↺': { colors: ['#3F736D', '#203840'], symbol: 'clock.arrow.circlepath' },
  '♫': { colors: ['#715286', '#352741'], symbol: 'music.note.list' },
} as const;

function ArtImage({ artwork, size }: { artwork: Artwork; size: number }) {
  const image = useArtworkImage(artwork, size);
  return image && <Image {...image} contentFit="cover" style={{ width: size, height: size }}
    cachePolicy="memory-disk" accessible={false} transition={180} />;
}

export function BrowseArt({ artworks, size, glyph = '♪', round, dim }: Pick<Card, 'artworks' | 'glyph' | 'round' | 'dim'> & { size: number }) {
  const unique = mosaicCovers(artworks ?? []);
  const fallback = noArt[glyph as keyof typeof noArt];
  const colors = fallback?.colors ?? ['#40394F', '#232031'] as const;
  const symbol = fallback?.symbol ?? (glyph === '♪' ? round ? 'music.mic' : 'music.note' : null);
  const hasMosaic = unique.length >= 4;
  const first = unique[0];
  return <View accessible={false} style={[styles.art, {
    width: size, height: size, borderRadius: round ? size / 2 : Math.min(size / 6, 16),
    backgroundColor: first ? shade(first.color) : tvColors.surface,
    opacity: dim ? fadedArtOpacity : 1,
  }]}>
    {hasMosaic ? unique.slice(0, 4).map(artwork => <ArtImage artwork={artwork} size={size / 2} key={artwork.id} />)
      : first ? <ArtImage artwork={first} size={size} />
        : <LinearGradient colors={colors} style={styles.missingArt}>
          <View style={[styles.coverOrbit, { width: size * 0.76, height: size * 0.76, borderRadius: size }]} />
          <View style={[styles.coverOrbit, { width: size * 0.55, height: size * 0.55, borderRadius: size }]} />
          {symbol ? <SymbolView name={symbol} size={Math.round(size * 0.30)} tintColor="#EAE3FF" />
            : <Text allowFontScaling={false} style={[styles.artGlyph, { fontSize: size * 0.32 }]}>{glyph}</Text>}
        </LinearGradient>}
  </View>;
}

function BrowseCard({ card, size, navigate }: { card: Card; size: number; navigate: BrowseProps['navigate'] }) {
  const viewer = useViewer();
  const [focused, setFocused] = useState(false);
  const dim = card.dim ?? (card.availability ? albumPresentation({ availability: card.availability }, viewer) === 'dimmed' : false);
  return <Pressable accessibilityRole="button"
    accessibilityLabel={[card.title, card.subtitle, dim && 'Not available'].filter(Boolean).join(', ')}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPress={() => navigate(card.route)}
    tvParallaxProperties={{ enabled: true, magnification: 1.045, shiftDistanceX: 2, shiftDistanceY: 2, tiltAngle: 0.025 }}
    style={[styles.card, { width: size }]}>
    <View style={[styles.artLift, focused && styles.artFocused, { borderRadius: card.round ? size / 2 : 16 }]}>
      <BrowseArt artworks={card.artworks} size={size} glyph={card.glyph} round={card.round} dim={dim} />
    </View>
    <View style={styles.cardCaption}>
      <Text numberOfLines={1} style={[styles.cardTitle, focused && styles.cardTitleFocused, dim && styles.cardDim]}>{card.title}</Text>
      <Text numberOfLines={1} style={styles.cardSubtitle}>{card.subtitle}</Text>
    </View>
  </Pressable>;
}

export function BrowseShelf({ title, cards, more, navigate }: {
  title: string; cards: readonly Card[]; more?: BrowseRouteAction; navigate: BrowseProps['navigate'];
}) {
  const { width } = useWindowDimensions();
  const size = Math.min(244, Math.max(144, Math.floor((width - 2 * browseInset - 4 * gridGap) / 5.4)));
  return <View style={styles.shelf}>
    <View style={styles.sectionHeader}>
      <Text accessibilityRole="header" style={browseStyles.section}>{title}</Text>
      {more && <TvButton label={more.label} tone="quiet" onPress={more.onPress} />}
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shelfContent}
      contentInsetAdjustmentBehavior="never" style={styles.shelfScroll}>
      {cards.map(card => <BrowseCard card={card} key={card.key} size={size} navigate={navigate} />)}
    </ScrollView>
  </View>;
}

type BrowseRouteAction = { label: string; onPress: () => void };

export function BrowseGrid({ cards, navigate, header, page }: {
  cards: readonly Card[]; navigate: BrowseProps['navigate']; header: ReactNode; page?: PageControls;
}) {
  const { width } = useWindowDimensions();
  const available = width - 2 * browseInset;
  const columns = Math.max(3, Math.min(6, Math.floor((available + gridGap) / 238)));
  const size = Math.max(100, Math.floor((available - (columns - 1) * gridGap) / columns));
  return <FlatList key={columns} data={cards} numColumns={columns} keyExtractor={card => card.key}
    columnWrapperStyle={styles.gridRow} contentContainerStyle={browseStyles.padding} ListHeaderComponent={<>{header}</>}
    ListFooterComponent={page ? <BrowseMore {...page} /> : undefined} initialNumToRender={3} maxToRenderPerBatch={3} windowSize={7}
    onEndReached={page?.hasMore && !page.loadingMore && !page.moreFailed ? page.loadMore : undefined} onEndReachedThreshold={0.4}
    showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="never" removeClippedSubviews={false}
    renderItem={({ item }) => <BrowseCard card={item} size={size} navigate={navigate} />} />;
}

const styles = StyleSheet.create({
  message: { alignItems: 'flex-start', gap: 14, marginVertical: 38, maxWidth: 760 },
  messageTitle: { color: tvColors.text, fontSize: 33, fontWeight: '600' },
  loading: { alignSelf: 'flex-start', marginVertical: 28 },
  more: { alignItems: 'flex-start', gap: 12, marginTop: 22, marginBottom: 10 },
  art: { position: 'relative', flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden' },
  missingArt: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' },
  coverOrbit: { position: 'absolute', borderWidth: 1, borderColor: '#FFFFFF2E' },
  artGlyph: { color: '#EAE3FF', fontWeight: '600' },
  card: { gap: 12, paddingBottom: 5 },
  artLift: { shadowColor: '#000000', shadowOpacity: 0.34, shadowRadius: 9, shadowOffset: { width: 0, height: 6 } },
  artFocused: { outlineWidth: 4, outlineOffset: 4, outlineColor: tvColors.accent,
    shadowColor: tvColors.accent, shadowOpacity: 0.26, shadowRadius: 18, shadowOffset: { width: 0, height: 4 } },
  cardCaption: { gap: 3 },
  cardTitle: { color: tvColors.text, fontSize: 21, fontWeight: '600', lineHeight: 27 },
  cardTitleFocused: { color: tvColors.accent },
  cardDim: { color: tvColors.muted },
  cardSubtitle: { color: tvColors.muted, fontSize: 17, lineHeight: 23 },
  shelf: { marginTop: 26 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 49 },
  shelfScroll: { marginLeft: -railStart, marginRight: -browseInset },
  shelfContent: { paddingTop: 14, paddingBottom: 16, paddingLeft: railStart, paddingRight: browseInset, gap: gridGap },
  gridRow: { gap: gridGap, paddingVertical: 11 },
});
