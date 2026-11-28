import { albumPresentation, canFetch, librarySave, searchContext, searchFilters, searchItemKey, type SearchFilter, type SearchItem } from '@squirmy/client-core';
import { type AlbumSummary, type HomeSection, type LibraryItem, type TrackSummary } from '@squirmy/contracts';
import { useNavigation, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedRef, useScrollOffset } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccount, useSignedInApi, useWantlistEnabled } from './account/AccountProvider';
import { shade } from './data/color';
import {
  libraryMatchLimit, libraryMatchMinLength, useAllPlaylists, useGenreCovers, useGenres, useHome, useLibraryAlbumIds,
  useLibraryItems, useLibraryMatches, useServerAlbums,
} from './data/queries';
import { useLibraryActions, useLikeFailures } from './data/library';
import { useViewer } from './downloads/DownloadsProvider';
import {
  BrowseButton, CollectionGridRow, CollectionRow, GenreGrid, LibraryFilters, LibrarySort, SearchField,
  type RowAction, type SearchHandle,
} from './library/BrowseControls';
import { libraryRows, type LibraryRow } from './library/libraryRows';
import { emptyLibrary, emptyServer, listsNothing } from './library/libraryEmpty';
import { shownMatches } from './library/librarySearch';
import { searchEnd, searchFilterLabels, searchNotice } from './library/search';
import { useRecentSearches, useSearchList } from './library/useSearchList';
import { useBriefFailures } from './inlineFeedback';
import { radioFailure } from './library/failures';
import { radioStartingNotice } from './library/trackActionList';
import { playbackStatus } from './player/usePlaybackStatus';
import { defaultSort, serverDefaultSort, serverSort, serverSortNames, sortNames, sortOptions, type ServerSortName, type SortName } from './library/sorting';
import { serverMusicHref, type Page } from './library/links';
import { BrowseBackButton } from './library/AlbumButtons';
import { albumPlaylistSheet, useAlbumPlayer, useCollectionActions } from './library/collectionActions';
import { albumActions } from './library/albumActions';
import { scrollEdgeFade } from './edgeFade';
import { displayFontScale, isAccessibilitySize } from './fontScale';
import { ScrollEdge } from './ScrollEdge';
import {
  albumCollection, albumTypeLabels, artistCollection, CollectionCover, CollectionRail, EmptyState, gridColumns, gutter, largeTextScale, likedCollection, matches,
  homeItemCollection, OfflineBadge, playlistCollection, QueryState, SectionTitle, tapFeedback, useCollectionDim, type Collection,
} from './library/shared';
import { useRealtime, useScanProgress } from './data/realtime';
import { homeEmpty } from './library/homeEmpty';
import { SongList, useSongListItems } from './library/SongList';
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
  /** A page pushed over the tab's own: its back button. */
  onBack?: () => void;
  bottomInset?: number;
};

function sectionSize(section: HomeSection) {
  switch (section.kind) {
    case 'albums': return section.albums.length;
    case 'artists': return section.artists.length;
    case 'tracks': return section.tracks.length;
    case 'playlists': return section.playlists.length;
    case 'items': return section.items.length;
    // A kind from a newer server than this app shows nothing.
    default: return 0;
  }
}

const homeSongLimit = 5;

function HomeRail({ section, link, onOpen, onTrackMenu }: { section: HomeSection } & Pick<BrowseProps, 'link' | 'onOpen' | 'onTrackMenu'>) {
  const styles = useStyles();
  const actions = usePlaybackActions();
  // A song row shows its first five; the rest are a page away, since Play plays them all.
  // New on this server (`recently-added`) is the server's music, all of it On this server.
  const seeAll = section.id === 'recently-played' ? () => onOpen(link('playlist', 'recent'))
    : section.id === 'recently-added' ? () => { tapFeedback(); onOpen(serverMusicHref('home')); }
      : section.kind === 'tracks' && section.tracks.length > homeSongLimit ? () => onOpen(link('songs', `home~${section.id}`)) : undefined;
  return <View style={styles.homeSection}>
    <SectionTitle title={section.title} onPress={seeAll} />
    {section.kind === 'albums' && <CollectionRail items={section.albums.map(album => albumCollection(album, link))}
      size={section.id === 'recently-added' ? 146 : 131} />}
    {section.kind === 'artists' && <CollectionRail items={section.artists.map(artist => artistCollection(artist, link))} size={110} />}
    {section.kind === 'playlists' && <CollectionRail items={section.playlists.map(playlist => playlistCollection(playlist, link))} />}
    {section.kind === 'items' && <CollectionRail items={section.items.flatMap(item => homeItemCollection(item, link) ?? [])} />}
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
  const contentGap = 12;
  const { state } = useAccount();
  const home = useHome();
  const wantlist = useWantlistEnabled();
  // A Home saved before the wantlist was switched off, or from an older server, may still have it.
  const sections = (home.data?.sections ?? []).filter(section => sectionSize(section) > 0 && (wantlist || section.id !== 'wantlist'));
  const viewer = useViewer();
  const router = useRouter();
  const scan = useScanProgress();
  const empty = homeEmpty({ canFindMusic: canFetch(viewer), isAdmin: state.status === 'signedIn' && state.user.role === 'admin', scan });
  const list = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useScrollOffset(list);
  // Re-tapping Home goes back to its top, as the system's tabs do.
  useTabRetap(() => list.current?.scrollTo({ y: 0, animated: true }));

  return <View style={styles.page}>
    <Animated.ScrollView ref={list} contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingTop: top + contentGap, paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
      <View style={[styles.pageHeader, styles.homeHeader]}>
        <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={[styles.pageTitle, styles.flex]}>Listen now</Text>
        {onOpenDevices && <BrowseButton label="Playback devices" icon="laptopcomputer.and.iphone" glass onPress={onOpenDevices} />}
        {onOpenAccount && <BrowseButton label="Account" icon="person.crop.circle" glass onPress={onOpenAccount} />}
      </View>
      <OfflineBadge style={styles.homeOffline} />
      {!home.data && <QueryState query={home} what="your music" />}
      {home.data && !sections.length && <EmptyState icon={empty.icon} title={empty.title} description={empty.description}
        action={empty.findMusic ? { title: 'Find music', onPress: () => { tapFeedback(); router.navigate('/(tabs)/(search)'); } } : undefined} />}
      {sections.map(section => <HomeRail key={section.id} section={section} link={link} onOpen={onOpen} onTrackMenu={onTrackMenu} />)}
    </Animated.ScrollView>
    <ScrollEdge solid={top} fade={scrollEdgeFade} scrollOffset={scrollOffset} contentGap={contentGap} />
  </View>;
}

/** The soft edge where Search results meet the controls pinned above them. */
const underChips = 12;
/** Rows drawn per batch, and screens' worth kept around the visible part. */
const libraryBatch = 12;
const libraryWindow = 7;

const libraryRowKey = (row: LibraryRow) => row.key;

/** The space a pushed page keeps over its title for the floating back button (`albumNavSize` on the other pages). */
const backButtonSpace = 8 + 44;

/**
 * The Library: the user's albums, artists, playlists and Liked Songs. With `server`, On this
 * server (Home's See all): the server's albums, whatever is in the library, with the same
 * grid or list, sorts (but Recently played) and search, and no pins or playlists, as web's.
 */
export function LibraryScreen({ link, onTrackMenu, onOpen, onOpenDownloads, onBack, server = false, bottomInset = 155 }: BrowseProps & { server?: boolean }) {
  const styles = useStyles();
  const collectionDim = useCollectionDim();
  const collectionActions = useCollectionActions();
  const { offline } = useRealtime();
  const { top } = useSafeAreaInsets();
  const contentGap = 12;
  const { width, fontScale } = useWindowDimensions();
  const actions = usePlaybackActions();
  const router = useRouter();
  const list = useAnimatedRef<Animated.FlatList<LibraryRow>>();
  const scrollOffset = useScrollOffset(list);
  useTabRetap(() => list.current?.scrollToOffset({ offset: 0, animated: true }));
  const [sortName, setSortName] = useState<SortName>(server ? serverDefaultSort : defaultSort);
  const [grid, setGrid] = useState(true);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const sort = sortOptions[sortName];
  const columns = gridColumns(width, fontScale);
  const size = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);
  const libraryItems = useLibraryItems(sort, !server);
  const serverAlbums = useServerAlbums(server && sort !== 'played' ? sort : serverSort(serverDefaultSort), server);
  const library = server ? serverAlbums : libraryItems;
  // A single character narrows what is loaded. Longer queries search the server's library.
  const searching = [...query.trim()].length >= libraryMatchMinLength;
  const libraryFound = useLibraryMatches(query);
  // Every playlist, so one far down the list is found too.
  const playlists = useAllPlaylists(searching && !server);
  // The search finds albums with any file on the server; the Albums list's own membership
  // decides which of them are in the library (`libraryAlbumMatches`). On this server keeps them all.
  const albumIds = useLibraryAlbumIds(searching && !server);
  // A list that could not be read cannot rule a match out.
  const membership = useMemo(() => albumIds.data ?? (albumIds.isError ? { ids: [], complete: false } : undefined), [albumIds.data, albumIds.isError]);
  const pending = libraryFound.pending || (!server && albumIds.isPending && !albumIds.isError);
  const matched = useMemo(() => libraryFound.data && shownMatches(libraryFound.data, server ? 'server' : 'library', membership),
    [libraryFound.data, membership, server]);
  const active = searching ? libraryFound : library;

  // Sorted by year, the year says why an album is where it is.
  const albumSubtitle = useCallback((album: AlbumSummary) => sort === 'year' && album.year ? `${album.artistCredit} · ${album.year}` : album.artistCredit, [sort]);
  // The server lists the pins first; whether each item is pinned is known here, not in a search.
  // The server's albums have no pins: `pinned` stays unknown, so their menus offer none.
  const allItems = useMemo(() => server ? serverAlbums.items.map(album => albumCollection(album, link, albumSubtitle(album)))
    : libraryItems.items.map((item: LibraryItem): Collection => {
      const pinned = { pinned: item.pinned };
      switch (item.kind) {
        case 'liked': return { ...likedCollection(link), ...pinned };
        case 'playlist': return { ...playlistCollection(item.playlist, link), ...pinned };
        case 'album': return { ...albumCollection(item.album, link, albumSubtitle(item.album)), ...pinned };
        case 'artist': return { ...artistCollection(item.artist, link), ...pinned };
      }
    }), [albumSubtitle, libraryItems.items, link, server, serverAlbums.items]);
  const items = useMemo(() => {
    if (!searching) return allItems.filter(item => matches(query, item.title, item.subtitle)).map(collectionDim);
    const matchingPlaylists = server ? [] : [likedCollection(link), ...playlists.items.map(playlist => playlistCollection(playlist, link))]
      .filter(item => matches(query, item.title, item.subtitle));
    return [
      ...matchingPlaylists,
      ...(matched?.albums ?? []).map(album => albumCollection(album, link)),
      ...(matched?.artists ?? []).map(artist => artistCollection(artist, link)),
    ].map(collectionDim);
  }, [allItems, link, matched, collectionDim, playlists.items, query, searching, server]);
  const tracks = useMemo(() => searching ? matched?.tracks ?? [] : [], [matched, searching]);
  const songItems = useSongListItems({
    tracks, onTrackMenu: track => onTrackMenu(track),
    onPlay: start => actions.playTracks(tracks, { start, context: { type: 'other', id: null, title: 'Songs' } }),
  });
  const empty = !items.length && !tracks.length;
  const libraryEmpty = !query && library.data && !library.hasNextPage
    && listsNothing(server ? { server, items: serverAlbums.items } : { server, items: libraryItems.items });
  // Counted before what is outside the library is left out: the server stopped at the limit either way.
  const answered = libraryFound.data;
  const capped = searching && answered && Math.max(answered.albums.length, answered.tracks.length, answered.artists.length) >= libraryMatchLimit;

  const rows = useMemo(() => libraryRows({ mode: grid ? 'grid' : 'list', items, songs: songItems.data, columns }),
    [columns, items, grid, songItems.data]);
  const renderSong = songItems.renderItem;
  const renderRow = useCallback(({ item: row }: { item: LibraryRow }) => {
    switch (row.kind) {
      case 'song': return <View style={styles.songs}>{renderSong({ item: row.song })}</View>;
      // The list is inset already; the title brings its own inset.
      case 'heading': return <View style={styles.songsHeading}><SectionTitle title={row.title} /></View>;
      case 'tiles': return <CollectionGridRow items={row.items.map(item => ({
        id: item.key, title: item.title, subtitle: item.subtitle, size,
        cover: <CollectionCover item={item} size={size} />, href: item.href, dim: item.dim, pinned: item.pinned, actions: collectionActions(item),
      }))} />;
      case 'row': return <CollectionRow title={row.item.title} subtitle={row.item.subtitle} size={50} dim={row.item.dim} pinned={row.item.pinned}
        cover={<CollectionCover item={row.item} size={50} radius={9} />} href={row.item.href} actions={collectionActions(row.item)} />;
    }
  }, [collectionActions, renderSong, size, styles]);
  // An empty library is an invitation: the server's music is a page away, and Search finds the rest.
  const emptyActions = [
    { title: 'Browse this server', onPress: () => { tapFeedback(); onOpen(serverMusicHref('library')); } },
    { title: 'Find music', onPress: () => { tapFeedback(); router.navigate('/(tabs)/(search)'); } },
  ];
  const title = server ? 'On this server' : 'Library';
  // A pushed page keeps the top for its floating back button, as the other pages do.
  const contentTop = top + (onBack ? backButtonSpace : contentGap);

  const newPlaylist = () => {
    tapFeedback();
    onOpen({ pathname: '/name-playlist', params: { mode: 'create' } });
  };

  return <View style={styles.page}>
    <Animated.FlatList ref={list} data={rows} renderItem={renderRow} keyExtractor={libraryRowKey}
      initialNumToRender={libraryBatch} maxToRenderPerBatch={libraryBatch} windowSize={libraryWindow}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      onEndReached={searching ? undefined : library.loadMore} onEndReachedThreshold={1.5}
      contentInsetAdjustmentBehavior="never" showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.libraryBody, { paddingTop: contentTop, paddingBottom: bottomInset }]}
      ListHeaderComponent={<>
        <View style={[styles.pageHeader, styles.libraryHeader]}>
          <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={[styles.pageTitle, styles.flex]}>{title}</Text>
          <OfflineBadge />
          {onOpenDownloads && !server && <BrowseButton glass icon="arrow.down.circle" label="Downloads" onPress={() => { tapFeedback(); onOpenDownloads(); }} />}
          <BrowseButton glass icon={showSearch ? 'xmark' : 'magnifyingglass'}
            label={showSearch ? `Close ${server ? 'search of this server' : 'library search'}` : server ? 'Search this server' : 'Search library'} onPress={() => {
            tapFeedback();
            if (showSearch) setQuery('');
            setShowSearch(!showSearch);
          }} />
        </View>
        {showSearch && <View style={styles.librarySearch}>
          <SearchField value={query} onChange={setQuery} placeholder={server ? 'Find on this server' : 'Find in your library'} autoFocus />
        </View>}
        <View style={styles.sortRow}>
          {/* Matches from the server come best first, whatever the sort. */}
          {!searching && (server
            ? <LibrarySort<ServerSortName> options={serverSortNames} value={sortName === 'Recently played' ? serverDefaultSort : sortName} onChange={setSortName} />
            : <LibrarySort options={sortNames} value={sortName} onChange={setSortName} />)}
          <View style={styles.libraryActions}>
            {!offline && !server && <BrowseButton label="New playlist" icon="plus" onPress={newPlaylist} />}
            <BrowseButton label={grid ? 'Show list view' : 'Show grid view'} icon={grid ? 'list.bullet' : 'square.grid.2x2'}
              onPress={() => { tapFeedback(); setGrid(!grid); }} />
          </View>
        </View>
        {!active.data && <QueryState query={active} what={server ? 'this server’s music' : 'your library'} />}
        {libraryEmpty && (server ? <EmptyState {...emptyServer} /> : <EmptyState {...emptyLibrary} actions={emptyActions} />)}
        {query && active.data && empty && !(searching && pending) && <EmptyState icon="magnifyingglass" title="Nothing found"
          description="Try another search." />}
      </>}
      ListFooterComponent={<>
        {(searching ? pending && !empty : library.isFetchingNextPage) && <ActivityIndicator style={styles.more} />}
        {capped && <Text style={styles.matchNote}>Showing the best {libraryMatchLimit} matches. Type more to narrow them down.</Text>}
      </>} />
    <ScrollEdge solid={top} fade={scrollEdgeFade} scrollOffset={scrollOffset} contentGap={contentTop - top} />
    {onBack && <View pointerEvents="box-none" style={[styles.nav, { top: top + 8 }]}><BrowseBackButton onPress={onBack} /></View>}
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

/**
 * A part of the results that could not be had, said where it is missing (above the rows, or at
 * their end), with Try again; a spinner in its place while it is asked again.
 */
function RetryNote({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.retryNote}>
    <Text style={styles.retryNoteText}>{message}</Text>
    {retrying ? <ActivityIndicator style={styles.retryBusy} color={colors.muted} accessibilityLabel="Trying again" />
      : <BrowseButton label="Try again" title="Try again" onPress={() => { tapFeedback(); onRetry(); }} />}
  </View>;
}

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
    // As on the web, a song that can't play opens its album, where there may be more to say or want.
    onUnavailable: index => {
      const track = tracks[index]!;
      if (!track.album) return;
      recents.add({ type: 'track', track });
      onOpen(link('album', track.album.id));
    },
    onPlay: index => {
      const track = tracks[index]!;
      recents.add({ type: 'track', track });
      // The song on its own: when it ends, autoplay goes on with music like it, not the rest of what was found.
      actions.playTracks([track], { start: 0, context: searchContext(active ? term : '') });
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
      const { album } = item;
      // The album's own menu (`albumActions`), with the heart when the server said whether it is saved.
      return albumActions({
        plays: albumPresentation(album, viewer) === 'normal', offline, artists: album.artists,
        saved: album.liked === undefined ? undefined : { liked: album.liked, failed: likeFailures.has(`album:${album.id}`) },
      }, {
        play: shuffle => { tapFeedback(); albumPlayer.play(album.id, shuffle); },
        enqueue: placement => albumPlayer.enqueue(album.id, album.title, placement),
        addToPlaylist: () => onOpen(albumPlaylistSheet(album.id)),
        setSaved: saved => { tapFeedback(); setLiked('album', album.id, saved, album.title); },
        goToArtist: index => onOpen(link('artist', album.artists[index]!.id)),
      });
    }
    if (item.type === 'artist') {
      const radioFailed = radioFailures.failures.has(item.artist.id);
      return [{
        title: radioFailed ? radioFailure : 'Start radio', icon: radioFailed ? 'exclamationmark.circle' : 'dot.radiowaves.left.and.right', onPress: () => {
          tapFeedback();
          radioFailures.drop(item.artist.id);
          if (!api) return;
          // The menu has closed, so the player says the radio is on its way, and that it failed
          // if it does (VoiceOver hears both from there).
          const starting = playbackStatus.report(radioStartingNotice);
          api.radio.artist(item.artist.id).then(radio => {
            playbackStatus.withdraw(starting);
            actions.playRadio(radio);
          }, () => {
            radioFailures.fail(item.artist.id, true);
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
  // An earlier search's results stay, faded, while this one's load, but are not there to be
  // played or opened (as on web): their touches go to the list, which still scrolls.
  const renderRow = (info: { item: SearchRow }) => list.stale && info.item.kind !== 'heading'
    ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{renderResult(info)}</View>
    : renderResult(info);
  const renderResult = ({ item: row }: { item: SearchRow }) => {
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

  const retry = () => void list.refetch();
  const notice = active ? searchNotice(list, offline) : null;
  const end = active ? searchEnd(list) : null;
  const header = active ? <>
    {notice === 'offline' ? <EmptyState icon="wifi.slash" title="You’re offline" description="Search needs your server. Your downloads are in your Library." />
      : notice === 'failed' ? <EmptyState icon="wifi.exclamationmark" title="Search isn’t available" description="Check your connection to the server."
        action={{ title: 'Try again', onPress: () => { tapFeedback(); retry(); } }} />
        : notice === 'searching' ? <View style={styles.searching}><ActivityIndicator color={colors.muted} accessibilityLabel="Searching" /></View>
          : notice === 'catalogEmpty' ? <EmptyState icon="wifi.exclamationmark" title="Couldn’t search the catalog"
            description={`Nothing on your server matches “${term}”.`}
            action={{ title: 'Try again', busy: list.retrying, onPress: () => { tapFeedback(); retry(); } }} />
            : notice === 'noResults' ? <EmptyState icon="magnifyingglass" title="No results"
              description={filter === 'all' ? 'Try a different song, album, or artist.' : 'Try All, or another spelling.'} />
              : notice === 'catalogNote' && <RetryNote message="Couldn’t search the catalog. Only music on your server is listed."
                retrying={Boolean(list.retrying)} onRetry={retry} />}
  </> : undefined;
  const footer = active ? (end === 'moreFailed' ? <RetryNote message="More results didn’t load." retrying={false} onRetry={list.retryMore!} />
    : end === 'loading' ? <ActivityIndicator style={styles.more} color={colors.muted} /> : undefined)
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
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      onEndReached={active ? list.loadMore : undefined} onEndReachedThreshold={1.5}
      extraData={list.stale} style={list.stale && styles.stale}
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
  nav: { position: 'absolute', left: 0, right: 0, zIndex: 2, flexDirection: 'row', alignItems: 'center', paddingHorizontal: gutter },
  homeSection: { marginTop: 26 },
  libraryHeader: { marginHorizontal: 0, marginBottom: 10 },
  librarySearch: { paddingBottom: 8 },
  filters: { paddingHorizontal: gutter, marginTop: 13 },
  // The space under the pinned header is the list's own, so its soft edge lies over nothing at rest.
  belowSearchChips: { paddingTop: 8 },
  belowSearchField: { paddingTop: 12 },
  libraryBody: { paddingHorizontal: gutter },
  sortRow: { flexDirection: 'row', alignItems: 'center', minHeight: 43, marginBottom: 4 },
  libraryActions: { flexDirection: 'row', marginLeft: 'auto' },
  songs: { marginHorizontal: -4 },
  songsHeading: { marginHorizontal: -gutter, marginTop: 18 },
  more: { marginVertical: 20 },
  matchNote: { color: colors.quiet, fontSize: 13, textAlign: 'center', marginVertical: 18, marginHorizontal: 12 },
  retryNote: { alignItems: 'center', gap: 2, marginVertical: 12, marginHorizontal: 12 },
  retryNoteText: { color: colors.muted, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  retryBusy: { width: 44, height: 44 },
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
