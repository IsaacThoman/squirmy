import type { AlbumSummary, LibraryItem, LibrarySort, TrackSummary } from '@squirmy/contracts';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, Text, TVFocusGuideView, useWindowDimensions, View } from 'react-native';
import type { Api } from '../../account/AccountProvider';
import { loadFailure } from '../../data/errors';
import { useGenreAlbums, useGenres, useLibraryItems, useLibraryList, usePlaylists, useServerAlbums } from '../../data/queries';
import { useAvailability } from '../../downloads/DownloadsProvider';
import { playAllFailure } from '../../library/failures';
import { emptyLibrary, emptyServer, listsNothing } from '../../library/libraryEmpty';
import { pageHref, type Page } from '../../library/links';
import {
  albumCollection, artistCollection, likedCollection, playlistCollection, recentCollection, type Collection,
} from '../../library/shared';
import { sortOptions, type SortName } from '../../library/sorting';
import { usePlayAll } from '../../library/usePlayAll';
import { usePlaybackActions } from '../../playback';
import { Icon } from '../../ui';
import { Button, SystemButton } from '../Button';
import { Focusable } from '../Focusable';
import { Backdrop } from '../Page';
import { TabRoot } from '../Sidebar';
import { SongRow } from '../SongRow';
import { colors, tv, type } from '../theme';
import { CollectionGrid, MoreSpinner } from '../pages/CollectionGrid';
import {
  categories, categorySort, categorySorts, countLabel, genreCategory, genreOf, listSort, serverCategory, type Category, type CategoryId,
} from './libraryCategories';

/** Where the categories and the page beside them begin, under the sidebar's pill. */
const top = 150;
const listLeft = 50;
const listWidth = 330;
const contentLeft = 440;
const contentWidth = 1920 - contentLeft - tv.gutter;
const columns = 5;
const tile = Math.floor((contentWidth - tv.tileGap * (columns - 1)) / columns);
/** Library genres listed under the categories. */
const genreLimit = 12;
/** How long focus rests on a category before the page beside it changes, so moving past one does not load it. */
const selectDelayMs = 220;

/**
 * The Library, laid out as the system's music app lays out its own: categories down the left
 * (All, which is the phone's Library with its pins first, then playlists, artists, albums and
 * songs, the server's music and the library's genres) and the chosen one's tiles or songs
 * beside them, each with its sorts. Focus resting on a category shows it; moving right goes into
 * it, and left comes back to the category it shows.
 */
export function LibraryScreen() {
  const [selected, setSelected] = useState<CategoryId>('all');
  const [chosen, setChosen] = useState<Partial<Record<CategoryId, SortName>>>({});
  const genres = useGenres();
  const genreItems = useMemo(() => (genres.data ?? []).slice(0, genreLimit).map(genre => genreCategory(genre.name)), [genres.data]);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);
  const focusCategory = useCallback((id: CategoryId) => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => setSelected(id), selectDelayMs);
  }, []);
  const choose = useCallback((id: CategoryId) => {
    if (pending.current) clearTimeout(pending.current);
    setSelected(id);
  }, []);
  // Only the first render asks for focus, so the page opens on the category it shows.
  const [initial] = useState(selected);
  const all = [...categories, serverCategory, ...genreItems];
  const category = all.find(item => item.id === selected) ?? categories[0]!;
  const sort = categorySort(selected, chosen[selected]);
  const setSort = (name: SortName) => setChosen(current => ({ ...current, [selected]: name }));

  const row = (item: Category) => <CategoryRow key={item.id} category={item} selected={item.id === selected}
    preferred={item.id === initial} onFocus={focusCategory} onPress={choose} />;
  return <TabRoot><View style={styles.page}>
    <Backdrop />
    <TVFocusGuideView autoFocus style={styles.categories}>
      <ScrollView style={styles.visible} contentContainerStyle={styles.categoryList} showsVerticalScrollIndicator={false}>
        {categories.map(row)}
        <View style={styles.divider} />
        {row(serverCategory)}
        {genreItems.length > 0 && <Text style={styles.groupTitle}>Genres</Text>}
        {genreItems.map(row)}
      </ScrollView>
    </TVFocusGuideView>
    {/* Right from any category enters the page beside it, at what was focused there last, whatever the rows' heights. */}
    <TVFocusGuideView autoFocus style={styles.content}>
      <CategoryContent key={category.id} category={category} sort={sort} onSort={setSort} onChoose={choose} />
    </TVFocusGuideView>
  </View></TabRoot>;
}

function CategoryRow({ category, selected, preferred, onFocus, onPress }: {
  category: Category; selected: boolean; preferred: boolean; onFocus: (id: CategoryId) => void; onPress: (id: CategoryId) => void;
}) {
  const genre = genreOf(category.id) !== null;
  return <Focusable accessibilityRole="button" accessibilityLabel={category.title} accessibilityState={{ selected }}
    hasTVPreferredFocus={preferred} scale={1.04} onFocus={() => onFocus(category.id)} onPress={() => onPress(category.id)}
    liftStyle={({ focused }) => [styles.category, selected && styles.categorySelected, focused && styles.categoryFocused]}>
    {({ focused }) => <>
      {!genre && <View style={styles.categoryIcon}><Icon name={category.icon} size={30} color={focused ? colors.onFocused : selected ? colors.text : colors.secondary} /></View>}
      <Text numberOfLines={1} style={[styles.categoryLabel, { color: focused ? colors.onFocused : selected ? colors.text : colors.secondary }]}>{category.title}</Text>
    </>}
  </Focusable>;
}

type ContentProps = { category: Category; sort: SortName; onSort: (name: SortName) => void; onChoose: (id: CategoryId) => void };

function CategoryContent(props: ContentProps) {
  const genre = genreOf(props.category.id);
  if (genre !== null) return <GenreContent {...props} genre={genre} />;
  switch (props.category.id) {
    case 'all': return <AllContent {...props} />;
    case 'playlists': return <PlaylistsContent {...props} />;
    case 'artists': return <ArtistsContent {...props} />;
    case 'albums': return <AlbumsContent {...props} />;
    case 'songs': return <SongsContent {...props} />;
    default: return <ServerContent {...props} />;
  }
}

/** Pages open over the Library's own stack. */
const link = (page: Page, id: string) => pageHref('library', page, id);

/** Sorted by year, an album's year says why it is where it is. */
const albumSubtitle = (album: AlbumSummary, sort: SortName) => (sortOptions[sort] === 'year' && album.year ? `${album.artistCredit} · ${album.year}` : album.artistCredit);

/** A list being loaded a page at a time, as the query hooks return it. */
type Paged = { data?: unknown; isError: boolean; error: unknown; refetch: () => unknown; hasNextPage: boolean; isFetchingNextPage: boolean; loadMore: () => void };

/** The phone's Library: everything saved, the pins first. Empty, it points at the server's music and Search. */
function AllContent({ category, sort, onSort, onChoose }: ContentProps) {
  const router = useRouter();
  const list = useLibraryItems(sortOptions[sort]);
  // The server lists the pins first; whether each item is pinned is known here, so its menu offers Pin or Unpin.
  const items = useMemo(() => list.items.map((item: LibraryItem): Collection => {
    const pinned = { pinned: item.pinned };
    switch (item.kind) {
      case 'liked': return { ...likedCollection(link), ...pinned };
      case 'playlist': return { ...playlistCollection(item.playlist, link), ...pinned };
      case 'album': return { ...albumCollection(item.album, link, albumSubtitle(item.album, sort)), ...pinned };
      case 'artist': return { ...artistCollection(item.artist, link), ...pinned };
    }
  }), [list.items, sort]);
  const empty = list.data && !list.hasNextPage && listsNothing({ server: false, items: list.items });
  return <Grid category={category} detail={countLabel(list.items.length, !list.hasNextPage, 'item')} sort={sort} onSort={onSort} list={list} items={empty ? [] : items}
    empty={<Empty icon={emptyLibrary.icon} title={emptyLibrary.title}
      description="Albums and songs you save show up here, with the music you upload. Find something you love on this server or in Search, and choose the heart.">
      <View style={styles.emptyButtons}>
        <Button label="Browse this server" onPress={() => onChoose('server')} />
        <Button label="Find music" icon="magnifyingglass" onPress={() => router.navigate('/(tabs)/(search)')} />
      </View>
    </Empty>} />;
}

/** Liked Songs and history, then the playlists the viewer can see. */
function PlaylistsContent({ category, sort, onSort }: ContentProps) {
  const list = usePlaylists();
  const items = useMemo(() => [likedCollection(link), recentCollection(link), ...list.items.map(playlist => playlistCollection(playlist, link))],
    [list.items]);
  return <Grid category={category} detail={countLabel(list.items.length, !list.hasNextPage, 'playlist')} sort={sort} onSort={onSort} list={list} items={items} />;
}

function ArtistsContent({ category, sort, onSort }: ContentProps) {
  // Artists are listed by name, as on web.
  const list = useLibraryList('artists', 'title');
  const items = useMemo(() => list.items.map(artist => artistCollection(artist, link)), [list.items]);
  return <Grid category={category} detail={countLabel(items.length, !list.hasNextPage, 'artist')} sort={sort} onSort={onSort} list={list} items={items}
    empty={<Empty icon="music.mic" title="No artists yet" description="Artists you save, and the artists of albums you save, show up here." />} />;
}

function AlbumsContent({ category, sort, onSort }: ContentProps) {
  const list = useLibraryList('albums', listSort(sort));
  const items = useMemo(() => list.items.map(album => albumCollection(album, link, albumSubtitle(album, sort))), [list.items, sort]);
  return <Grid category={category} detail={countLabel(items.length, !list.hasNextPage, 'album')} sort={sort} onSort={onSort} list={list} items={items}
    empty={<Empty icon="square.stack" title="No albums yet" description="Albums you save show up here, with the albums you upload." />} />;
}

/** On this server: the server's albums, whatever is in the library, as Home's See all on the phone. */
function ServerContent({ category, sort, onSort }: ContentProps) {
  const list = useServerAlbums(listSort(sort));
  const items = useMemo(() => list.items.map(album => albumCollection(album, link, albumSubtitle(album, sort))), [list.items, sort]);
  return <Grid category={category} detail={countLabel(items.length, !list.hasNextPage, 'album')} sort={sort} onSort={onSort} list={list} items={items}
    empty={<Empty icon={emptyServer.icon} title={emptyServer.title} description={emptyServer.description} />} />;
}

function GenreContent({ category, sort, onSort, genre }: ContentProps & { genre: string }) {
  const list = useGenreAlbums(genre);
  const items = useMemo(() => list.items.map(album => albumCollection(album, link)), [list.items]);
  return <Grid category={category} detail={countLabel(items.length, !list.hasNextPage, 'album')} sort={sort} onSort={onSort} list={list} items={items}
    empty={<Empty icon="square.stack" title="No albums yet" description={`Albums tagged ${genre} show up here.`} />} />;
}

/** A category's tiles, under its title, how many there are, and its sorts. */
function Grid({ category, detail, sort, onSort, list, items, empty }: {
  category: Category; detail: string; sort: SortName; onSort: (name: SortName) => void; list: Paged; items: readonly Collection[]; empty?: ReactElement;
}) {
  return <CollectionGrid items={items} columns={columns} size={tile} onEndReached={list.loadMore} contentStyle={styles.listContent}
    header={<>
      <Header category={category} detail={list.data ? detail : undefined} sort={sort} onSort={onSort} />
      <ListState list={list} empty={list.data && !items.length && !list.hasNextPage ? empty : undefined} />
    </>}
    footer={<MoreSpinner loading={list.isFetchingNextPage} />} />;
}

const tracksPage = (sort: LibrarySort) => (api: Api, cursor: string, limit: number) => api.catalog.tracks({ sort, cursor, limit });
const songContext = { type: 'other', id: null, title: 'Songs' } as const;

/** The library's songs as a list, with Play and Shuffle for all of them. */
function SongsContent({ category, sort, onSort }: ContentProps) {
  const server = listSort(sort);
  const list = useLibraryList('tracks', server);
  const fetchPage = useMemo(() => tracksPage(server), [server]);
  const playAll = usePlayAll({ list, fetchPage, tracksOf: items => [...items] });
  const actions = usePlaybackActions();
  const { canPlay } = useAvailability();
  const play = (shuffle: boolean, start?: number) => playAll.run(start, shuffle,
    all => actions.playTracks(all, { start, shuffle, context: songContext }));
  // `playAll` is new each render; the rows reach the latest through a ref, so they are not all drawn again.
  const latest = useRef(play);
  latest.current = play;
  const render = useCallback(({ item: track, index }: { item: TrackSummary; index: number }) => <SongRow track={track} cover album
    onPress={() => latest.current(false, index)} />, []);
  const playable = list.items.some(canPlay);
  const { height } = useWindowDimensions();
  return <FlatList
    data={list.items}
    renderItem={render}
    keyExtractor={track => track.id}
    onEndReached={list.loadMore}
    onEndReachedThreshold={2}
    initialNumToRender={10}
    maxToRenderPerBatch={8}
    windowSize={7}
    removeClippedSubviews={false}
    showsVerticalScrollIndicator={false}
    // A vertical list on the TV sits in a focus guide of no size of its own: it is given the screen's height.
    style={[styles.visible, { height }]}
    contentContainerStyle={[styles.listContent, styles.songs]}
    ListHeaderComponent={<View style={styles.songsHeader}>
      <Header category={category} detail={list.data ? countLabel(list.items.length, !list.hasNextPage, 'song') : undefined} sort={sort} onSort={onSort}
        buttons={list.items.length > 0 && <>
          <SystemButton label={playAll.busy === 'play' ? 'Loading…' : 'Play'} icon="play.fill" disabled={!playable} onPress={() => play(false)} />
          <SystemButton label={playAll.busy === 'shuffle' ? 'Loading…' : 'Shuffle'} icon="shuffle" disabled={!playable} onPress={() => play(true)} />
        </>} />
      {playAll.failed && <Text style={styles.note}>{playAllFailure}</Text>}
      <ListState list={list} empty={list.data && !list.items.length
        ? <Empty icon="music.note" title="No songs yet" description="Songs you save, and the songs of albums you save, show up here." /> : undefined} />
    </View>}
    ListFooterComponent={<MoreSpinner loading={list.isFetchingNextPage} />}
  />;
}

/**
 * A category's title and how many it holds, with its buttons and sorts on the right, as the
 * system's music app heads its library's lists. The buttons are one focus target from below,
 * however far right they sit.
 */
function Header({ category, detail, sort, onSort, buttons }: {
  category: Category; detail?: string; sort: SortName; onSort: (name: SortName) => void; buttons?: ReactNode;
}) {
  const sorts = categorySorts(category.id);
  return <View style={styles.header}>
    <View style={styles.headerWords}>
      <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>{category.title}</Text>
      <Text style={styles.detail} numberOfLines={1}>{detail ?? ' '}</Text>
    </View>
    <TVFocusGuideView autoFocus style={styles.headerButtons}>
      {buttons}
      {sorts.length > 1 && <SystemButton icon="arrow.up.arrow.down" accessibilityLabel={`Sort, ${sort}`} menu={{
        actions: sorts.map(name => ({ id: name, title: name, checked: name === sort })),
        onAction: id => onSort(id as SortName),
      }} />}
    </TVFocusGuideView>
  </View>;
}

/** Loading a category, why it could not load with Try again, or what to say when it is empty. */
function ListState({ list, empty }: { list: Paged; empty?: ReactElement }) {
  if (!list.data) {
    if (list.isError) {
      return <View style={styles.state}>
        <Text style={styles.note}>{loadFailure(list.error).description}</Text>
        <Button label="Try again" icon="arrow.clockwise" onPress={() => void list.refetch()} />
      </View>;
    }
    return <ActivityIndicator style={styles.loading} color={colors.secondary} />;
  }
  return empty ?? null;
}

function Empty({ icon, title, description, children }: { icon: string; title: string; description: string; children?: ReactNode }) {
  return <View style={styles.empty}>
    <Icon name={icon} size={80} color={colors.secondary} />
    <Text style={type.title3}>{title}</Text>
    <Text style={styles.emptyText}>{description}</Text>
    {children}
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  visible: { overflow: 'visible' },
  categories: { position: 'absolute', left: listLeft, top: 0, bottom: 0, width: listWidth },
  categoryList: { paddingTop: top, paddingBottom: 80, gap: 4 },
  category: { flexDirection: 'row', alignItems: 'center', gap: 20, height: 72, borderRadius: 36, paddingHorizontal: 22 },
  categorySelected: { backgroundColor: colors.platterStrong },
  categoryFocused: { backgroundColor: colors.focused },
  categoryIcon: { width: 34, alignItems: 'center' },
  categoryLabel: { ...type.body, fontWeight: '500', flexShrink: 1 },
  divider: { height: 1, backgroundColor: colors.hairline, marginVertical: 22, marginHorizontal: 6 },
  groupTitle: { ...type.caption, color: colors.tertiary, marginTop: 22, marginBottom: 6, marginHorizontal: 22 },
  content: { position: 'absolute', left: contentLeft, right: 0, top: 0, bottom: 0 },
  listContent: { paddingTop: top, paddingBottom: 120, paddingRight: tv.gutter },
  songs: { paddingLeft: 0 },
  songsHeader: { marginHorizontal: 0 },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 76, marginBottom: 40 },
  headerWords: { flex: 1 },
  title: { ...type.headline, fontSize: 31, fontWeight: '600' },
  detail: { ...type.caption, fontSize: 25, fontWeight: '400', marginTop: 2 },
  headerButtons: { flexDirection: 'row', alignItems: 'center', gap: 24 },
  loading: { marginTop: 80, alignSelf: 'flex-start' },
  state: { alignItems: 'flex-start', gap: 24, marginTop: 20 },
  note: { ...type.body, color: colors.secondary },
  empty: { alignItems: 'center', gap: 18, paddingVertical: 100, paddingHorizontal: 40 },
  emptyText: { ...type.body, color: colors.secondary, textAlign: 'center', maxWidth: 1000 },
  emptyButtons: { flexDirection: 'row', gap: 24, marginTop: 20 },
});
