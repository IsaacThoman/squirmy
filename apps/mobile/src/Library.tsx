import { albumPresentation, librarySave, searchContext, searchFilters, searchItemKey, searchQueue, type SearchFilter, type SearchItem } from '@squirmy/client-core';
import { queryKeys, type AlbumSummary, type HomeSection, type LibraryItem, type TrackSummary } from '@squirmy/contracts';
import { useNavigation, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useSignedInApi, useWantlistEnabled } from './account/AccountProvider';
import { shade } from './data/color';
import {
  libraryMatchLimit, libraryMatchMinLength, useGenreCovers, useGenres, useHome, useLibraryAlbumIds, useLibraryAlbums, useLibraryArtists,
  useLibraryItems, useLibraryMatches, useLibraryTracks, usePlaylists,
} from './data/queries';
import { useLibraryActions, useLikeFailures } from './data/library';
import { useAvailability, useViewer } from './downloads/DownloadsProvider';
import {
  BrowseButton, CollectionGridRow, CollectionRow, GenreGrid, LibraryFilters, LibrarySort, SearchField,
  type RowAction, type SearchHandle,
} from './library/BrowseControls';
import { libraryRows, type LibraryRow } from './library/libraryRows';
import { libraryAlbumMatches } from './library/librarySearch';
import { searchFilterLabels } from './library/search';
import { useRecentSearches, useSearchList } from './library/useSearchList';
import { useBriefFailures } from './inlineFeedback';
import { playAllFailure, radioFailure } from './library/failures';
import { playbackStatus } from './player/usePlaybackStatus';
import { listSort, sortFor, sortOptions, sortsFor, type SortChoices } from './library/sorting';
import type { Page } from './library/links';
import { useAlbumPlayer, useCollectionActions } from './library/collectionActions';
import { underStatusBar, useRefreshControl } from './library/refresh';
import { scrollEdgeFade } from './edgeFade';
import { displayFontScale, isAccessibilitySize } from './fontScale';
import { ScrollEdge } from './ScrollEdge';
import {
  albumCollection, albumTypeLabels, artistCollection, CollectionCover, CollectionRail, EmptyState, FailureLine, gridColumns, gutter, largeTextScale, likedCollection, matches,
  OfflineBadge, playlistCollection, QueryState, SectionTitle, tapFeedback, useCollectionDim, type Collection,
} from './library/shared';
import { useRealtime } from './data/realtime';
import { SongList, useSongListItems } from './library/SongList';
import { usePlayAll } from './library/usePlayAll';
import type { SongRowItem } from './library/rows';
import { usePlaybackActions } from './playback';
import { createThemedStyles, useColors } from './theme';
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

function sectionSize(section: HomeSection) {
  switch (section.kind) {
    case 'albums': return section.albums.length;
    case 'artists': return section.artists.length;
    case 'tracks': return section.tracks.length;
    case 'playlists': return section.playlists.length;
  }
}

const homeSongLimit = 5;

function HomeRail({ section, link, onOpen, onTrackMenu }: { section: HomeSection } & Pick<BrowseProps, 'link' | 'onOpen' | 'onTrackMenu'>) {
  const styles = useStyles();
  const actions = usePlaybackActions();
  // A song row shows its first five; the rest are a page away, since Play plays them all.
  const seeAll = section.id === 'recently-played' ? () => onOpen(link('playlist', 'recent'))
    : section.kind === 'tracks' && section.tracks.length > homeSongLimit ? () => onOpen(link('songs', `home~${section.id}`)) : undefined;
  return <View style={styles.homeSection}>
    <SectionTitle title={section.title} onPress={seeAll} />
    {section.kind === 'albums' && <CollectionRail items={section.albums.map(album => albumCollection(album, link))}
      size={section.id === 'recently-added' ? 146 : 131} />}
    {section.kind === 'artists' && <CollectionRail items={section.artists.map(artist => artistCollection(artist, link))} size={110} />}
    {section.kind === 'playlists' && <CollectionRail items={section.playlists.map(playlist => playlistCollection(playlist, link))} />}
    {section.kind === 'tracks' && <View style={styles.trackList}>
      <SongList tracks={section.tracks.slice(0, homeSongLimit)} onTrackMenu={track => onTrackMenu(track)}
        onPlay={start => actions.playTracks(section.tracks, { start, context: { type: 'other', id: section.id, title: section.title } })} />
    </View>}
  </View>;
}

/**
 * Runs `onRetap` when this page's own tab is tapped while the page is on screen. A tap that
 * changes tabs, or that pops a page pushed over this one, does nothing here.
 */
function useTabRetap(onRetap: () => void) {
  const navigation = useNavigation();
  const tabs = useNavigation<{ addListener: (event: 'tabPress', listener: () => void) => () => void }>('/(tabs)');
  const latest = useRef(onRetap);
  latest.current = onRetap;
  useEffect(() => tabs.addListener('tabPress', () => {
    if (navigation.isFocused()) latest.current();
  }), [navigation, tabs]);
}

export function HomeScreen({ link, onOpen, onTrackMenu, onOpenDevices, onOpenAccount, bottomInset = 155 }: BrowseProps) {
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { state } = useAccount();
  const home = useHome();
  const wantlist = useWantlistEnabled();
  // A Home saved before the wantlist was switched off, or from an older server, may still have it.
  const sections = (home.data?.sections ?? []).filter(section => sectionSize(section) > 0 && (wantlist || section.id !== 'wantlist'));
  const serverName = state.status === 'signedIn' ? state.server.name : 'your server';
  const refreshControl = useRefreshControl(home.refetch, top);
  const statusBar = underStatusBar(top);
  const list = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Re-tapping Home goes back to its top, as the system's tabs do.
  useTabRetap(() => list.current?.scrollTo({ y: -statusBar.inset, animated: true }));

  return <View style={styles.page}>
    <ScrollView ref={list} contentInsetAdjustmentBehavior="never" refreshControl={refreshControl} {...statusBar.props}
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
      {sections.map(section => <HomeRail key={section.id} section={section} link={link} onOpen={onOpen} onTrackMenu={onTrackMenu} />)}
    </ScrollView>
    <ScrollEdge solid={top} fade={scrollEdgeFade} />
  </View>;
}

const filters = ['All', 'Playlists', 'Albums', 'Artists', 'Songs'] as const;
/** The soft edge where a list meets the title and chips pinned above it. */
const underChips = 12;
/** A tap on a song plays it and this many after it. */
const songsAfter = 300;
type LibraryFilter = (typeof filters)[number];
/** Rows drawn per batch, and screens' worth kept around the visible part. */
const libraryBatch = 12;
const libraryWindow = 7;

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
  const collectionActions = useCollectionActions();
  const { offline } = useRealtime();
  const { top } = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const actions = usePlaybackActions();
  const router = useRouter();
  const [filter, setFilter] = useState<LibraryFilter>('All');
  const list = useRef<FlatList<LibraryRow>>(null);
  useTabRetap(() => list.current?.scrollToOffset({ offset: 0, animated: true }));
  const [sortChoices, setSortChoices] = useState<SortChoices>({});
  const [grid, setGrid] = useState(true);
  const [showFilter, setShowFilter] = useState(false);
  const [query, setQuery] = useState('');
  const sorts = sortsFor(filter);
  const sortName = sortFor(filter, sortChoices);
  const sort = sortOptions[sortName];
  const columns = gridColumns(width, fontScale);
  const size = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);
  const showsPlaylists = filter === 'All' || filter === 'Playlists';
  const showsAlbums = filter === 'All' || filter === 'Albums';
  // Only the lists the filter shows are loaded. All is one list from the server: the albums,
  // artists, playlists and Liked Songs together, recently played first unless another order is chosen.
  const all = useLibraryItems(sort, filter === 'All');
  const albums = useLibraryAlbums(listSort(sort), filter === 'Albums');
  // The server lists artists by name whatever the order asked for.
  const artists = useLibraryArtists('title', filter === 'Artists');
  const songSort = listSort(sortOptions[sortFor('Songs', sortChoices)]);
  const songs = useLibraryTracks(songSort, filter === 'Songs');
  // A tap plays the song and the next few hundred, as on the web, not just the rows scrolled past.
  const playSongs = usePlayAll({
    list: songs, tracksOf: items => [...items], limit: start => start + songsAfter,
    fetchPage: (api, cursor, limit) => api.catalog.tracks({ sort: songSort, cursor, limit }),
  });
  // All's own list holds the playlists; it needs them here only while searching.
  const playlists = usePlaylists(filter === 'Playlists' || (filter === 'All' && [...query.trim()].length >= libraryMatchMinLength));
  // A filter of two characters or more searches the whole library on the server; a single
  // character only narrows what is already loaded.
  const searchText = filter === 'Playlists' ? '' : query;
  const libraryFound = useLibraryMatches(searchText);
  const searching = [...searchText.trim()].length >= libraryMatchMinLength;
  // The search finds albums with any file on the server; the Albums list's own membership
  // decides which of them are in the library (`libraryAlbumMatches`).
  const albumIds = useLibraryAlbumIds(searching && showsAlbums);
  // A list that could not be read cannot rule a match out.
  const membership = useMemo(() => albumIds.data ?? (albumIds.isError ? { ids: [], complete: false } : undefined), [albumIds.data, albumIds.isError]);
  const found = { ...libraryFound, pending: libraryFound.pending || (showsAlbums && albumIds.isPending && !albumIds.isError) };
  const matched = useMemo(() => libraryFound.data && { ...libraryFound.data, albums: libraryAlbumMatches(libraryFound.data.albums, membership) },
    [libraryFound.data, membership]);
  const listed = filter === 'All' ? all : filter === 'Artists' ? artists : filter === 'Songs' ? songs : filter === 'Playlists' ? playlists : albums;
  const active = searching ? found : listed;
  const loadMore = searching ? undefined : listed.loadMore;

  const artistItems = useMemo(() => (searching ? (matched?.artists ?? []).map(artist => artistCollection(artist, link))
    : artists.items.map(artist => artistCollection(artist, link)).filter(item => matches(query, item.title, item.subtitle))),
  [artists.items, link, matched, query, searching]);
  // Sorted by year, the year says why an album is where it is.
  const albumSubtitle = useCallback((album: AlbumSummary) => sort === 'year' && album.year ? `${album.artistCredit} · ${album.year}` : album.artistCredit, [sort]);
  const allItems = useMemo(() => all.items.map((item: LibraryItem) => {
    switch (item.kind) {
      case 'liked': return likedCollection(link);
      case 'playlist': return playlistCollection(item.playlist, link);
      case 'album': return albumCollection(item.album, link, albumSubtitle(item.album));
      case 'artist': return artistCollection(item.artist, link);
    }
  }), [albumSubtitle, all.items, link]);
  const items = useMemo(() => {
    // All, unsearched, is the server's list; one letter only narrows what is loaded.
    if (filter === 'All' && !searching) return allItems.filter(item => matches(query, item.title, item.subtitle)).map(collectionDim);
    const collections: Collection[] = [];
    if (showsPlaylists) {
      collections.push(...[likedCollection(link), ...playlists.items.map(playlist => playlistCollection(playlist, link))]
        .filter(item => matches(query, item.title, item.subtitle)));
    }
    if (showsAlbums) {
      collections.push(...searching ? (matched?.albums ?? []).map(album => albumCollection(album, link))
        : albums.items.map(album => albumCollection(album, link, albumSubtitle(album))).filter(item => matches(query, item.title, item.subtitle)));
    }
    // A search of All finds artists among the rest, as All lists them.
    if (filter === 'Artists' || filter === 'All') collections.push(...artistItems);
    return collections.map(collectionDim);
  }, [albumSubtitle, albums.items, allItems, artistItems, filter, link, matched, collectionDim, playlists.items, query, searching, showsAlbums, showsPlaylists]);
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
  // All, while searching, lists the songs found after the collections.
  const showsSongs = filter === 'Songs' || (filter === 'All' && searching);
  const empty = !items.length && !(showsSongs && tracks.length);
  // The invitation is for a library with nothing in it, on the views that list albums: under
  // Songs or Artists, saved songs or artists can be there without a single album. All always
  // lists Liked Songs, so it is empty when nothing else is.
  const libraryEmpty = !query && (filter === 'All'
    ? all.data && !all.hasNextPage && all.items.every(item => item.kind === 'liked')
    : filter === 'Albums' && albums.data && !albums.items.length);
  // Counted before albums outside the library are left out: the server stopped at the limit either way.
  const answered = libraryFound.data;
  const capped = searching && answered && (filter === 'Songs' ? answered.tracks.length : filter === 'Artists' ? answered.artists.length
    : Math.max(answered.albums.length, filter === 'All' ? Math.max(answered.tracks.length, answered.artists.length) : 0)) >= libraryMatchLimit;

  const mode = filter === 'Songs' ? 'songs' : grid ? 'grid' : 'list';
  const rows = useMemo(() => libraryRows({ mode, items, songs: showsSongs ? songItems.data : [], columns }),
    [columns, items, mode, showsSongs, songItems.data]);
  const renderSong = songItems.renderItem;
  const renderRow = useCallback(({ item: row }: { item: LibraryRow }) => {
    switch (row.kind) {
      case 'song': return <View style={styles.songs}>{renderSong({ item: row.song })}</View>;
      // The list is inset already; the title brings its own inset.
      case 'heading': return <View style={styles.songsHeading}><SectionTitle title={row.title} /></View>;
      case 'tiles': return <CollectionGridRow items={row.items.map(item => ({
        id: item.key, title: item.title, subtitle: item.subtitle, size,
        cover: <CollectionCover item={item} size={size} />, href: item.href, dim: item.dim, actions: collectionActions(item),
      }))} />;
      case 'row': return <CollectionRow title={row.item.title} subtitle={row.item.subtitle} size={50} dim={row.item.dim}
        cover={<CollectionCover item={row.item} size={50} radius={9} />} href={row.item.href} />;
    }
  }, [collectionActions, renderSong, size, styles]);
  // Searching, a pull reloads the matches and the playlists shown with them; otherwise the list.
  const refreshControl = useRefreshControl(() => Promise.all([
    active.refetch(), searching && showsPlaylists && playlists.refetch(),
  ]));

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
    {/* Rows scrolling up soften into the chips rather than being cut off under them. */}
    <View style={styles.flex}><ScrollEdge solid={0} fade={underChips} />
    <FlatList ref={list} key={mode} data={rows} renderItem={renderRow} keyExtractor={libraryRowKey}
      refreshControl={refreshControl}
      initialNumToRender={libraryBatch} maxToRenderPerBatch={libraryBatch} windowSize={libraryWindow}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      onEndReached={loadMore} onEndReachedThreshold={1.5}
      contentContainerStyle={[styles.libraryBody, styles.belowChips, { paddingBottom: bottomInset }]} showsVerticalScrollIndicator={false}
      ListHeaderComponent={<>
        <View style={styles.sortRow}>
          {/* Matches from the server come best first, whatever the sort. */}
          {filter === 'Playlists'
            ? !offline && <BrowseButton label="New playlist" title="New playlist" icon="plus" onPress={newPlaylist} />
            : !searching && sorts.length > 0 ? <LibrarySort options={sorts} value={sortName}
              onChange={name => setSortChoices(chosen => ({ ...chosen, [filter]: name }))} /> : <View />}
          {filter !== 'Songs' && <BrowseButton label={grid ? 'Show list view' : 'Show grid view'} icon={grid ? 'list.bullet' : 'square.grid.2x2'}
            onPress={() => { tapFeedback(); setGrid(!grid); }} />}
          {filter === 'Songs' && playSongs.busy && <ActivityIndicator accessibilityLabel="Loading songs" />}
        </View>
        {/* A tap on a song plays the next few hundred; when they can't be loaded it plays what was, and says so here. */}
        {filter === 'Songs' && playSongs.failed && <FailureLine message={playAllFailure} />}
        {!active.data && <QueryState query={active} what="your library" />}
        {libraryEmpty ? <EmptyState {...emptyLibrary.Albums} action={findMusic} />
          : active.data && empty && !(searching && found.pending) && (query || filter === 'Playlists'
            ? <EmptyState icon="magnifyingglass" title={query ? 'Nothing found' : 'Nothing here yet'}
              description={query ? 'Try another search or filter.' : 'Try another filter.'} />
            : <EmptyState {...emptyLibrary[filter === 'Songs' ? 'Songs' : filter === 'Artists' ? 'Artists' : 'Albums']} action={findMusic} />)}
      </>}
      ListFooterComponent={<>
        {(searching ? found.pending && !empty : listed.isFetchingNextPage) && <ActivityIndicator style={styles.more} />}
        {capped && <Text style={styles.matchNote}>Showing the best {libraryMatchLimit} matches. Type more to narrow them down.</Text>}
      </>} /></View>
  </View>;
}

type SearchRow =
  | { kind: 'song'; key: string; song: SongRowItem }
  | { kind: 'row'; key: string; item: Exclude<SearchItem, { type: 'track' }> }
  | { kind: 'heading'; key: string };

const searchRowKey = (row: SearchRow) => row.key;
const searchFilterOptions = searchFilters.map(filter => searchFilterLabels[filter]);
const filterOf = (label: string) => searchFilters.find(filter => searchFilterLabels[filter] === label) ?? 'all';
/** A song row's cover size (`TrackCover`), which other results match. */
const resultCover = 42;
const recentItems = 10;

/** A result as the row it is drawn with, for what is not a song. */
function resultCollection(item: Exclude<SearchItem, { type: 'track' }>, link: BrowseProps['link']): Collection {
  switch (item.type) {
    case 'artist': return artistCollection(item.artist, link);
    case 'album': return albumCollection(item.album, link, `${albumTypeLabels[item.album.type]} · ${item.album.artistCredit}`);
    case 'playlist': return playlistCollection(item.playlist, link);
  }
}

/**
 * Search: one list of results for what is typed, every kind mixed as the server ranks them,
 * with filters that narrow it to one kind and page further. A song plays with the songs
 * found after it; an artist, album or playlist opens, and a long press or its ellipsis
 * offers what can be done with it. Before anything is typed: recently viewed results and genres.
 */
export function SearchScreen({ link, onOpen, onTrackMenu, bottomInset = 155 }: BrowseProps) {
  const colors = useColors();
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SearchFilter>('all');
  const searchInput = useRef<SearchHandle>(null);
  const list = useSearchList(query, filter);
  const recents = useRecentSearches();
  const genres = useGenres();
  // One genre a row at accessibility text sizes, so its name fits on the tile.
  const genreColumns = fontScale >= largeTextScale ? 1 : 2;
  // At accessibility sizes the history's Clear button goes under its heading, so each word of it keeps a whole line.
  const stackHeading = isAccessibilitySize(fontScale);
  const genreWidth = Math.floor((width - gutter * 2 - 12 * (genreColumns - 1)) / genreColumns);
  const { offline } = useRealtime();
  const actions = usePlaybackActions();
  const { canPlay } = useAvailability();
  const albumPlayer = useAlbumPlayer();
  const api = useSignedInApi();
  const viewer = useViewer();
  const { setLiked } = useLibraryActions();
  const likeFailures = useLikeFailures();
  // An artist's radio that didn't start: its menu entry says so for a few seconds, and choosing it tries again.
  const radioFailures = useBriefFailures<true>();

  useTabRetap(() => searchInput.current?.focus());

  // The server answers nothing under two characters; keep what was searched before until a search can find something.
  const term = query.trim();
  const active = [...term].length >= 2;
  const viewed = useMemo(() => recents.list.slice(0, recentItems), [recents.list]);
  const shown: readonly SearchItem[] = active ? list.items ?? [] : viewed;

  const tracks = useMemo(() => shown.flatMap(item => (item.type === 'track' ? [item.track] : [])), [shown]);
  const songItems = useSongListItems({
    tracks, kind: 'Song', onTrackMenu: track => onTrackMenu(track),
    onPlay: index => {
      const track = tracks[index]!;
      recents.add({ type: 'track', track });
      // The song, then the songs found after it, so playing on continues through the results.
      const queue = active ? searchQueue(shown, track, canPlay) : { tracks: [track], start: 0 };
      actions.playTracks(queue.tracks, { start: queue.start, context: searchContext(active ? term : '') });
    },
  });

  /** The heart's entry, worded by client-core's rule; nothing when an older server did not say. */
  const saveAction = (type: 'album' | 'artist', id: string, name: string, liked: boolean | undefined): RowAction[] => {
    if (liked === undefined) return [];
    const { saved, label } = librarySave({ liked });
    // A refused change was set back; the entry that makes it again says so (as the track menu does).
    const failed = likeFailures.has(`${type}:${id}`);
    return [{
      title: failed ? `Couldn’t ${saved ? 'remove from' : 'save to'} library. Try again` : label,
      icon: failed ? 'exclamationmark.circle' : saved ? 'heart.slash' : 'heart',
      onPress: () => { tapFeedback(); setLiked(type, id, !saved, name); },
    }];
  };
  const menuFor = (item: Exclude<SearchItem, { type: 'track' }>): RowAction[] => {
    if (offline) return [];
    if (item.type === 'album') {
      const plays = albumPresentation(item.album, viewer) === 'normal';
      return [
        ...(plays ? [
          { title: 'Play', icon: 'play', onPress: () => { tapFeedback(); albumPlayer.play(item.album.id); } },
          { title: 'Shuffle', icon: 'shuffle', onPress: () => { tapFeedback(); albumPlayer.play(item.album.id, true); } },
        ] : []),
        ...saveAction('album', item.album.id, item.album.title, item.album.liked),
        ...item.album.artists.map(artist => ({ title: item.album.artists.length > 1 ? `Go to ${artist.name}` : 'Go to artist', icon: 'music.mic', onPress: () => onOpen(link('artist', artist.id)) })),
      ];
    }
    if (item.type === 'artist') {
      const radioFailed = radioFailures.failures.has(item.artist.id);
      return [{
        title: radioFailed ? radioFailure : 'Start radio', icon: radioFailed ? 'exclamationmark.circle' : 'dot.radiowaves.left.and.right', onPress: () => {
          tapFeedback();
          radioFailures.drop(item.artist.id);
          api?.radio.artist(item.artist.id).then(actions.playRadio, () => {
            radioFailures.fail(item.artist.id, true);
            // The menu has closed, so the player says it too (and VoiceOver hears it from there).
            playbackStatus.report({ message: `Couldn’t start a radio for ${item.artist.name}` });
          });
        },
      }, ...saveAction('artist', item.artist.id, item.artist.name, item.artist.liked)];
    }
    return [{ title: 'Open', icon: 'music.note.list', onPress: () => onOpen(link('playlist', item.playlist.id)) }];
  };

  const rows = useMemo((): SearchRow[] => {
    const songs = new Map(songItems.data.map(song => [song.track.id, song]));
    const results = shown.map((item): SearchRow => (item.type === 'track'
      ? { kind: 'song', key: searchItemKey(item), song: songs.get(item.track.id)! }
      : { kind: 'row', key: searchItemKey(item), item }));
    if (active || !results.length) return results;
    return [{ kind: 'heading', key: 'h:viewed' }, ...results];
  }, [active, shown, songItems.data]);

  const collectionDim = useCollectionDim();
  const renderSong = songItems.renderItem;
  const renderRow = ({ item: row }: { item: SearchRow }) => {
    switch (row.kind) {
      case 'song': return <View style={styles.songs}>{renderSong({ item: row.song })}</View>;
      case 'row': {
        const item = collectionDim(resultCollection(row.item, link));
        // The size of a song row's cover, so titles line up down the mixed list.
        return <CollectionRow title={item.title} subtitle={item.subtitle} size={resultCover} dim={item.dim} href={item.href}
          cover={<CollectionCover item={item} size={resultCover} radius={item.round ? resultCover / 2 : 8} />}
          onSelect={() => { tapFeedback(); recents.add(row.item); }} actions={menuFor(row.item)} />;
      }
      case 'heading': return <View style={[styles.recentHeading, stackHeading && styles.recentHeadingStacked]}>
        <Text accessibilityRole="header" style={[styles.recentTitle, !stackHeading && styles.flex]}>Recently viewed</Text>
        <BrowseButton label="Clear all recently viewed" title="Clear all" onPress={() => { tapFeedback(); recents.clear(); }} />
      </View>;
    }
  };

  const genreNames = (genres.data ?? []).slice(0, 6).map(genre => genre.name);
  const genreCovers = useGenreCovers(genreNames);
  const queryClient = useQueryClient();
  const refreshControl = useRefreshControl(() => active
    ? list.refetch()
    : Promise.all([genres.refetch(), queryClient.refetchQueries({ queryKey: [...queryKeys.libraryAlbums(), 'genre'], type: 'active' })]));

  const empty = active && list.items !== null && !list.items.length && !list.pending && !list.stale;
  const header = active ? <>
    {offline ? <EmptyState icon="wifi.slash" title="You’re offline" description="Search needs your server. Your downloads are in your Library." />
      : list.failed ? <EmptyState icon="wifi.exclamationmark" title="Search isn’t available" description="Check your connection to the server."
        action={{ title: 'Try again', onPress: () => { tapFeedback(); void list.refetch(); } }} />
        : list.items === null ? <View style={styles.searching}><ActivityIndicator color={colors.muted} accessibilityLabel="Searching" /></View>
          : empty ? <EmptyState icon="magnifyingglass" title="No results"
            description={filter === 'all' ? 'Try a different song, album, or artist.' : 'Try All, or another spelling.'} />
            : list.catalogFailed && <Text style={styles.matchNote}>Only music on your server is listed: the catalog couldn’t be searched.</Text>}
  </> : undefined;
  const footer = active ? (list.pending && list.items?.length ? <ActivityIndicator style={styles.more} color={colors.muted} /> : undefined)
    // Without genres or recently viewed results, the page still says what it is for rather than stand empty.
    : genreNames.length === 0 ? rows.length ? undefined : genres.data
      ? <EmptyState icon="magnifyingglass" title="Search your music" description="Find songs, albums, artists and playlists by name." />
      : <QueryState query={genres} what="genres" />
    : <View style={styles.searchGenres}>
      <SectionTitle title="Browse by genre" />
      <View style={styles.genres}>
        <GenreGrid columns={genreColumns} items={genreNames.map((name, index) => {
          const artwork = genreCovers[index]?.artwork;
          return {
            id: name, title: name, width: genreWidth, color: shade(artwork?.color),
            cover: <Cover artwork={artwork} size={85} radius={8} />, onPress: () => onOpen(link('genre', name)),
          };
        })} />
      </View>
    </View>;

  return <View style={[styles.page, { paddingTop: top + 12 }]}>
    <View style={styles.pageHeader}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={[styles.pageTitle, styles.flex]}>Search</Text>
      {active && list.pending && !offline && <ActivityIndicator color={colors.muted} />}
      <OfflineBadge />
    </View>
    <View style={[styles.searchHeader, active && styles.searchHeaderOverChips]}><SearchField inputRef={searchInput} value={query} onChange={setQuery} placeholder="Songs, albums, artists, playlists" /></View>
    {/* Fixed above the list, as the Library's are, so a filter is a tap away however far down the results go. */}
    {active && <View style={styles.searchFilters}>
      <LibraryFilters options={searchFilterOptions} value={searchFilterLabels[filter]} onChange={label => { tapFeedback(); setFilter(filterOf(label)); }} />
    </View>}
    <View style={styles.flex}><ScrollEdge solid={0} fade={underChips} />
    <FlatList data={offline && active ? [] : rows} renderItem={renderRow} keyExtractor={searchRowKey}
      refreshControl={refreshControl} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      onEndReached={active ? list.loadMore : undefined} onEndReachedThreshold={1.5}
      style={list.stale && styles.stale}
      contentContainerStyle={[styles.searchBody, active ? styles.belowSearchChips : styles.belowSearchField, { paddingBottom: bottomInset }]}
      showsVerticalScrollIndicator={false} ListHeaderComponent={header} ListFooterComponent={footer} /></View>
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  homeHeader: { marginBottom: 19 },
  homeOffline: { marginLeft: gutter, marginTop: -9, marginBottom: 19, alignSelf: 'flex-start' },
  pageTitle: { color: colors.text, fontSize: 37, letterSpacing: -1.65, fontWeight: '800' },
  pageHeader: { marginHorizontal: gutter, flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 12 },
  homeSection: { marginTop: 26 },
  librarySearch: { paddingHorizontal: gutter, paddingTop: 11 },
  filters: { paddingHorizontal: gutter, marginTop: 13 },
  // The space under the pinned header is the list's own, so its soft edge lies over nothing at rest.
  belowChips: { paddingTop: 10 },
  belowSearchChips: { paddingTop: 8 },
  belowSearchField: { paddingTop: 12 },
  libraryBody: { paddingHorizontal: gutter },
  sortRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 43, marginBottom: 4 },
  songs: { marginHorizontal: -4 },
  songsHeading: { marginHorizontal: -gutter, marginTop: 18 },
  more: { marginVertical: 20 },
  matchNote: { color: colors.quiet, fontSize: 13, textAlign: 'center', marginVertical: 18, marginHorizontal: 12 },
  searching: { paddingVertical: 48, alignItems: 'center' },
  searchHeader: { marginHorizontal: gutter, marginTop: 13 },
  searchHeaderOverChips: { marginBottom: 12 },
  searchFilters: { marginHorizontal: gutter },
  searchBody: { paddingHorizontal: gutter },
  searchGenres: { marginTop: 22, marginHorizontal: -gutter },
  genres: { paddingHorizontal: gutter },
  stale: { opacity: 0.6 },
  trackList: { marginHorizontal: gutter - 4 },
  recentHeading: { flexDirection: 'row', alignItems: 'center', minHeight: 44, marginTop: 6 },
  recentHeadingStacked: { flexDirection: 'column', alignItems: 'flex-start' },
  recentTitle: { color: colors.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
}));
