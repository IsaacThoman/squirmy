import { useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { albums, featuredAlbumIds, libraryAlbumIds, tracks, type Album, type Track } from './catalog';
import { usePlaybackState } from './playback';
import { colors, Cover, Icon } from './ui';

const ink = colors.background;
const panel = colors.surface;
const ivory = colors.text;
const muted = colors.muted;
const faint = '#857F8E';
const lilac = colors.accent;
const gutter = 22;

export type BrowseProps = {
  onOpenAlbum: (albumId: string) => void;
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

function SearchField({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (value: string) => void; placeholder: string; autoFocus?: boolean }) {
  return (
    <View style={styles.searchField}>
      <Icon name="magnifyingglass" size={19} color={muted} />
      <TextInput
        accessibilityLabel={placeholder}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        placeholder={placeholder}
        placeholderTextColor={faint}
        returnKeyType="search"
        selectionColor={lilac}
        style={styles.searchInput}
        value={value}
        onChangeText={onChange}
      />
      {value.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} onPress={() => onChange('')}>
        <Icon name="xmark.circle.fill" size={18} color={muted} />
      </Pressable>}
    </View>
  );
}

function RoundButton({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]} onPress={onPress}>
    <Icon name={icon} size={19} color={ivory} />
  </Pressable>;
}

function CollectionCover({ item, size, radius = 13 }: { item: Collection; size: number; radius?: number }) {
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

function CollectionTile({ item, size, onPress }: { item: Collection; size: number; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}, ${item.subtitle}`} onPress={onPress} style={({ pressed }) => [{ width: size }, pressed && styles.pressed]}>
    <CollectionCover item={item} size={size} />
    <Text numberOfLines={1} style={styles.tileTitle}>{item.title}</Text>
    <Text numberOfLines={1} style={styles.tileSub}>{item.subtitle}</Text>
  </Pressable>;
}

function CollectionRow({ item, onPress }: { item: Collection; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}, ${item.subtitle}`} onPress={onPress} style={({ pressed }) => [styles.collectionRow, pressed && styles.pressed]}>
    <CollectionCover item={item} size={54} radius={9} />
    <View style={styles.flex}>
      <Text numberOfLines={1} style={styles.rowTitle}>{item.title}</Text>
      <Text numberOfLines={1} style={styles.rowSub}>{item.subtitle}</Text>
    </View>
    <Icon name="chevron.right" size={13} color={faint} />
  </Pressable>;
}

function CollectionRail({ items, onOpenAlbum, size = 131 }: { items: Collection[]; onOpenAlbum: BrowseProps['onOpenAlbum']; size?: number }) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.railContent}>
    {items.map(item => <CollectionTile key={item.id} item={item} size={size} onPress={() => onOpenAlbum(item.id)} />)}
  </ScrollView>;
}

function SectionTitle({ title, onPress }: { title: string; onPress?: () => void }) {
  return <View style={styles.sectionTitle}>
    <Text accessibilityRole="header" style={styles.sectionText}>{title}</Text>
    {onPress && <Pressable accessibilityRole="button" accessibilityLabel={`See ${title.toLowerCase()}`} hitSlop={9} onPress={onPress} style={styles.sectionLink}>
      <Text style={styles.sectionLinkText}>See all</Text>
      <Icon name="chevron.right" size={10} color={lilac} />
    </Pressable>}
  </View>;
}

export function HomeScreen({ onOpenAlbum, onOpenDevices, bottomInset = 155 }: BrowseProps) {
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { state, album: currentAlbum, actions } = usePlaybackState();
  const hero = albums['blue-hour'];
  const recentIds = Array.from(new Set([currentAlbum.id, ...[...state.history].reverse().map(entry => tracks[entry.trackId].albumId)]));
  const recent = recentIds.slice(0, 6).map(id => albumCollection(albums[id]));
  const discovery = Array.from(new Set([...featuredAlbumIds, ...libraryAlbumIds])).filter(id => id !== hero.id).map(id => albumCollection(albums[id]));
  const heroSize = width - gutter * 2;

  return <ScrollView style={styles.page} contentContainerStyle={{ paddingTop: top + 12, paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
    <View style={styles.homeHeader}>
      <View style={styles.brand}>
        <View style={styles.brandMark}><Icon name="waveform" size={16} color={ink} /></View>
        <Text style={styles.wordmark}>TONE</Text>
      </View>
      {onOpenDevices && <Pressable accessibilityRole="button" accessibilityLabel="Playback devices" onPress={onOpenDevices} style={({ pressed }) => [styles.avatar, pressed && styles.pressed]}>
        <Text style={styles.avatarText}>I</Text>
      </Pressable>}
    </View>
    <Text accessibilityRole="header" style={[styles.pageTitle, styles.homeTitle]}>Listen now</Text>
    <View style={[styles.hero, { minHeight: Math.min(350, heroSize * 0.85) }]}>
      <Cover source={hero.artwork} size={heroSize} radius={0} style={styles.heroCover} />
      <LinearGradient colors={['#100D1600', '#100D1660', '#100D16E8']} locations={[0, 0.40, 1]} style={StyleSheet.absoluteFill} />
      <Pressable accessible={false} onPress={() => onOpenAlbum(hero.id)} style={StyleSheet.absoluteFill} />
      <View pointerEvents="box-none" style={styles.heroBottom}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Open ${hero.title}`} onPress={() => onOpenAlbum(hero.id)} style={styles.flex}>
          <Text style={styles.heroCategory}>{hero.kind === 'Playlist' ? 'FEATURED MIX' : 'ALBUM SPOTLIGHT'}</Text>
          <Text numberOfLines={2} style={styles.heroTitle}>{hero.title}</Text>
          <Text numberOfLines={1} style={styles.heroCaption}>{hero.artist}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Play ${hero.title}`} onPress={() => { tapFeedback(); actions.playAlbum(hero.id); }} style={({ pressed }) => [styles.heroPlay, pressed && styles.pressed]}>
          <Icon name="play.fill" size={20} color={ink} />
        </Pressable>
      </View>
    </View>
    <View style={styles.homeSection}>
      <SectionTitle title="Recently played" onPress={() => onOpenAlbum('recent')} />
      <CollectionRail items={recent} onOpenAlbum={onOpenAlbum} />
    </View>
    <View style={styles.homeSection}>
      <SectionTitle title="Discover more" />
      <CollectionRail items={discovery} size={146} onOpenAlbum={onOpenAlbum} />
    </View>
  </ScrollView>;
}

const filters = ['All', 'Playlists', 'Albums', 'Artists'] as const;
const sortOptions = ['Recently played', 'Title', 'Artist'] as const;
type LibraryFilter = (typeof filters)[number];
type LibrarySort = (typeof sortOptions)[number];

export function LibraryScreen({ onOpenAlbum, bottomInset = 155 }: BrowseProps) {
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

  function openSort() {
    tapFeedback();
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({
        options: [...sortOptions.map(option => option === sort ? `✓  ${option}` : option), 'Cancel'],
        cancelButtonIndex: sortOptions.length,
        title: 'Sort your library',
        userInterfaceStyle: 'dark',
      }, index => { if (index < sortOptions.length) setSort(sortOptions[index]); });
      return;
    }
    Alert.alert('Sort your library', undefined, sortOptions.map(option => ({ text: option, onPress: () => setSort(option) })), { cancelable: true });
  }

  return <View style={[styles.page, { paddingTop: top + 12 }]}>
    <View style={styles.pageHeader}>
      <Text accessibilityRole="header" style={[styles.pageTitle, styles.flex]}>Your library</Text>
      <RoundButton icon={showFilter ? 'xmark' : 'magnifyingglass'} label={showFilter ? 'Close library search' : 'Search library'} onPress={() => {
        tapFeedback();
        if (showFilter) setQuery('');
        setShowFilter(!showFilter);
      }} />
    </View>
    {showFilter && <View style={styles.librarySearch}><SearchField value={query} onChange={setQuery} placeholder="Find in your library" autoFocus /></View>}
    <View style={styles.filters}>
      {filters.map(value => <Pressable accessibilityRole="button" accessibilityState={{ selected: value === filter }} key={value} onPress={() => { tapFeedback(); setFilter(value); }} style={({ pressed }) => [styles.filter, filter === value && styles.filterActive, pressed && styles.pressed]}>
        <Text style={[styles.filterText, filter === value && styles.filterTextActive]}>{value}</Text>
      </Pressable>)}
    </View>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={[styles.libraryBody, { paddingBottom: bottomInset }]} showsVerticalScrollIndicator={false}>
      <View style={styles.sortRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Sort library, ${sort}`} hitSlop={7} style={styles.sortLabel} onPress={openSort}>
          <Icon name="arrow.up.arrow.down" size={14} color={muted} />
          <Text style={styles.sortText}>{sort}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={grid ? 'Show list view' : 'Show grid view'} style={styles.viewMode} hitSlop={8} onPress={() => { tapFeedback(); setGrid(!grid); }}>
          <Icon name={grid ? 'list.bullet' : 'square.grid.2x2'} size={19} color={muted} />
        </Pressable>
      </View>
      {items.length === 0 && <EmptyState icon="magnifyingglass" title="No collections found" description="Try another search or filter." />}
      {grid ? <View style={styles.libraryGrid}>
        {items.map(item => <CollectionTile key={item.id} item={item} size={size} onPress={() => onOpenAlbum(item.id)} />)}
      </View> : items.map(item => <CollectionRow key={item.id} item={item} onPress={() => onOpenAlbum(item.id)} />)}
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

export function SearchScreen({ onOpenAlbum, onTrackMenu, bottomInset = 155 }: BrowseProps) {
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const active = Boolean(query.trim());
  const albumResults = active ? allAlbums.filter(album => matches(query, album.title, album.artist, album.genre)) : [];
  const trackResults = active ? allTracks.filter(track => matches(query, track.title, track.artist, albums[track.albumId].genre)) : [];
  const artistResults = active ? artistCollections.filter(artist => matches(query, artist.title)) : [];
  const genreWidth = Math.floor((width - gutter * 2 - 12) / 2);
  const { actions } = usePlaybackState();

  return <View style={[styles.page, { paddingTop: top + 12 }]}>
    <View style={styles.pageHeader}><Text accessibilityRole="header" style={styles.pageTitle}>Search</Text></View>
    <View style={styles.searchHeader}><SearchField value={query} onChange={setQuery} placeholder="Songs, albums, artists" /></View>
    <ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
      {!active ? <>
        <SectionTitle title="Browse by genre" />
        <View style={styles.genres}>
          {genreCards.map((album, index) => <Pressable key={album.genre} accessibilityRole="button" accessibilityLabel={`Browse ${album.genre}`} onPress={() => { Keyboard.dismiss(); setQuery(album.genre); }} style={({ pressed }) => [styles.genreCard, { width: genreWidth, backgroundColor: ['#3E365A', '#3C5053', '#604640', '#303956', '#53374A', '#4A4C38'][index] }, pressed && styles.pressed]}>
            <Text style={styles.genreTitle}>{album.genre}</Text>
            <View pointerEvents="none" style={styles.genreArt}><Cover source={album.artwork} size={85} radius={8} /></View>
          </Pressable>)}
        </View>
      </> : <>
        {artistResults.length > 0 && <View style={styles.resultSection}>
          <SectionTitle title="Artists" />
          <CollectionRail items={artistResults} size={92} onOpenAlbum={onOpenAlbum} />
        </View>}
        {albumResults.length > 0 && <View style={styles.resultSection}>
          <SectionTitle title="Collections" />
          <CollectionRail items={albumResults.map(albumCollection)} size={115} onOpenAlbum={onOpenAlbum} />
        </View>}
        {trackResults.length > 0 && <View style={styles.resultSection}>
          <SectionTitle title="Songs" />
          <View style={styles.trackList}>{trackResults.map(track => <SongRow key={track.id} track={track} onPlay={() => actions.playTrack(track.id)} onTrackMenu={onTrackMenu} />)}</View>
        </View>}
        {albumResults.length + trackResults.length + artistResults.length === 0 && <EmptyState icon="magnifyingglass" title="No results" description="Try a different song, album, or artist." />}
      </>}
    </ScrollView>
  </View>;
}

function EmptyState({ icon, title, description }: { icon: string; title: string; description: string }) {
  return <View style={styles.empty}>
    <Icon name={icon} size={30} color={lilac} />
    <Text style={styles.emptyTitle}>{title}</Text>
    <Text style={styles.emptyDescription}>{description}</Text>
  </View>;
}

function SongRow({ track, number, onPlay, onTrackMenu }: { track: Track; number?: number; onPlay: () => void; onTrackMenu: BrowseProps['onTrackMenu'] }) {
  const { state, actions } = usePlaybackState();
  const liked = state.favorites.includes(track.id);
  const current = state.trackId === track.id;
  return <ReanimatedSwipeable
    friction={1.8}
    overshootRight={false}
    rightThreshold={35}
    renderRightActions={(_progress, _drag, controls) => <Pressable accessibilityRole="button" accessibilityLabel={`Play ${track.title} next`} style={({ pressed }) => [styles.swipeAction, pressed && styles.pressed]} onPress={() => {
      tapFeedback();
      actions.addToQueue(track.id, 'next');
      controls.close();
    }}>
      <Icon name="text.badge.plus" size={19} color={ink} />
      <Text style={styles.swipeText}>Play next</Text>
    </Pressable>}
  >
    <View style={[styles.songRow, current && styles.songCurrent]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Play ${track.title} by ${track.artist}`} style={({ pressed }) => [styles.songInfo, pressed && styles.pressed]} onPress={onPlay} onLongPress={() => onTrackMenu(track.id)}>
        {typeof number === 'number' ? <View style={styles.songPosition}>
          {current ? <Icon name={state.playing ? 'waveform' : 'pause.fill'} size={17} color={lilac} /> : <Text style={styles.songNumber}>{number}</Text>}
        </View> : <Cover source={albums[track.albumId].artwork} size={42} radius={8} />}
        <View style={styles.flex}>
          <Text numberOfLines={1} style={[styles.rowTitle, current && styles.currentTitle]}>{track.title}</Text>
          <Text numberOfLines={1} style={styles.rowSub}>{track.artist}</Text>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={liked ? `Unlike ${track.title}` : `Like ${track.title}`} accessibilityState={{ selected: liked }} onPress={() => { tapFeedback(); actions.toggleFavorite(track.id); }} style={styles.rowIcon}>
        <Icon name={liked ? 'heart.fill' : 'heart'} size={19} color={liked ? lilac : muted} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`More options for ${track.title}`} onPress={() => onTrackMenu(track.id)} style={styles.rowIcon}>
        <Icon name="ellipsis" size={19} color={muted} />
      </Pressable>
    </View>
  </ReanimatedSwipeable>;
}

export function AlbumScreen({ albumId, onBack, onTrackMenu, bottomInset = 155 }: AlbumProps) {
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { state, actions } = usePlaybackState();
  const album = Object.hasOwn(albums, albumId) ? albums[albumId] : undefined;
  const artist = artistCollections.find(item => item.id === albumId);
  const item = album ? albumCollection(album) : albumId === 'favorites' ? favorites : albumId === 'recent' ? recentlyPlayed : artist;
  const trackIds = album?.trackIds ?? (albumId === 'favorites' ? state.favorites : albumId === 'recent' ? [...new Set([...state.history].reverse().map(entry => entry.trackId))] : allTracks.filter(track => track.artist === artist?.title).map(track => track.id));
  const totalSeconds = trackIds.reduce((seconds, id) => seconds + tracks[id].duration, 0);
  const artSize = Math.min(238, Math.floor(width * 0.60));
  const hasSongs = trackIds.length > 0;

  if (!item) return <View style={[styles.page, { paddingTop: top + 8 }]}>
    <View style={styles.detailNav}><RoundButton icon="chevron.left" label="Go back" onPress={onBack} /></View>
    <EmptyState icon="music.note" title="Collection unavailable" description="Go back to browse your library." />
  </View>;

  function play(shuffled = false, trackId?: string) {
    tapFeedback();
    if (album) actions.playAlbum(album.id, { shuffled, trackId });
    else actions.playCollection(trackIds, { shuffled, trackId });
  }

  return <View style={styles.page}>
    <LinearGradient pointerEvents="none" colors={[album?.color ?? '#4F466A', ink]} locations={[0, 1]} style={styles.detailGradient} />
    <View style={[styles.detailNav, { paddingTop: top + 6 }]}>
      <RoundButton icon="chevron.left" label="Go back" onPress={onBack} />
      {(album || artist) && <RoundButton icon="square.and.arrow.up" label={`Share ${item.title}`} onPress={() => {
        void Share.share({ message: album ? `${item.title} · ${album.artist}` : item.title }).catch(() => Alert.alert('Sharing unavailable'));
      }} />}
    </View>
    <ScrollView contentContainerStyle={{ paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
      <View style={styles.detailHeader}>
        <View style={styles.detailArt}><CollectionCover item={item} size={artSize} radius={17} /></View>
        <Text style={styles.detailMeta}>{album ? [album.kind, album.genre, String(album.year)].join('  ·  ') : item.subtitle}</Text>
        <Text accessibilityRole="header" style={styles.detailTitle}>{item.title}</Text>
        {album && <Text style={styles.detailArtist}>{album.artist}</Text>}
        {hasSongs && <View style={styles.detailControls}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Play ${item.title}`} onPress={() => play()} style={({ pressed }) => [styles.detailPlay, pressed && styles.pressed]}>
            <Icon name="play.fill" size={16} color={ink} /><Text style={styles.playText}>Play</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Shuffle ${item.title}`} onPress={() => play(true)} style={({ pressed }) => [styles.detailShuffle, pressed && styles.pressed]}>
            <Icon name="shuffle" size={18} color={ivory} /><Text style={styles.shuffleText}>Shuffle</Text>
          </Pressable>
        </View>}
      </View>
      {album?.description && <Text style={styles.detailDescription}>{album.description}</Text>}
      {hasSongs && <>
        <View style={styles.trackListHeader}>
          <Text accessibilityRole="header" style={styles.trackListTitle}>Tracklist</Text>
          <Text style={styles.trackCount}>{trackIds.length} {trackIds.length === 1 ? 'song' : 'songs'} · {Math.max(1, Math.round(totalSeconds / 60))} min</Text>
        </View>
        <View style={styles.trackList}>
          {trackIds.map((id, index) => <SongRow key={`${id}-${index}`} track={tracks[id]} number={album?.kind === 'Album' ? index + 1 : undefined} onPlay={() => play(false, id)} onTrackMenu={onTrackMenu} />)}
        </View>
      </>}
      {!hasSongs && <EmptyState icon={item.icon ?? 'music.note'} title={albumId === 'favorites' ? 'Your favorites go here' : 'Nothing played yet'} description={albumId === 'favorites' ? 'Tap a heart next to any song to save it here.' : 'Play a song and it will appear in your history.'} />}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: ink },
  flex: { flex: 1 },
  pressed: { opacity: 0.72 },
  homeHeader: { paddingHorizontal: gutter, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 41 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandMark: { width: 27, height: 27, borderRadius: 9, backgroundColor: lilac, alignItems: 'center', justifyContent: 'center' },
  wordmark: { color: ivory, fontWeight: '800', letterSpacing: 3.8, fontSize: 12 },
  avatar: { width: 39, height: 39, borderRadius: 21, backgroundColor: '#282235', borderWidth: 1, borderColor: '#514660', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: lilac, fontSize: 16, fontWeight: '700' },
  homeTitle: { marginHorizontal: gutter, marginTop: 13, marginBottom: 19 },
  pageTitle: { color: ivory, fontSize: 37, letterSpacing: -1.65, fontWeight: '800' },
  pageHeader: { marginHorizontal: gutter, flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 12 },
  hero: { marginHorizontal: gutter, borderRadius: 26, overflow: 'hidden', justifyContent: 'flex-end', backgroundColor: '#322940' },
  heroCover: { position: 'absolute', top: 0, left: 0 },
  heroBottom: { flexDirection: 'row', alignItems: 'flex-end', padding: 20, gap: 14 },
  heroCategory: { color: '#E9DFFF', fontSize: 10, fontWeight: '800', letterSpacing: 2.1, marginBottom: 5 },
  heroTitle: { color: ivory, fontSize: 37, lineHeight: 39, letterSpacing: -1.6, fontWeight: '800' },
  heroCaption: { color: '#E5DBEF', fontSize: 13, marginTop: 5, fontWeight: '500' },
  heroPlay: { backgroundColor: lilac, width: 53, height: 53, borderRadius: 27, alignItems: 'center', justifyContent: 'center', paddingLeft: 2 },
  homeSection: { marginTop: 26 },
  sectionTitle: { marginHorizontal: gutter, marginBottom: 13, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  sectionText: { color: ivory, fontSize: 22, fontWeight: '700', letterSpacing: -0.65 },
  sectionLink: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  sectionLinkText: { color: lilac, fontSize: 12, fontWeight: '700' },
  railContent: { paddingHorizontal: gutter, gap: 12 },
  specialCover: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  coverRing: { position: 'absolute', borderColor: '#FFF8FF50', borderWidth: StyleSheet.hairlineWidth },
  tileTitle: { fontSize: 13, fontWeight: '700', color: ivory, marginTop: 8 },
  tileSub: { color: muted, fontSize: 12, marginTop: 3 },
  roundButton: { width: 43, height: 43, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: '#25212D', borderWidth: StyleSheet.hairlineWidth, borderColor: '#FFFFFF21' },
  librarySearch: { paddingHorizontal: gutter, paddingTop: 11 },
  filters: { flexDirection: 'row', paddingHorizontal: gutter, gap: 8, marginTop: 15, marginBottom: 12 },
  filter: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 19, minHeight: 35, justifyContent: 'center', backgroundColor: panel, borderWidth: StyleSheet.hairlineWidth, borderColor: '#FFFFFF18' },
  filterActive: { backgroundColor: lilac, borderColor: lilac },
  filterText: { fontSize: 13, color: ivory, fontWeight: '600' },
  filterTextActive: { color: ink },
  libraryBody: { paddingHorizontal: gutter },
  sortRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 43, marginBottom: 4 },
  sortLabel: { minHeight: 38, flexDirection: 'row', gap: 8, alignItems: 'center' },
  sortText: { color: muted, fontSize: 13, fontWeight: '600' },
  viewMode: { width: 38, height: 38, alignItems: 'flex-end', justifyContent: 'center' },
  libraryGrid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 19 },
  collectionRow: { paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#FFFFFF12' },
  rowTitle: { color: ivory, fontWeight: '600', fontSize: 15, letterSpacing: -0.2 },
  rowSub: { marginTop: 3, color: muted, fontSize: 12 },
  searchHeader: { marginHorizontal: gutter, marginTop: 13, marginBottom: 25 },
  searchField: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 47, paddingHorizontal: 13, borderRadius: 13, backgroundColor: panel, borderWidth: StyleSheet.hairlineWidth, borderColor: '#FFFFFF16' },
  searchInput: { color: ivory, fontSize: 15, flex: 1, minHeight: 43, paddingVertical: 0 },
  genres: { paddingHorizontal: gutter, gap: 12, flexDirection: 'row', flexWrap: 'wrap' },
  genreCard: { minHeight: 108, borderRadius: 15, padding: 14, overflow: 'hidden' },
  genreTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  genreArt: { position: 'absolute', bottom: -17, right: -7, transform: [{ rotate: '24deg' }] },
  resultSection: { marginBottom: 23 },
  empty: { alignItems: 'center', gap: 7, padding: 28, marginTop: 22 },
  emptyTitle: { color: ivory, fontSize: 19, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  emptyDescription: { color: muted, fontSize: 14, textAlign: 'center', lineHeight: 21 },
  detailNav: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: gutter, paddingBottom: 6 },
  detailGradient: { position: 'absolute', top: 0, left: 0, right: 0, height: 460 },
  detailHeader: { alignItems: 'center', paddingHorizontal: gutter },
  detailArt: { marginTop: 8, marginBottom: 21, shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.42, shadowRadius: 22 },
  detailMeta: { color: '#D7CDEF', fontSize: 11, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase' },
  detailTitle: { color: ivory, fontSize: 33, fontWeight: '800', textAlign: 'center', letterSpacing: -1.1, marginTop: 5 },
  detailArtist: { color: muted, fontSize: 16, fontWeight: '500', textAlign: 'center', marginTop: 3 },
  detailControls: { flexDirection: 'row', gap: 9, marginTop: 18, alignSelf: 'stretch' },
  detailPlay: { backgroundColor: lilac, borderRadius: 24, minHeight: 46, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9, flex: 1 },
  detailShuffle: { backgroundColor: '#27232E', borderRadius: 24, minHeight: 46, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9, flex: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: '#FFFFFF18' },
  playText: { color: ink, fontSize: 15, fontWeight: '700' },
  shuffleText: { color: ivory, fontSize: 15, fontWeight: '700' },
  detailDescription: { marginHorizontal: gutter, color: muted, fontSize: 14, lineHeight: 21, marginTop: 18 },
  trackListHeader: { marginTop: 24, marginHorizontal: gutter, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: 8 },
  trackListTitle: { color: ivory, fontSize: 19, fontWeight: '700', letterSpacing: -0.4 },
  trackCount: { color: faint, fontSize: 12, fontWeight: '600' },
  trackList: { marginHorizontal: gutter - 4 },
  songRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#FFFFFF15', paddingLeft: 5, paddingRight: 2, minHeight: 58 },
  songCurrent: { backgroundColor: '#CBC1FF12', borderRadius: 11 },
  songInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: 10 },
  songPosition: { width: 25, alignItems: 'center', marginRight: 2 },
  songNumber: { fontSize: 13, color: faint, fontVariant: ['tabular-nums'] },
  currentTitle: { color: lilac },
  rowIcon: { width: 42, height: 44, alignItems: 'center', justifyContent: 'center' },
  swipeAction: { backgroundColor: lilac, width: 78, alignItems: 'center', justifyContent: 'center', gap: 3, borderTopLeftRadius: 10, borderBottomLeftRadius: 10 },
  swipeText: { color: ink, fontSize: 10, fontWeight: '700' },
});
