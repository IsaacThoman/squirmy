import { albumPresentation, type SearchTop } from '@squirmy/client-core';
import { queryKeys, type AlbumSummary, type HomeSection, type TrackSummary } from '@squirmy/contracts';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useSignedInApi, useWantlistEnabled } from './account/AccountProvider';
import { shade } from './data/color';
import {
  libraryMatchLimit, libraryMatchMinLength, useGenreCovers, useGenres, useHome, useLibraryAlbums, useLibraryArtists, useLibraryMatches,
  useLibraryTracks, usePlaylists, useSearch,
} from './data/queries';
import { useTrackStore } from './data/library';
import { useAvailability, useViewer } from './downloads/DownloadsProvider';
import {
  BrowseButton, CollectionGridRow, CollectionRow, GenreGrid, HeroActions, LibraryFilters, LibrarySort, SearchField, TopResult,
  type SearchHandle,
} from './library/BrowseControls';
import { keepOrder, searchView, type SearchView } from './library/search';
import { sortFor, sortOptions, sortsFor, type SortName } from './library/sorting';
import type { Page } from './library/links';
import { useStartGuard } from './library/pending';
import { underStatusBar, useRefreshControl } from './library/refresh';
import { displayFontScale } from './fontScale';
import {
  albumCollection, artistCollection, CollectionCover, CollectionRail, EmptyState, gutter, likedCollection, matches, OfflineBadge,
  playlistCollection, QueryState, RailPlaceholder, SectionTitle, tapFeedback, TopResultPlaceholder, useCollectionDim, type Collection,
} from './library/shared';
import { useRealtime } from './data/realtime';
import { SongList, useSongListItems } from './library/SongList';
import { usePlayAll } from './library/usePlayAll';
import { chunk, type SongRowItem } from './library/rows';
import { ZoomLink, ZoomSource } from './library/ZoomLink';
import { usePlaybackActions, useTrackLoading } from './playback';
import { STILL_LOADING_LABEL } from './player/loading';
import { createThemedStyles, unavailableOpacity, useColors } from './theme';
import { Cover } from './ui';


export type BrowseProps = {
  /** Where a page lives in this tab. Tiles link there so the page can zoom out of their cover. */
  link: (page: Page, id: string) => Href;
  onOpen: (href: Href) => void;
  onTrackMenu: (track: TrackSummary, playlist?: { id: string; itemId: string }) => void;
  onOpenDevices?: () => void;
  onOpenAccount?: () => void;
  onOpenDownloads?: () => void;
  bottomInset?: number;
};

/**
 * Plays an album from its tile: its tracks come from the cached page when there is one,
 * otherwise from the server. `pending` is true while that request is out; taps meanwhile are ignored.
 */
export function useAlbumPlayer() {
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  const tracks = useTrackStore();
  const actions = usePlaybackActions();
  const starts = useStartGuard();
  const play = (albumId: string) => {
    if (!api) return;
    starts.run(albumId, () => queryClient.ensureQueryData({ queryKey: queryKeys.album(albumId), queryFn: () => api.catalog.album(albumId) }).then(album => {
      const list = album.discs.flatMap(disc => disc.tracks);
      tracks.prime(list);
      actions.playTracks(list, { shuffle: false, context: { type: 'album', id: album.id, title: album.title } });
    }));
  };
  return { play, pending: starts.pending };
}

/** The featured album. Its page zooms out of the whole card; the enclosing `ZoomLink` supplies `onPress`. */
function HeroCard({ album, size, onPress }: { album: AlbumSummary; size: number; onPress?: () => void }) {
  const albumPlayer = useAlbumPlayer();
  const styles = useStyles();
  return <ZoomSource style={[styles.hero, { minHeight: Math.min(350, size * 0.85), backgroundColor: album.artwork?.color ?? '#322940' }]}>
    <Cover artwork={album.artwork} size={size} radius={0} style={styles.heroCover} />
    <LinearGradient colors={['#100D1600', '#100D1660', '#100D16E8']} locations={[0, 0.40, 1]} style={StyleSheet.absoluteFill} />
    <HeroActions title={album.title} artist={album.artistCredit} onOpen={() => onPress?.()}
      onPlay={() => { tapFeedback(); albumPlayer.play(album.id); }} busy={albumPlayer.pending(album.id)} />
  </ZoomSource>;
}

function sectionSize(section: HomeSection) {
  switch (section.kind) {
    case 'albums': return section.albums.length;
    case 'artists': return section.artists.length;
    case 'tracks': return section.tracks.length;
    case 'playlists': return section.playlists.length;
  }
}

function HomeRail({ section, link, onOpen, onTrackMenu }: { section: HomeSection } & Pick<BrowseProps, 'link' | 'onOpen' | 'onTrackMenu'>) {
  const styles = useStyles();
  const actions = usePlaybackActions();
  const seeAll = section.id === 'recently-played' ? () => onOpen(link('playlist', 'recent')) : undefined;
  return <View style={styles.homeSection}>
    <SectionTitle title={section.title} onPress={seeAll} />
    {section.kind === 'albums' && <CollectionRail items={section.albums.map(album => albumCollection(album, link))}
      size={section.id === 'recently-added' ? 146 : 131} />}
    {section.kind === 'artists' && <CollectionRail items={section.artists.map(artist => artistCollection(artist, link))} size={110} />}
    {section.kind === 'playlists' && <CollectionRail items={section.playlists.map(playlist => playlistCollection(playlist, link))} />}
    {section.kind === 'tracks' && <View style={styles.trackList}>
      <SongList tracks={section.tracks.slice(0, 5)} onTrackMenu={track => onTrackMenu(track)}
        onPlay={start => actions.playTracks(section.tracks, { start, context: { type: 'other', id: section.id, title: section.title } })} />
    </View>}
  </View>;
}

export function HomeScreen({ link, onOpen, onTrackMenu, onOpenDevices, onOpenAccount, bottomInset = 155 }: BrowseProps) {
  const colors = useColors();
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { state } = useAccount();
  const home = useHome();
  const collectionDim = useCollectionDim();
  const wantlist = useWantlistEnabled();
  // A Home saved before the wantlist was switched off, or from an older server, may still have it.
  const sections = (home.data?.sections ?? []).filter(section => sectionSize(section) > 0 && (wantlist || section.id !== 'wantlist'));
  const albums = (id: string) => sections.find((section): section is Extract<HomeSection, { kind: 'albums' }> => section.kind === 'albums' && section.id === id)?.albums;
  const viewer = useViewer();
  // The first thing on Home: something that plays, never a gray card of an album this viewer can't play.
  const playable = (album: AlbumSummary) => albumPresentation(album, viewer) === 'normal';
  const hero = albums('recently-played')?.find(playable) ?? albums('recently-added')?.find(playable);
  const heroSize = width - gutter * 2;
  const serverName = state.status === 'signedIn' ? state.server.name : 'your server';
  const refreshControl = useRefreshControl(home.refetch, top);
  const statusBar = underStatusBar(top);

  return <View style={styles.page}>
    <LinearGradient pointerEvents="none" colors={[colors.background, colors.background, `${colors.background}00`]}
      locations={[0, top / (top + 14), 1]} style={[styles.statusFade, { height: top + 14 }]} />
    <ScrollView contentInsetAdjustmentBehavior="never" refreshControl={refreshControl} {...statusBar.props}
      contentContainerStyle={{ paddingTop: statusBar.contentTop + 12, paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
      <View style={[styles.pageHeader, styles.homeHeader]}>
        <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={[styles.pageTitle, styles.flex]}>Listen now</Text>
        {onOpenDevices && <BrowseButton label="Playback devices" icon="laptopcomputer.and.iphone" glass onPress={onOpenDevices} />}
        {onOpenAccount && <BrowseButton label="Account" icon="person.crop.circle" glass onPress={onOpenAccount} />}
      </View>
      <OfflineBadge style={styles.homeOffline} />
      {!home.data && <QueryState query={home} what="your music" />}
      {home.data && !sections.length && <EmptyState icon="music.note.house" title="No music yet"
        description={`Add music to a library folder on ${serverName}. It shows up here as soon as it has been scanned.`} />}
      {hero && <View style={collectionDim(albumCollection(hero, link)).dim && styles.unavailable}>
        <ZoomLink href={link('album', hero.id)}><HeroCard album={hero} size={heroSize} /></ZoomLink>
      </View>}
      {sections.map(section => <HomeRail key={section.id} section={section} link={link} onOpen={onOpen} onTrackMenu={onTrackMenu} />)}
    </ScrollView>
  </View>;
}

const filters = ['All', 'Playlists', 'Albums', 'Artists', 'Songs'] as const;
/** A tap on a song plays it and this many after it. */
const songsAfter = 300;
type LibraryFilter = (typeof filters)[number];
/** Rows drawn per batch, and screens' worth kept around the visible part. */
const libraryBatch = 12;
const libraryWindow = 7;

type LibraryRow =
  | { kind: 'song'; key: string; song: SongRowItem }
  | { kind: 'tiles'; key: string; items: readonly Collection[] }
  | { kind: 'row'; key: string; item: Collection };

const libraryRowKey = (row: LibraryRow) => row.key;

/**
 * What an empty Library says. The library is what this user hearted plus the music the
 * server's owner brought, not everything that was ever played, so it starts out empty for
 * someone who only streams; Home's Recently played and Most played carry what they listened to.
 */
const emptyLibrary = {
  Albums: { icon: 'square.stack', title: 'Add music to your library',
    description: 'Albums and songs you save show up here, with the music stored on your server. Find something you love and tap the heart.' },
  Songs: { icon: 'music.note', title: 'No songs yet', description: 'Songs you heart, and the songs of albums you heart, show up here.' },
  Artists: { icon: 'music.mic', title: 'No artists yet', description: 'Artists you heart, and the artists of albums in your library, show up here.' },
} as const;

export function LibraryScreen({ link, onTrackMenu, onOpen, onOpenDownloads, bottomInset = 155 }: BrowseProps) {
  const styles = useStyles();
  const collectionDim = useCollectionDim();
  const { offline } = useRealtime();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const actions = usePlaybackActions();
  const router = useRouter();
  const [filter, setFilter] = useState<LibraryFilter>('All');
  const [sortName, setSortName] = useState<SortName>('Recently added');
  const [grid, setGrid] = useState(true);
  const [showFilter, setShowFilter] = useState(false);
  const [query, setQuery] = useState('');
  const sorts = sortsFor(filter);
  const sort = sortOptions[sortName];
  const columns = width >= 650 ? 4 : 3;
  const size = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);
  const showsPlaylists = filter === 'All' || filter === 'Playlists';
  const showsAlbums = filter === 'All' || filter === 'Albums';
  // Only the lists the filter shows are loaded.
  const albums = useLibraryAlbums(sort, showsAlbums);
  // The server lists artists by name whatever the order asked for.
  const artists = useLibraryArtists('title', filter === 'Artists');
  const songSort = sortOptions[sortFor('Songs', sortName)];
  const songs = useLibraryTracks(songSort, filter === 'Songs');
  // A tap plays the song and the next few hundred, as on the web, not just the rows scrolled past.
  const playSongs = usePlayAll({
    list: songs, tracksOf: items => [...items], limit: start => start + songsAfter,
    fetchPage: (api, cursor, limit) => api.catalog.tracks({ sort: songSort, cursor, limit }),
  });
  const playlists = usePlaylists(showsPlaylists);
  // A filter of two characters or more searches the whole library on the server; a single
  // character only narrows what is already loaded.
  const searchText = filter === 'Playlists' ? '' : query;
  const found = useLibraryMatches(searchText);
  const searching = [...searchText.trim()].length >= libraryMatchMinLength;
  const listed = filter === 'Artists' ? artists : filter === 'Songs' ? songs : filter === 'Playlists' ? playlists : albums;
  const active = searching ? found : listed;
  const loadMore = searching ? undefined : listed.loadMore;
  const matched = found.data;

  const items = useMemo(() => {
    const collections: Collection[] = [];
    if (showsPlaylists) {
      collections.push(...[likedCollection(link), ...playlists.items.map(playlist => playlistCollection(playlist, link))]
        .filter(item => matches(query, item.title, item.subtitle)));
    }
    // Sorted by year, the year says why an album is where it is.
    const subtitle = (album: AlbumSummary) => sort === 'year' && album.year ? `${album.artistCredit} · ${album.year}` : album.artistCredit;
    if (showsAlbums) {
      collections.push(...searching ? (matched?.albums ?? []).map(album => albumCollection(album, link))
        : albums.items.map(album => albumCollection(album, link, subtitle(album))).filter(item => matches(query, item.title, item.subtitle)));
    }
    if (filter === 'Artists') {
      collections.push(...searching ? (matched?.artists ?? []).map(artist => artistCollection(artist, link))
        : artists.items.map(artist => artistCollection(artist, link)).filter(item => matches(query, item.title, item.subtitle)));
    }
    return collections.map(collectionDim);
  }, [albums.items, artists.items, filter, link, matched, collectionDim, playlists.items, query, searching, showsAlbums, showsPlaylists, sort]);
  const tracks = useMemo(() => searching ? matched?.tracks ?? []
    : songs.items.filter(track => matches(query, track.title, track.artistCredit, track.album?.title ?? '')), [matched, query, searching, songs.items]);
  const songItems = useSongListItems({
    tracks, onTrackMenu: track => onTrackMenu(track),
    onPlay: start => {
      const play = (list: readonly TrackSummary[]) => actions.playTracks(list, { start, context: { type: 'other', id: null, title: 'Songs' } });
      // Filtered, the matches on screen are what is played.
      if (query.trim()) play(tracks);
      else playSongs.run(start, false, play);
    },
  });
  const empty = filter === 'Songs' ? !tracks.length : !items.length;
  const libraryEmpty = albums.data && !albums.items.length && !query;
  const capped = searching && matched && (filter === 'Songs' ? matched.tracks : filter === 'Artists' ? matched.artists : matched.albums).length >= libraryMatchLimit;

  const mode = filter === 'Songs' ? 'songs' : grid ? 'grid' : 'list';
  const rows = useMemo((): LibraryRow[] => {
    if (mode === 'songs') return songItems.data.map(song => ({ kind: 'song', key: song.key, song }));
    if (mode === 'grid') return chunk(items, columns).map(row => ({ kind: 'tiles', key: row[0]!.key, items: row }));
    return items.map(item => ({ kind: 'row', key: item.key, item }));
  }, [columns, items, mode, songItems.data]);
  const renderSong = songItems.renderItem;
  const renderRow = useCallback(({ item: row }: { item: LibraryRow }) => {
    switch (row.kind) {
      case 'song': return <View style={styles.songs}>{renderSong({ item: row.song })}</View>;
      case 'tiles': return <CollectionGridRow items={row.items.map(item => ({
        id: item.key, title: item.title, subtitle: item.subtitle, size,
        cover: <CollectionCover item={item} size={size} />, href: item.href, dim: item.dim,
      }))} />;
      case 'row': return <CollectionRow title={row.item.title} subtitle={row.item.subtitle} size={50} dim={row.item.dim}
        cover={<CollectionCover item={row.item} size={50} radius={9} />} href={row.item.href} />;
    }
  }, [renderSong, size, styles]);
  // Searching, a pull reloads the matches; otherwise the list, and the playlists shown with it.
  const refreshControl = useRefreshControl(() => Promise.all([active.refetch(), showsPlaylists && active !== playlists && playlists.refetch()]));

  // An empty library is an invitation: Search is where music is found and added.
  const findMusic = { title: 'Find music', onPress: () => { tapFeedback(); router.navigate('/(tabs)/(search)'); } };

  const newPlaylist = () => {
    tapFeedback();
    onOpen({ pathname: '/name-playlist', params: { mode: 'create' } });
  };

  return <View style={[styles.page, { paddingTop: top + 12 }]}>
    <View style={styles.pageHeader}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={[styles.pageTitle, styles.flex]}>Library</Text>
      <OfflineBadge />
      {onOpenDownloads && <BrowseButton glass icon="arrow.down.circle" label="Downloads" onPress={() => { tapFeedback(); onOpenDownloads(); }} />}
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
    <FlatList key={mode} data={rows} renderItem={renderRow} keyExtractor={libraryRowKey}
      refreshControl={refreshControl}
      initialNumToRender={libraryBatch} maxToRenderPerBatch={libraryBatch} windowSize={libraryWindow}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      onEndReached={loadMore} onEndReachedThreshold={1.5}
      contentContainerStyle={[styles.libraryBody, { paddingBottom: bottomInset }]} showsVerticalScrollIndicator={false}
      ListHeaderComponent={<>
        <View style={styles.sortRow}>
          {/* Matches from the server come best first, whatever the sort. */}
          {filter === 'Playlists'
            ? !offline && <BrowseButton label="New playlist" title="New playlist" icon="plus" onPress={newPlaylist} />
            : !searching && sorts.length > 0 ? <LibrarySort options={sorts} value={sortFor(filter, sortName)} onChange={setSortName} /> : <View />}
          {filter !== 'Songs' && <BrowseButton label={grid ? 'Show list view' : 'Show grid view'} icon={grid ? 'list.bullet' : 'square.grid.2x2'}
            onPress={() => { tapFeedback(); setGrid(!grid); }} />}
          {filter === 'Songs' && playSongs.busy && <ActivityIndicator accessibilityLabel="Loading songs" />}
        </View>
        {!active.data && <QueryState query={active} what="your library" />}
        {libraryEmpty && filter !== 'Playlists' ? <EmptyState {...emptyLibrary.Albums} action={findMusic} />
          : active.data && empty && !(searching && found.pending) && (query || filter === 'Playlists'
            ? <EmptyState icon="magnifyingglass" title={query ? 'Nothing found' : 'Nothing here yet'}
              description={query ? 'Try another search or filter.' : 'Try another filter.'} />
            : <EmptyState {...emptyLibrary[filter === 'Songs' ? 'Songs' : filter === 'Artists' ? 'Artists' : 'Albums']} action={findMusic} />)}
      </>}
      ListFooterComponent={<>
        {(searching ? found.pending && !empty : listed.isFetchingNextPage) && <ActivityIndicator style={styles.more} />}
        {capped && <Text style={styles.matchNote}>Showing the best {libraryMatchLimit} matches. Type more to narrow them down.</Text>}
      </>} />
  </View>;
}

const topCoverSize = 76;

/** The best match: an artist or album opens its page (an album can also play); a song plays with the songs found. */
function TopResultView({ top, tracks, link, onTrackMenu }: { top: SearchTop; tracks: readonly TrackSummary[] } & Pick<BrowseProps, 'link' | 'onTrackMenu'>) {
  const albumPlayer = useAlbumPlayer();
  const actions = usePlaybackActions();
  const { canPlay } = useAvailability();
  const collectionDim = useCollectionDim();
  const loading = useTrackLoading(top.type === 'track' ? top.track.id : undefined);
  if (top.type === 'track') {
    const { track } = top;
    const playable = canPlay(track);
    const subtitle = loading === 'slow' ? STILL_LOADING_LABEL : `Song · ${track.artistCredit}`;
    const play = () => {
      tapFeedback();
      actions.playTracks(tracks, { start: Math.max(0, tracks.indexOf(track)), context: { type: 'search', id: null, title: null } });
    };
    return <TopResult title={track.title} subtitle={subtitle} size={topCoverSize} dim={!playable}
      cover={<Cover artwork={track.album?.artwork} size={topCoverSize} radius={10} />}
      onPress={playable ? play : () => onTrackMenu(track)} onPlay={playable ? play : undefined} busy={loading !== 'none'} />;
  }
  const item = collectionDim(top.type === 'album' ? albumCollection(top.album, link, `Album · ${top.album.artistCredit}`) : artistCollection(top.artist, link));
  const play = top.type === 'album' && !item.dim ? () => { tapFeedback(); albumPlayer.play(top.album.id); } : undefined;
  return <TopResult title={item.title} subtitle={item.subtitle} size={topCoverSize} dim={item.dim} href={item.href}
    cover={<CollectionCover item={item} size={topCoverSize} radius={10} />} onPlay={play}
    busy={top.type === 'album' && albumPlayer.pending(top.album.id)} />;
}

/**
 * One result set: the top result, then artists, albums and songs. Rows the library answer
 * showed keep their places when the catalog's arrive after them; a section the library had
 * nothing for is held open meanwhile, so nothing below it moves.
 */
function SearchResultsView({ view, link, onTrackMenu }: { view: SearchView } & Pick<BrowseProps, 'link' | 'onTrackMenu'>) {
  const styles = useStyles();
  const actions = usePlaybackActions();
  const { top, artists, albums, tracks, waiting } = view;
  const context = { type: 'search', id: null, title: null } as const;
  if (view.empty) return <EmptyState icon="magnifyingglass" title="No results" description="Try a different song, album, or artist." />;
  return <>
    {(top || waiting.top) && <View style={styles.resultSection}>
      <SectionTitle title="Top result" />
      <View style={styles.topResult}>
        {top ? <TopResultView top={top} tracks={tracks} link={link} onTrackMenu={onTrackMenu} /> : <TopResultPlaceholder size={topCoverSize} />}
      </View>
    </View>}
    {(artists.length > 0 || waiting.artists) && <View style={styles.resultSection}>
      <SectionTitle title="Artists" />
      {artists.length ? <CollectionRail items={artists.map(artist => artistCollection(artist, link))} size={92} /> : <RailPlaceholder size={92} round />}
    </View>}
    {(albums.length > 0 || waiting.albums) && <View style={styles.resultSection}>
      <SectionTitle title="Albums" />
      {albums.length ? <CollectionRail items={albums.map(album => albumCollection(album, link))} size={115} /> : <RailPlaceholder size={115} />}
    </View>}
    {tracks.length > 0 && <View style={styles.resultSection}>
      <SectionTitle title="Songs" />
      <View style={styles.trackList}>
        <SongList tracks={tracks} onTrackMenu={track => onTrackMenu(track)} onPlay={start => actions.playTracks(tracks, { start, context })} />
      </View>
    </View>}
  </>;
}

export function SearchScreen({ link, onOpen, onTrackMenu, bottomInset = 155 }: BrowseProps) {
  const colors = useColors();
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const searchInput = useRef<SearchHandle>(null);
  const navigation = useNavigation();
  const tabs = useNavigation<{ addListener: (event: 'tabPress', listener: () => void) => () => void }>('/(tabs)');
  const search = useSearch(query);
  const viewer = useViewer();
  const genres = useGenres();
  const genreWidth = Math.floor((width - gutter * 2 - 12) / 2);
  const { offline } = useRealtime();

  useEffect(() => tabs.addListener('tabPress', () => {
    if (navigation.isFocused()) searchInput.current?.focus();
  }), [navigation, tabs]);

  // The server answers nothing under two characters; keep the genres until a search can find something.
  const active = query.trim().length >= 2;
  // While the query changes, both answers stay those of the last query until the new ones
  // arrive. Once one is for the new query, the other's old answer is dropped: rows of the
  // last query must not show under the new one.
  const both = search.library.isPlaceholderData && search.catalog.isPlaceholderData;
  const library = both || !search.library.isPlaceholderData ? search.library.data : undefined;
  const catalog = both || !search.catalog.isPlaceholderData ? search.catalog.data : undefined;
  const catalogPending = catalog === undefined && !search.catalog.isError;
  const answered = library !== undefined || catalog !== undefined;
  // The order rows were shown in for this query, so a refreshed answer does not move them.
  const shown = useRef<{ query: string; order: Parameters<typeof keepOrder>[1] }>({ query: '', order: null });
  const view = useMemo(() => {
    const merged = searchView(library, catalog, viewer, catalogPending);
    // Both answers are of the last query until one of the new query arrives.
    const answeredQuery = both ? shown.current.query : search.query;
    const kept = keepOrder(merged, shown.current.query === answeredQuery ? shown.current.order : null);
    shown.current = { query: answeredQuery, order: kept.order };
    return kept.view;
  }, [both, catalog, catalogPending, library, search.query, viewer]);
  const genreNames = (genres.data ?? []).slice(0, 6).map(genre => genre.name);
  const genreCovers = useGenreCovers(genreNames);
  const queryClient = useQueryClient();
  const refreshControl = useRefreshControl(() => active
    ? Promise.all([search.library.refetch(), search.catalog.refetch()])
    : Promise.all([genres.refetch(), queryClient.refetchQueries({ queryKey: [...queryKeys.libraryAlbums(), 'genre'], type: 'active' })]));

  return <View style={[styles.page, { paddingTop: top + 12 }]}>
    <View style={styles.pageHeader}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={[styles.pageTitle, styles.flex]}>Search</Text>
      {active && answered && search.pending && !offline && <ActivityIndicator color={colors.muted} />}
      <OfflineBadge />
    </View>
    <View style={styles.searchHeader}><SearchField inputRef={searchInput} value={query} onChange={setQuery} placeholder="Songs, albums, artists" /></View>
    <ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" refreshControl={refreshControl}
      contentContainerStyle={{ paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
      {!active ? genreNames.length > 0 && <>
        <SectionTitle title="Browse by genre" />
        <View style={styles.genres}>
          <GenreGrid items={genreNames.map((name, index) => {
            const artwork = genreCovers[index]?.artwork;
            return {
              id: name, title: name, width: genreWidth, color: shade(artwork?.color),
              cover: <Cover artwork={artwork} size={85} radius={8} />, onPress: () => onOpen(link('genre', name)),
            };
          })} />
        </View>
      </> : offline
        ? <EmptyState icon="wifi.slash" title="You’re offline" description="Search needs your server. Your downloads are in your Library." />
        : answered
        ? <SearchResultsView view={view} link={link} onTrackMenu={onTrackMenu} />
        : search.library.isError && search.catalog.isError
          ? <EmptyState icon="wifi.exclamationmark" title="Search isn’t available" description="Check your connection to the server." />
          : <View style={styles.searching}><ActivityIndicator color={colors.muted} /></View>}
    </ScrollView>
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  homeHeader: { marginBottom: 19 },
  homeOffline: { marginLeft: gutter, marginTop: -9, marginBottom: 19, alignSelf: 'flex-start' },
  unavailable: { opacity: unavailableOpacity },
  pageTitle: { color: colors.text, fontSize: 37, letterSpacing: -1.65, fontWeight: '800' },
  pageHeader: { marginHorizontal: gutter, flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 12 },
  hero: { marginHorizontal: gutter, borderRadius: 26, overflow: 'hidden', justifyContent: 'flex-end' },
  heroCover: { position: 'absolute', top: 0, left: 0 },
  homeSection: { marginTop: 26 },
  statusFade: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 },
  librarySearch: { paddingHorizontal: gutter, paddingTop: 11 },
  filters: { paddingHorizontal: gutter, marginTop: 13, marginBottom: 10 },
  libraryBody: { paddingHorizontal: gutter },
  sortRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 43, marginBottom: 4 },
  songs: { marginHorizontal: -4 },
  more: { marginVertical: 20 },
  matchNote: { color: colors.quiet, fontSize: 13, textAlign: 'center', marginVertical: 18, marginHorizontal: 12 },
  searching: { paddingVertical: 48, alignItems: 'center' },
  searchHeader: { marginHorizontal: gutter, marginTop: 13, marginBottom: 25 },
  genres: { paddingHorizontal: gutter },
  resultSection: { marginBottom: 23 },
  topResult: { marginHorizontal: gutter },
  trackList: { marginHorizontal: gutter - 4 },
}));
