import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation, type Href } from 'expo-router';
import Animated, { Extrapolation, interpolate, interpolateColor, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { albums, featuredAlbumIds, libraryAlbumIds, tracks, type Album, type Track } from './catalog';
import { usePlaybackState } from './playback';
import { Cover, Icon } from './ui';
import { AlbumNavButton, AlbumPlaybackButtons } from './library/AlbumButtons';
import { AlbumStatusBlur } from './library/AlbumStatusBlur';
import { SongList } from './library/SongList';
import { ZoomLink, ZoomSource, ZoomTarget } from './library/ZoomLink';
import {
  AlbumMetadata, BrowseButton, CollectionGrid, CollectionRow, CollectionTile, GenreGrid, HeroActions, LibraryFilters,
  LibrarySort, SearchField, type SearchHandle,
} from './library/BrowseControls';
import { createThemedStyles, useColors } from './theme';

const gutter = 22;
const albumNavSize = 44;

export type BrowseProps = {
  onOpenAlbum: (albumId: string) => void;
  /** Where a collection's page lives. Tiles link here so the page can zoom out of their cover. */
  albumHref: (albumId: string) => Href;
  onTrackMenu: (trackId: string) => void;
  onOpenDevices?: () => void;
  bottomInset?: number;
};

type AlbumProps = BrowseProps & { albumId: string; onBack: () => void };
type Collection = {
  id: string;
  title: string;
  subtitle: string;
  album?: Album;
  icon?: string;
  round?: boolean;
};

const favorites: Collection = { id: 'favorites', title: 'Liked Songs', subtitle: 'Playlist', icon: 'heart.fill' };
const recentlyPlayed: Collection = { id: 'recent', title: 'Recently Played', subtitle: 'Listening history', icon: 'clock.arrow.circlepath' };
const allAlbums = Object.values(albums);
const allTracks = Object.values(tracks);

function albumCollection(album: Album): Collection {
  return { id: album.id, title: album.title, subtitle: album.artist, album };
}

const artistCollections: Collection[] = Array.from(new Set(allAlbums.filter(album => album.kind === 'Album').map(album => album.artist)))
  .map(artist => ({ id: `artist:${artist}`, title: artist, subtitle: 'Artist', round: true, album: allAlbums.find(album => album.artist === artist) }));

function tapFeedback() {
  void Haptics.selectionAsync();
}

function CollectionCover({ item, size, radius = 13 }: { item: Collection; size: number; radius?: number }) {
  const styles = useStyles();
  if (item.album) return <Cover source={item.album.artwork} size={size} radius={item.round ? size / 2 : radius} />;

  return <LinearGradient
    colors={item.id === 'favorites' ? ['#C6B4FA', '#7862B4', '#30274A'] : ['#49665F', '#324747', '#212F3B']}
    start={{ x: 0.05, y: 0.05 }} end={{ x: 0.95, y: 0.95 }}
    style={[styles.specialCover, { width: size, height: size, borderRadius: radius }]}
  >
    <View style={[styles.coverRing, { width: size * 0.75, height: size * 0.75, borderRadius: size }]} />
    <View style={[styles.coverRing, { width: size * 0.57, height: size * 0.57, borderRadius: size }]} />
    <Icon name={item.icon ?? 'music.note'} size={Math.max(18, size * 0.28)} color="#FFF8FF" />
  </LinearGradient>;
}

function CollectionRail({ items, albumHref, size = 131 }: { items: Collection[]; albumHref: BrowseProps['albumHref']; size?: number }) {
  const styles = useStyles();
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.railContent}>
    {items.map(item => <CollectionTile key={item.id} title={item.title} subtitle={item.subtitle} size={size}
      cover={<CollectionCover item={item} size={size} />} href={albumHref(item.id)} />)}
  </ScrollView>;
}

/** The featured album. Its page zooms out of the whole card; the enclosing `ZoomLink` supplies `onPress`. */
function HeroCard({ album, size, onPress }: { album: Album; size: number; onPress?: () => void }) {
  const { actions } = usePlaybackState();
  const styles = useStyles();
  return <ZoomSource style={[styles.hero, { minHeight: Math.min(350, size * 0.85) }]}>
    <Cover source={album.artwork} size={size} radius={0} style={styles.heroCover} />
    <LinearGradient colors={['#100D1600', '#100D1660', '#100D16E8']} locations={[0, 0.40, 1]} style={StyleSheet.absoluteFill} />
    <HeroActions title={album.title} artist={album.artist} onOpen={() => onPress?.()}
      onPlay={() => { tapFeedback(); actions.playAlbum(album.id); }} />
  </ZoomSource>;
}

function SectionTitle({ title, onPress }: { title: string; onPress?: () => void }) {
  const styles = useStyles();
  return <View style={styles.sectionTitle}>
    <Text accessibilityRole="header" style={styles.sectionText}>{title}</Text>
    {onPress && <BrowseButton label={`See ${title.toLowerCase()}`} title="See all" icon="chevron.right" onPress={onPress} />}
  </View>;
}

export function HomeScreen({ onOpenAlbum, albumHref, onOpenDevices, bottomInset = 155 }: BrowseProps) {
  const colors = useColors();
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { state, album: currentAlbum } = usePlaybackState();
  const hero = albums['blue-hour'];
  const recentIds = Array.from(new Set([currentAlbum.id, ...[...state.history].reverse().map(entry => tracks[entry.trackId].albumId)]));
  const recent = recentIds.slice(0, 6).map(id => albumCollection(albums[id]));
  const discovery = Array.from(new Set([...featuredAlbumIds, ...libraryAlbumIds])).filter(id => id !== hero.id).map(id => albumCollection(albums[id]));
  const heroSize = width - gutter * 2;

  return <View style={styles.page}>
    <LinearGradient pointerEvents="none" colors={[colors.background, colors.background, `${colors.background}00`]}
      locations={[0, top / (top + 14), 1]} style={[styles.detailStatus, { height: top + 14 }]} />
    <ScrollView contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingTop: top + 12, paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
      <View style={styles.homeHeader}>
        <View style={styles.brand}>
          <View style={styles.brandMark}><Icon name="waveform" size={16} color={colors.onAccent} /></View>
          <Text style={styles.wordmark}>Squirmy</Text>
        </View>
        {onOpenDevices && <BrowseButton label="Playback devices" icon="airplay.audio" glass onPress={onOpenDevices} />}
      </View>
      <Text accessibilityRole="header" style={[styles.pageTitle, styles.homeTitle]}>Listen now</Text>
      <ZoomLink href={albumHref(hero.id)}><HeroCard album={hero} size={heroSize} /></ZoomLink>
      <View style={styles.homeSection}>
        <SectionTitle title="Recently played" onPress={() => onOpenAlbum('recent')} />
        <CollectionRail items={recent} albumHref={albumHref} />
      </View>
      <View style={styles.homeSection}>
        <SectionTitle title="Discover more" />
        <CollectionRail items={discovery} size={146} albumHref={albumHref} />
      </View>
    </ScrollView>
  </View>;
}

const filters = ['All', 'Playlists', 'Albums', 'Artists'] as const;
const sortOptions = ['Recently played', 'Title', 'Artist'] as const;
type LibraryFilter = (typeof filters)[number];
type LibrarySort = (typeof sortOptions)[number];

export function LibraryScreen({ albumHref, bottomInset = 155 }: BrowseProps) {
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { state } = usePlaybackState();
  const [filter, setFilter] = useState<LibraryFilter>('All');
  const [sort, setSort] = useState<LibrarySort>('Recently played');
  const [grid, setGrid] = useState(true);
  const [showFilter, setShowFilter] = useState(false);
  const [query, setQuery] = useState('');
  const columns = width >= 650 ? 4 : 3;
  const size = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);

  const items = useMemo(() => {
    const recency = Array.from(new Set([state.trackId, ...[...state.history].reverse().map(entry => entry.trackId)].map(id => tracks[id].albumId)));
    const albumsInView = libraryAlbumIds.map(id => albums[id]).filter(album => filter === 'All' || `${album.kind}s` === filter);
    const collections = filter === 'Artists' ? [...artistCollections] : albumsInView.map(albumCollection);
    collections.sort((a, b) => {
      if (sort === 'Title') return a.title.localeCompare(b.title);
      if (sort === 'Artist') return (a.album?.artist ?? a.title).localeCompare(b.album?.artist ?? b.title);
      const order = (item: Collection) => {
        const position = recency.findIndex(id => item.round ? albums[id].artist === item.title : id === item.id);
        return position < 0 ? recency.length : position;
      };
      return order(a) - order(b);
    });
    if (filter === 'All' || filter === 'Playlists') collections.unshift(favorites);
    return collections.filter(item => matches(query, item.title, item.subtitle, item.album?.kind ?? ''));
  }, [filter, query, sort, state.history, state.trackId]);

  return <View style={[styles.page, { paddingTop: top + 12 }]}>
    <View style={styles.pageHeader}>
      <Text accessibilityRole="header" style={[styles.pageTitle, styles.flex]}>Your library</Text>
      <BrowseButton glass icon={showFilter ? 'xmark' : 'magnifyingglass'} label={showFilter ? 'Close library search' : 'Search library'} onPress={() => {
        tapFeedback();
        if (showFilter) setQuery('');
        setShowFilter(!showFilter);
      }} />
    </View>
    {showFilter && <View style={styles.librarySearch}><SearchField value={query} onChange={setQuery} placeholder="Find in your library" autoFocus /></View>}
    <View style={styles.filters}>
      <LibraryFilters options={filters} value={filter} onChange={value => { tapFeedback(); setFilter(value); }} />
    </View>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={[styles.libraryBody, { paddingBottom: bottomInset }]} showsVerticalScrollIndicator={false}>
      <View style={styles.sortRow}>
        <LibrarySort options={sortOptions} value={sort} onChange={setSort} />
        <BrowseButton label={grid ? 'Show list view' : 'Show grid view'} icon={grid ? 'list.bullet' : 'square.grid.2x2'}
          onPress={() => { tapFeedback(); setGrid(!grid); }} />
      </View>
      {items.length === 0 && <EmptyState icon="magnifyingglass" title="No collections found" description="Try another search or filter." />}
      {grid ? <CollectionGrid columns={columns} items={items.map(item => ({
        id: item.id, title: item.title, subtitle: item.subtitle, size,
        cover: <CollectionCover item={item} size={size} />, href: albumHref(item.id),
      }))} /> : items.map(item => <CollectionRow key={item.id} title={item.title} subtitle={item.subtitle} size={50}
      cover={<CollectionCover item={item} size={50} radius={9} />} href={albumHref(item.id)} />)}
    </ScrollView>
  </View>;
}

function normalized(value: string) {
  return value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function matches(query: string, ...values: string[]) {
  const fullText = normalized(values.join(' '));
  return normalized(query).split(/\s+/).every(token => fullText.includes(token));
}

const genreCards = Array.from(new Map(allAlbums.map(album => [album.genre, album])).values()).slice(0, 6);

export function SearchScreen({ albumHref, onTrackMenu, bottomInset = 155 }: BrowseProps) {
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const searchInput = useRef<SearchHandle>(null);
  const navigation = useNavigation();
  const tabs = useNavigation<{ addListener: (event: 'tabPress', listener: () => void) => () => void }>('/(tabs)');

  useEffect(() => tabs.addListener('tabPress', () => {
    if (navigation.isFocused()) searchInput.current?.focus();
  }), [navigation, tabs]);

  const active = Boolean(query.trim());
  const albumResults = active ? allAlbums.filter(album => matches(query, album.title, album.artist, album.genre)) : [];
  const trackResults = active ? allTracks.filter(track => matches(query, track.title, track.artist, albums[track.albumId].genre)) : [];
  const artistResults = active ? artistCollections.filter(artist => matches(query, artist.title)) : [];
  const genreWidth = Math.floor((width - gutter * 2 - 12) / 2);
  const { actions } = usePlaybackState();

  return <View style={[styles.page, { paddingTop: top + 12 }]}>
    <View style={styles.pageHeader}><Text accessibilityRole="header" style={styles.pageTitle}>Search</Text></View>
    <View style={styles.searchHeader}><SearchField inputRef={searchInput} value={query} onChange={setQuery} placeholder="Songs, albums, artists" /></View>
    <ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
      {!active ? <>
        <SectionTitle title="Browse by genre" />
        <View style={styles.genres}>
          <GenreGrid items={genreCards.map(album => ({
            id: album.genre, title: album.genre, width: genreWidth, color: album.color,
            cover: <Cover source={album.artwork} size={85} radius={8} />,
            onPress: () => {
              searchInput.current?.setText(album.genre);
              searchInput.current?.blur();
              Keyboard.dismiss();
            },
          }))} />
        </View>
      </> : <>
        {artistResults.length > 0 && <View style={styles.resultSection}>
          <SectionTitle title="Artists" />
          <CollectionRail items={artistResults} size={92} albumHref={albumHref} />
        </View>}
        {albumResults.length > 0 && <View style={styles.resultSection}>
          <SectionTitle title="Collections" />
          <CollectionRail items={albumResults.map(albumCollection)} size={115} albumHref={albumHref} />
        </View>}
        {trackResults.length > 0 && <View style={styles.resultSection}>
          <SectionTitle title="Songs" />
          <View style={styles.trackList}><SongList trackIds={trackResults.map(track => track.id)} onPlay={actions.playTrack} onTrackMenu={onTrackMenu} /></View>
        </View>}
        {albumResults.length + trackResults.length + artistResults.length === 0 && <EmptyState icon="magnifyingglass" title="No results" description="Try a different song, album, or artist." />}
      </>}
    </ScrollView>
  </View>;
}

function EmptyState({ icon, title, description }: { icon: string; title: string; description: string }) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.empty}>
    <Icon name={icon} size={30} color={colors.accent} />
    <Text style={styles.emptyTitle}>{title}</Text>
    <Text style={styles.emptyDescription}>{description}</Text>
  </View>;
}

export function AlbumScreen({ albumId, onBack, onTrackMenu, bottomInset = 155 }: AlbumProps) {
  const colors = useColors();
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { state, actions } = usePlaybackState();
  const scrollOffset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler(event => {
    scrollOffset.value = event.contentOffset.y;
  });
  // Leave the album's gradient uninterrupted until the artwork approaches the status bar.
  const blurStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollOffset.value, [albumNavSize, albumNavSize + 20], [0, 1], Extrapolation.CLAMP),
  }));
  const overscrollStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: scrollOffset.value < 0 ? 1 - scrollOffset.value : 0 }],
  }));
  const album = Object.hasOwn(albums, albumId) ? albums[albumId] : undefined;
  const artist = artistCollections.find(item => item.id === albumId);
  const item = album ? albumCollection(album) : albumId === 'favorites' ? favorites : albumId === 'recent' ? recentlyPlayed : artist;
  const trackIds = album?.trackIds ?? (albumId === 'favorites' ? state.favorites : albumId === 'recent' ? [...new Set([...state.history].reverse().map(entry => entry.trackId))] : allTracks.filter(track => track.artist === artist?.title).map(track => track.id));
  const totalSeconds = trackIds.reduce((seconds, id) => seconds + tracks[id].duration, 0);
  const artSize = Math.min(238, Math.floor(width * 0.60));
  const hasSongs = trackIds.length > 0;
  const headerColor = album ? interpolateColor(colors.albumTint, [0, 1], [colors.background, album.color], 'RGB', { gamma: 1 }) : colors.background;

  if (!item) return <View style={[styles.albumPage, { paddingTop: top + 8 }]}>
    <View style={styles.detailUnavailableNav}><AlbumNavButton icon="chevron.left" label="Go back" onPress={onBack} /></View>
    <EmptyState icon="music.note" title="Collection unavailable" description="Go back to browse your library." />
  </View>;

  function play(shuffled = false, trackId?: string) {
    tapFeedback();
    if (album) actions.playAlbum(album.id, { shuffled, trackId });
    else actions.playCollection(trackIds, { shuffled, trackId });
  }

  return <View style={styles.albumPage}>
    <Animated.View pointerEvents="none" style={[styles.overscrollFill, { backgroundColor: headerColor }, overscrollStyle]} />
    <Animated.View pointerEvents="none" style={[styles.detailStatus, { height: top }, blurStyle]}>
      <AlbumStatusBlur />
    </Animated.View>
    <View pointerEvents="box-none" style={[styles.detailNav, { top: top + 6 }]}>
      <AlbumNavButton icon="chevron.left" label="Go back" onPress={onBack} />
      {(album || artist) && <AlbumNavButton icon="square.and.arrow.up" label={`Share ${item.title}`} onPress={() => {
        void Share.share({ message: album ? `${item.title} · ${album.artist}` : item.title }).catch(() => Alert.alert('Sharing unavailable'));
      }} />}
    </View>
    <Animated.ScrollView contentInsetAdjustmentBehavior="never" onScroll={onScroll} scrollEventThrottle={16}
      contentContainerStyle={{ paddingBottom: bottomInset }}
      showsVerticalScrollIndicator={false}>
      <View style={[styles.detailHeader, { paddingTop: top + albumNavSize + 12 }]}>
        {album && <LinearGradient pointerEvents="none" colors={[headerColor, colors.background]}
          locations={[0, 1]} style={StyleSheet.absoluteFill} />}
        <ZoomTarget style={styles.detailArt}><CollectionCover item={item} size={artSize} radius={17} /></ZoomTarget>
        <AlbumMetadata title={item.title} artist={album?.artist}
          info={album ? [album.kind, album.genre, String(album.year)].join('  ·  ') : item.subtitle} />
        {hasSongs && <AlbumPlaybackButtons title={item.title} onPlay={() => play()} onShuffle={() => play(true)} />}
      </View>
      {album?.description && <Text style={styles.detailDescription}>{album.description}</Text>}
      {hasSongs && <>
        <View style={styles.trackListHeader}>
          <Text accessibilityRole="header" style={styles.trackListTitle}>Tracklist</Text>
          <Text style={styles.trackCount}>{trackIds.length} {trackIds.length === 1 ? 'song' : 'songs'} · {Math.max(1, Math.round(totalSeconds / 60))} min</Text>
        </View>
        <View style={styles.trackList}>
          <SongList trackIds={trackIds} numbered={album?.kind === 'Album'} onPlay={(id) => play(false, id)} onTrackMenu={onTrackMenu} />
        </View>
      </>}
      {!hasSongs && <EmptyState icon={item.icon ?? 'music.note'} title={albumId === 'favorites' ? 'Your favorites go here' : 'Nothing played yet'} description={albumId === 'favorites' ? 'Tap a heart next to any song to save it here.' : 'Play a song and it will appear in your history.'} />}
    </Animated.ScrollView>
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  homeHeader: { paddingHorizontal: gutter, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 41 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandMark: { width: 27, height: 27, borderRadius: 9, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  wordmark: { color: colors.text, fontWeight: '800', letterSpacing: 3.8, fontSize: 12 },
  homeTitle: { marginHorizontal: gutter, marginTop: 13, marginBottom: 19 },
  pageTitle: { color: colors.text, fontSize: 37, letterSpacing: -1.65, fontWeight: '800' },
  pageHeader: { marginHorizontal: gutter, flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 12 },
  hero: { marginHorizontal: gutter, borderRadius: 26, overflow: 'hidden', justifyContent: 'flex-end', backgroundColor: '#322940' },
  heroCover: { position: 'absolute', top: 0, left: 0 },
  homeSection: { marginTop: 26 },
  sectionTitle: { marginHorizontal: gutter, marginBottom: 13, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  sectionText: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.65 },
  railContent: { paddingHorizontal: gutter, gap: 12 },
  specialCover: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  coverRing: { position: 'absolute', borderColor: '#FFF8FF50', borderWidth: StyleSheet.hairlineWidth },
  librarySearch: { paddingHorizontal: gutter, paddingTop: 11 },
  filters: { paddingHorizontal: gutter, marginTop: 13, marginBottom: 10 },
  libraryBody: { paddingHorizontal: gutter },
  sortRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 43, marginBottom: 4 },
  searchHeader: { marginHorizontal: gutter, marginTop: 13, marginBottom: 25 },
  genres: { paddingHorizontal: gutter },
  resultSection: { marginBottom: 23 },
  empty: { alignItems: 'center', gap: 7, padding: 28, marginTop: 22 },
  emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  emptyDescription: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 21 },
  detailNav: { position: 'absolute', left: 0, right: 0, zIndex: 2, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: gutter },
  detailUnavailableNav: { paddingHorizontal: gutter, alignItems: 'flex-start' },
  albumPage: { flex: 1, overflow: 'hidden', backgroundColor: colors.background },
  overscrollFill: { position: 'absolute', bottom: '100%', height: '100%', left: 0, right: 0 },
  detailStatus: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 },
  detailHeader: { alignItems: 'center', paddingHorizontal: gutter },
  detailArt: { marginTop: 8, marginBottom: 21, shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.42, shadowRadius: 22 },
  detailDescription: { marginHorizontal: gutter, color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 18 },
  trackListHeader: { marginTop: 24, marginHorizontal: gutter, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: 8 },
  trackListTitle: { color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.4 },
  trackCount: { color: colors.quiet, fontSize: 12, fontWeight: '600' },
  trackList: { marginHorizontal: gutter - 4 },
}));
