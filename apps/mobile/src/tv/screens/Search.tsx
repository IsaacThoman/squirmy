import { librarySave, searchContext, searchFilters, type SearchFilter, type SearchItem } from '@squirmy/client-core';
import type { AlbumSummary, ArtistSummary, PlaylistSummary, TrackSummary } from '@squirmy/contracts';
import { LinearGradient } from 'expo-linear-gradient';
import { memo, useCallback, useMemo, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { nativeTVSearch } from '../../../modules/tv-search';
import { useSignedInApi } from '../../account/AccountProvider';
import { shade } from '../../data/color';
import { useLibraryActions, useLiked, useLikeFailure } from '../../data/library';
import { useGenreCovers, useGenres } from '../../data/queries';
import { useRealtime } from '../../data/realtime';
import { useCanPlay } from '../../downloads/DownloadsProvider';
import { useBriefFailures } from '../../inlineFeedback';
import { radioFailure } from '../../library/failures';
import { pageHref, type Page } from '../../library/links';
import { useStartGuard } from '../../library/pending';
import { searchEnd, searchFilterLabels, searchNotice } from '../../library/search';
import { albumCollection, albumTypeLabels, artistCollection, playlistCollection, useCollectionDim } from '../../library/shared';
import { radioStartingNotice } from '../../library/trackActionList';
import { useRecentSearches, useSearchList } from '../../library/useSearchList';
import { usePlaybackActions } from '../../playback';
import { playbackStatus } from '../../player/usePlaybackStatus';
import { Icon } from '../../ui';
import { Artwork } from '../Artwork';
import { Button } from '../Button';
import { Focusable } from '../Focusable';
import type { MenuAction } from '../Menu';
import { useCollectionMenu } from '../menus';
import { Backdrop } from '../Page';
import { SidebarPill, TabRoot } from '../Sidebar';
import { useNavigate } from '../routes';
import { colors, tv, type } from '../theme';
import { ResultCard, SongCard } from './ResultCard';
import { genreColumns, resultColumns, searchRows, type SearchRow } from './searchRows';
import { useTabScroll } from './useTabScroll';

/** The system's search field and its one-row keyboard; null in a build without the native view. */
const NativeSearch = nativeTVSearch();
/**
 * The native field with its one-row keyboard; false shows a row that opens the system's
 * full-screen keyboard instead, should the native one misbehave.
 */
const useNativeField = true;
/** The native field's height, keyboard included, and where the filters under it begin. */
const fieldHeight = 300;
const fieldTop = tv.top - 10;

const contentWidth = 1920 - tv.gutter * 2;
const cardWidth = Math.floor((contentWidth - tv.tileGap * (resultColumns - 1)) / resultColumns);
const genreWidth = Math.floor((contentWidth - tv.tileGap * (genreColumns - 1)) / genreColumns);
const genreHeight = 230;
/** Results viewed lately, three rows of them. */
const recentItems = 9;
/** Genres to browse, two rows of them. */
const genreCount = 8;
const placeholder = 'Songs, albums, artists, playlists';
/** Colors for genre tiles whose albums have no artwork color. */
const genreColors = ['#7A4E9C', '#2F6E8F', '#9C4E5E', '#4E7F5A', '#8F6A2F', '#4E5A9C', '#9C6A4E', '#3F7F7F'];

/**
 * Search: the system's search field at the top with its one-row keyboard, and under it what
 * focus reaches by moving down: the results for what is typed, every kind mixed as the server
 * ranks them, with filters that narrow them to one kind and page further. A song plays on its
 * own (one that cannot play opens its album); anything else opens. Before anything is typed,
 * the results viewed lately and genres to browse.
 */
export function SearchScreen() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SearchFilter>('all');
  const list = useSearchList(query, filter);
  const recents = useRecentSearches();
  const genres = useGenres();
  const { offline } = useRealtime();
  const term = query.trim();
  // The server answers nothing under two characters; until then the page shows what it had.
  const active = [...term].length >= 2;
  const genreNames = useMemo(() => (genres.data ?? []).slice(0, genreCount).map(genre => genre.name), [genres.data]);
  const covers = useGenreCovers(genreNames);
  const rows = useMemo(() => searchRows({
    active: active && !offline,
    title: filter === 'all' ? 'Top results' : searchFilterLabels[filter],
    items: list.items ?? [],
    recents: recents.list.slice(0, recentItems),
    genres: genreNames,
  }), [active, filter, genreNames, list.items, offline, recents.list]);
  const notice = active ? searchNotice(list, offline) : null;
  const end = active ? searchEnd(list) : null;
  const stale = active && list.stale;
  const listRef = useRef<FlatList<SearchRow>>(null);
  const { height } = useWindowDimensions();
  const onScroll = useTabScroll(listRef);
  // What a song chosen from the results was found by, read when it is chosen: passed to every
  // card, each keystroke would draw them all again.
  const searchTerm = useRef('');
  searchTerm.current = active ? term : '';
  // Moving down from the keyboard folds the field up out of its frame (it stays focusable there,
  // so it is not clipped); the results move up into the room it leaves, taking the pill with them.
  const revealResults = useCallback(() => {
    if (NativeSearch && useNativeField) listRef.current?.scrollToOffset({ offset: fieldTop + fieldHeight - 140, animated: true });
  }, []);

  const renderRow = useCallback(({ item: row }: { item: SearchRow }) => {
    switch (row.kind) {
      case 'heading': return <View style={styles.heading}>
        <Text accessibilityRole="header" style={styles.headingText}>{row.title}</Text>
        {row.clear && <Button label="Clear" onPress={recents.clear} accessibilityLabel="Clear all recently viewed" />}
      </View>;
      case 'results': return <View style={[styles.row, stale && styles.stale]}>
        {row.items.map(item => <Result key={`${item.type}:${resultId(item)}`} item={item} term={searchTerm} stale={stale} onViewed={recents.add} />)}
      </View>;
      case 'genres': return <View style={styles.row}>
        {row.names.map((name, index) => <GenreTile key={name} name={name} artwork={covers[row.start + index]} fallback={genreColors[(row.start + index) % genreColors.length]!} />)}
      </View>;
    }
  }, [covers, recents.add, recents.clear, stale]);

  const header = <View>
    {/* The sidebar's pill rides at the top of the list, so it scrolls away with the keyboard. */}
    <SidebarPill />
    {NativeSearch && useNativeField
      ? <NativeSearch style={styles.field} placeholder={placeholder} onChangeText={event => setQuery(event.nativeEvent.text)} />
      : <FallbackField value={query} onChange={setQuery} />}
    {active && !offline && <View style={styles.filters}>
      {searchFilters.map(option => <FilterChip key={option} label={searchFilterLabels[option]} selected={filter === option} onSelect={() => setFilter(option)}
        onFocus={revealResults} />)}
    </View>}
    {notice && <Notice notice={notice} term={term} filter={filter} retrying={Boolean(list.retrying)} onRetry={() => void list.refetch()} />}
    {!active && !rows.length && (genres.isPending ? <ActivityIndicator style={styles.spinner} color={colors.secondary} />
      : <Message icon="magnifyingglass" title="Search your music" description="Find songs, albums, artists and playlists by name." />)}
  </View>;
  const footer = end === 'moreFailed'
    ? <View style={styles.more}><Text style={styles.noteText}>More results didn’t load.</Text><Button label="Try again" onPress={list.retryMore!} /></View>
    : end === 'loading' ? <ActivityIndicator style={styles.spinner} color={colors.secondary} /> : <View style={styles.end} />;

  return <TabRoot pill={false}><View style={styles.page}>
    <Backdrop />
    <FlatList
      ref={listRef}
      onScroll={onScroll}
      scrollEventThrottle={100}
      data={rows}
      renderItem={renderRow}
      keyExtractor={row => row.key}
      extraData={stale}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      onEndReached={active ? list.loadMore : undefined}
      onEndReachedThreshold={2}
      initialNumToRender={6}
      maxToRenderPerBatch={4}
      windowSize={7}
      removeClippedSubviews={false}
      showsVerticalScrollIndicator={false}
      // A vertical list on the TV sits in a focus guide of no size of its own: it is given the screen's height.
      style={[styles.list, { height }]}
      contentContainerStyle={styles.content}
    />
  </View></TabRoot>;
}

const resultId = (item: SearchItem) => (item.type === 'track' ? item.track.id : item.type === 'album' ? item.album.id : item.type === 'artist' ? item.artist.id : item.playlist.id);

type ResultProps = { item: SearchItem; term: RefObject<string>; stale: boolean; onViewed: (item: SearchItem) => void };

/** A result as a card. An earlier search's results, faded while this one's load, do nothing when chosen. */
const Result = memo(function Result({ item, term, stale, onViewed }: ResultProps) {
  switch (item.type) {
    case 'track': return <TrackResult track={item.track} term={term} stale={stale} onViewed={onViewed} />;
    case 'album': return <AlbumResult album={item.album} stale={stale} onViewed={onViewed} />;
    case 'artist': return <ArtistResult artist={item.artist} stale={stale} onViewed={onViewed} />;
    case 'playlist': return <PlaylistResult playlist={item.playlist} stale={stale} onViewed={onViewed} />;
  }
});

function useLink() {
  const { tab } = useNavigate();
  return useCallback((page: Page, id: string) => pageHref(tab, page, id), [tab]);
}

function TrackResult({ track, term, stale, onViewed }: { track: TrackSummary; term: ResultProps['term']; stale: boolean; onViewed: ResultProps['onViewed'] }) {
  const playable = useCanPlay(track);
  const actions = usePlaybackActions();
  const { open } = useNavigate();
  return <SongCard track={track} width={cardWidth} onPress={() => {
    if (stale) return;
    onViewed({ type: 'track', track });
    // The song playing (or paused) pauses or resumes rather than starting over, as its row does.
    if (actions.toggleIfCurrent(track.id)) return;
    // As on the web, a song that can't play opens its album, where there may be more to say or want.
    if (!playable) {
      if (track.album) open('album', track.album.id);
      return;
    }
    // The song on its own: when it ends, autoplay goes on with music like it, not the rest of what was found.
    actions.playTracks([track], { start: 0, context: searchContext(term.current) });
  }} />;
}

/**
 * The heart's menu entry, worded by client-core's rule as on the phone's Search rows; null when
 * an older server did not say whether it is saved, or offline. A refused change was set back,
 * and the entry that makes it again says so.
 */
function useSaveEntry(type: 'album' | 'artist', id: string, name: string, known: boolean | undefined) {
  const liked = useLiked(type, id, known);
  const failed = useLikeFailure(type, id) !== undefined;
  const { setLiked } = useLibraryActions();
  const { offline } = useRealtime();
  if (known === undefined || offline) return null;
  const { saved, label } = librarySave({ liked });
  const action: MenuAction = {
    id: 'save', title: failed ? `Couldn’t ${saved ? 'remove from' : 'save to'} library. Try again` : label,
    image: failed ? 'exclamationmark.circle' : saved ? 'heart.slash' : 'heart',
  };
  return { action, run: () => setLiked(type, id, !saved, name) };
}

function AlbumResult({ album, stale, onViewed }: { album: AlbumSummary; stale: boolean; onViewed: ResultProps['onViewed'] }) {
  const link = useLink();
  const dim = useCollectionDim();
  const menuFor = useCollectionMenu();
  const save = useSaveEntry('album', album.id, album.title, album.liked);
  const { open } = useNavigate();
  const item = dim(albumCollection(album, link));
  // A tile's menu leaves the heart to the album's page; here it goes after Add to playlist, as in the phone's Search.
  const base = menuFor(item);
  const at = base.actions.findIndex(action => action.id === 'playlist') + 1;
  const menu = save && at > 0 ? {
    actions: [...base.actions.slice(0, at), save.action, ...base.actions.slice(at)],
    onAction: (id: string) => (id === save.action.id ? save.run() : base.onAction(id)),
  } : base;
  return <ResultCard artwork={album.artwork} title={album.title} subtitle={`${albumTypeLabels[album.type]} · ${album.artistCredit}`} dim={item.dim}
    width={cardWidth} menu={menu} onPress={() => {
      if (stale) return;
      onViewed({ type: 'album', album });
      open('album', album.id);
    }} />;
}

/**
 * An artist's menu, as the phone's Search row has it: a radio, and the heart where the server
 * said it. A radio already starting is not started again; one that did not start says so in its
 * entry for a few seconds, and in the player's status line, as the menu has closed by then.
 */
function useArtistMenu(artist: ArtistSummary): { actions: MenuAction[]; onAction: (id: string) => void } | undefined {
  const api = useSignedInApi();
  const actions = usePlaybackActions();
  const { offline } = useRealtime();
  const starts = useStartGuard();
  const radioFailures = useBriefFailures<true>();
  const save = useSaveEntry('artist', artist.id, artist.name, artist.liked);
  if (offline) return undefined;
  const radioFailed = radioFailures.failures.has('radio');
  return {
    actions: [
      { id: 'radio', title: radioFailed ? radioFailure : 'Start radio', image: radioFailed ? 'exclamationmark.circle' : 'dot.radiowaves.left.and.right' },
      ...(save ? [save.action] : []),
    ],
    onAction: id => {
      if (id === save?.action.id) return save.run();
      if (id !== 'radio' || !api) return;
      radioFailures.drop('radio');
      starts.run('radio', () => {
        const starting = playbackStatus.report(radioStartingNotice);
        return api.radio.artist(artist.id).then(radio => {
          playbackStatus.withdraw(starting);
          actions.playRadio(radio);
        }, () => {
          radioFailures.fail('radio', true);
          playbackStatus.report({ message: `Couldn’t start a radio for ${artist.name}` });
        });
      });
    },
  };
}

function ArtistResult({ artist, stale, onViewed }: { artist: ArtistSummary; stale: boolean; onViewed: ResultProps['onViewed'] }) {
  const link = useLink();
  const menu = useArtistMenu(artist);
  const { open } = useNavigate();
  const item = artistCollection(artist, link);
  return <ResultCard artwork={artist.image} circle title={artist.name} subtitle={item.subtitle} width={cardWidth}
    menu={menu} onPress={() => {
      if (stale) return;
      onViewed({ type: 'artist', artist });
      open('artist', artist.id);
    }} />;
}

function PlaylistResult({ playlist, stale, onViewed }: { playlist: PlaylistSummary; stale: boolean; onViewed: ResultProps['onViewed'] }) {
  const link = useLink();
  const menuFor = useCollectionMenu();
  const { open } = useNavigate();
  const item = playlistCollection(playlist, link);
  return <ResultCard artwork={playlist.artworks[0]} icon="music.note.list" color="#4F416B" title={playlist.name} subtitle={item.subtitle}
    width={cardWidth} menu={menuFor(item)} onPress={() => {
      if (stale) return;
      onViewed({ type: 'playlist', playlist });
      open('playlist', playlist.id);
    }} />;
}

/** A genre to browse: a large tile in its albums' color, with one of their covers in it. */
const GenreTile = memo(function GenreTile({ name, artwork, fallback }: { name: string; artwork: AlbumSummary | undefined; fallback: string }) {
  const { open } = useNavigate();
  const base = artwork?.artwork?.color ? shade(artwork.artwork.color, 0.8) : fallback;
  return <Focusable accessibilityRole="button" accessibilityLabel={name} onPress={() => open('genre', name)} scale={1.05} style={{ width: genreWidth }}
    liftStyle={styles.genreLift}>
    <View style={[styles.genre, { backgroundColor: base }]}>
      {artwork?.artwork && <Artwork artwork={artwork.artwork} size={genreHeight} radius={0} focusEffect={false} style={styles.genreCover} />}
      <LinearGradient colors={[base, `${base}00`]} start={{ x: 0.35, y: 0 }} end={{ x: 0.75, y: 0 }} style={StyleSheet.absoluteFill} />
      <LinearGradient colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.35)']} style={StyleSheet.absoluteFill} />
      <Text style={styles.genreName} numberOfLines={2}>{name}</Text>
    </View>
  </Focusable>;
});

/** One of the filters over the results: the chosen one is filled, the focused one white. */
function FilterChip({ label, selected, onSelect, onFocus }: { label: string; selected: boolean; onSelect: () => void; onFocus: () => void }) {
  return <Focusable onFocus={onFocus} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={label} onPress={onSelect} scale={1.08}
    liftStyle={({ focused }) => [styles.chip, selected && styles.chipSelected, focused && styles.chipFocused]}>
    {({ focused }) => <Text style={[styles.chipLabel, { color: focused ? colors.onFocused : selected ? colors.text : colors.secondary }]}>{label}</Text>}
  </Focusable>;
}

/**
 * Without the native field, a row that shows what is typed and opens the system's full-screen
 * keyboard when chosen. The input itself stays out of sight: the keyboard screen shows the text.
 */
function FallbackField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  return <Focusable accessibilityRole="search" accessibilityLabel={value ? `Search, ${value}` : 'Search'} hasTVPreferredFocus
    onPress={() => input.current?.focus()} scale={1.02} style={styles.fallbackBox}
    liftStyle={({ focused }) => [styles.fallback, focused && styles.fallbackFocused]}>
    {({ focused }) => <>
      <Icon name="magnifyingglass" size={44} color={focused ? colors.onFocused : colors.secondary} />
      <Text numberOfLines={1} style={[styles.fallbackText, { color: focused ? colors.onFocused : value ? colors.text : colors.tertiary }]}>
        {value || placeholder}
      </Text>
      <TextInput ref={input} value={value} onChangeText={onChange} placeholder={placeholder} style={styles.hiddenInput}
        autoCorrect={false} autoCapitalize="none" returnKeyType="search" focusable={false} />
    </>}
  </Focusable>;
}

function Notice({ notice, term, filter, retrying, onRetry }: {
  notice: NonNullable<ReturnType<typeof searchNotice>>; term: string; filter: SearchFilter; retrying: boolean; onRetry: () => void;
}) {
  switch (notice) {
    case 'offline': return <Message icon="wifi.slash" title="You’re offline" description="Search needs your server." />;
    case 'failed': return <Message icon="wifi.exclamationmark" title="Search isn’t available" description="Check your connection to the server." onRetry={onRetry} />;
    case 'searching': return <ActivityIndicator style={styles.spinner} color={colors.secondary} accessibilityLabel="Searching" />;
    case 'catalogEmpty': return <Message icon="wifi.exclamationmark" title="Couldn’t search the catalog" description={`Nothing on your server matches “${term}”.`}
      onRetry={retrying ? undefined : onRetry} />;
    case 'noResults': return <Message icon="magnifyingglass" title="No results"
      description={filter === 'all' ? 'Try a different song, album, or artist.' : 'Try All, or another spelling.'} />;
    case 'catalogNote': return <View style={styles.more}>
      <Text style={styles.noteText}>Couldn’t search the catalog. Only music on your server is listed.</Text>
      {retrying ? <ActivityIndicator color={colors.secondary} /> : <Button label="Try again" onPress={onRetry} />}
    </View>;
  }
}

function Message({ icon, title, description, onRetry }: { icon: string; title: string; description: string; onRetry?: () => void }) {
  return <View style={styles.message}>
    <Icon name={icon} size={72} color={colors.secondary} />
    <Text style={type.title3}>{title}</Text>
    <Text style={styles.messageText}>{description}</Text>
    {onRetry && <Button label="Try again" icon="arrow.clockwise" onPress={onRetry} />}
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  list: { overflow: 'visible' },
  content: { paddingBottom: 120 },
  field: { height: fieldHeight, marginHorizontal: tv.gutter, marginTop: fieldTop },
  fallbackBox: { marginHorizontal: tv.gutter, marginTop: tv.top, marginBottom: 20 },
  fallback: { flexDirection: 'row', alignItems: 'center', gap: 24, paddingHorizontal: 32, height: 110, borderRadius: 24, backgroundColor: colors.platter },
  fallbackFocused: { backgroundColor: colors.focused },
  fallbackText: { flex: 1, ...type.title2, fontWeight: '600' },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  filters: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 10, marginBottom: 20 },
  chip: { height: 66, paddingHorizontal: 34, borderRadius: 33, justifyContent: 'center', backgroundColor: 'transparent' },
  chipSelected: { backgroundColor: colors.platterStrong },
  chipFocused: { backgroundColor: colors.focused },
  chipLabel: { ...type.callout, fontWeight: '600' },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 28, marginHorizontal: tv.gutter, marginTop: 36, marginBottom: 22 },
  headingText: { ...type.section },
  row: { flexDirection: 'row', gap: tv.tileGap, marginHorizontal: tv.gutter, marginBottom: tv.tileGap },
  stale: { opacity: 0.5 },
  genreLift: { borderRadius: 20 },
  genre: { width: genreWidth, height: genreHeight, borderRadius: 20, overflow: 'hidden', justifyContent: 'flex-end', padding: 28 },
  genreCover: { position: 'absolute', right: 0, top: 0 },
  genreName: { ...type.title3, fontSize: 36, fontWeight: '700' },
  spinner: { marginVertical: 60 },
  more: { alignItems: 'center', gap: 16, marginVertical: 30 },
  noteText: { ...type.body, color: colors.secondary, textAlign: 'center' },
  end: { height: 1 },
  message: { alignItems: 'center', gap: 18, paddingVertical: 80, paddingHorizontal: tv.gutter },
  messageText: { ...type.body, color: colors.secondary, textAlign: 'center', maxWidth: 1000 },
});
