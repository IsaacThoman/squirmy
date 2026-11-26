import { albumPresentation, albumTypeLabel, canFetch, plural, searchContext, searchFilters, searchItemKey, type SearchFilter, type SearchItem } from '@squirmy/client-core';
import type { Artwork, HomeSection, LibraryItemsSort } from '@squirmy/contracts';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useAccount, useWantlistEnabled } from '../account/AccountProvider';
import { useArtworkImage } from '../data/artwork';
import { shade } from '../data/color';
import { useGenreCovers, useGenres, useHome, useLibraryItems, useServerAlbums } from '../data/queries';
import { useScanProgress } from '../data/realtime';
import { useViewer } from '../downloads/DownloadsProvider';
import { homeEmpty } from '../library/homeEmpty';
import { sortNames, sortOptions } from '../library/sorting';
import { useRecentSearches, useSearchList } from '../library/useSearchList';
import { usePlaybackActions } from '../playback';
import {
  albumCard, artistCard, homeCards, libraryCard, playlistCard, type BrowseProps, type BrowseRoute, type Card,
} from './browse/model';
import { AlbumPage, ArtistPage, GenrePage, HomeSongList, PlaylistPage, ReleasesPage } from './browse/Details';
import { BrowseRow, BrowseTrackRow } from './browse/rows';
import { AddToPlaylist, TrackMenu } from './browse/TrackActions';
import {
  BrowseArt, BrowseGrid, BrowseHeader, BrowseLoading, BrowseMessage, BrowseMore, BrowseQuery, BrowseScroll, BrowseShelf, browseStyles,
} from './browse/view';
import { TvButton, tvColors } from './ui';

export type { BrowseRoute } from './browse/model';

export function TvBrowse({ route, ...props }: BrowseProps & { route: BrowseRoute }) {
  switch (route.screen) {
    case 'home': return <Home {...props} />;
    case 'library': return <Library {...props} />;
    case 'collection': return <Collection {...props} />;
    case 'search': return <Search {...props} />;
    case 'genres': return <Genres {...props} />;
    case 'album': return <AlbumPage {...props} id={route.id} />;
    case 'artist': return <ArtistPage {...props} id={route.id} />;
    case 'playlist': return <PlaylistPage {...props} id={route.id} />;
    case 'genre': return <GenrePage {...props} id={route.id} />;
    case 'releases': return <ReleasesPage {...props} id={route.id} group={route.group} />;
    case 'homeSongs': return <HomeSongs {...props} id={route.id} />;
    case 'track': return <TrackMenu {...props} route={route} />;
    case 'addToPlaylist': return <AddToPlaylist {...props} route={route} />;
  }
}

function Home({ navigate }: BrowseProps) {
  const { state } = useAccount();
  const query = useHome();
  const wantlist = useWantlistEnabled();
  const viewer = useViewer();
  const scan = useScanProgress();
  const sections = (query.data?.sections ?? []).filter(section => wantlist || section.id !== 'wantlist');
  const empty = homeEmpty({ canFindMusic: canFetch(viewer), isAdmin: state.status === 'signedIn' && state.user.role === 'admin', scan });
  const leadSection = sections.find(section => section.kind === 'albums'
    && section.albums.some(album => album.artwork && albumPresentation(album, viewer) === 'normal'));
  const leadAlbum = leadSection?.kind === 'albums'
    ? leadSection.albums.find(album => album.artwork && albumPresentation(album, viewer) === 'normal')
    : undefined;
  const lead = leadAlbum ? albumCard(leadAlbum) : null;

  return <BrowseScroll>
    <BrowseHeader title="Listen now" />
    {lead && leadSection && <HomeFeature card={lead} source={leadSection.title} navigate={navigate} />}
    {!query.data && <BrowseQuery query={query} what="your music" />}
    {query.data && !sections.length && <BrowseMessage title={empty.title} detail={empty.description}
      action={empty.findMusic && <TvButton label="Find music" tone="primary" onPress={() => navigate({ screen: 'search' })} />} />}
    {sections.map(section => {
      if (section.kind === 'tracks') return section.tracks.length > 0
        && <HomeTracks section={section} key={section.id} navigate={navigate} />;
      const cards = homeCards(section).filter(card => section.id !== leadSection?.id || card.key !== lead?.key);
      const moreRoute: BrowseRoute | null = section.id === 'recently-added' ? { screen: 'collection' }
        : section.id === 'recently-played' ? { screen: 'playlist', id: 'recent' } : null;
      if (!cards.length && !moreRoute) return null;
      return <BrowseShelf key={section.id} title={section.title} cards={cards} navigate={navigate}
        more={moreRoute ? { label: 'See all', onPress: () => navigate(moreRoute) } : undefined} />;
    })}
  </BrowseScroll>;
}

function HomeFeature({ card, source, navigate }: { card: Card; source: string; navigate: BrowseProps['navigate'] }) {
  const { width } = useWindowDimensions();
  const size = Math.min(332, Math.round(width * 0.20));
  const dark = shade(card.artworks?.[0]?.color ?? '#60528A', 0.65);
  const image = useArtworkImage(card.artworks?.[0], 300);
  return <View style={styles.feature}>
    <LinearGradient colors={['#272239', dark]} start={{ x: 0.06, y: 0.74 }} end={{ x: 1, y: 0.24 }}
      style={StyleSheet.absoluteFill} pointerEvents="none" />
    {image && <Image {...image} accessible={false} blurRadius={56} contentFit="cover" style={styles.featureBackdrop} />}
    <LinearGradient colors={['#181327F5', '#1813274D', '#18132719']} locations={[0.20, 0.66, 1]}
      start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
    <View style={styles.featureDetails}>
      <Text style={styles.source}>{source}</Text>
      <Text accessibilityRole="header" style={styles.featureTitle} numberOfLines={2}>{card.title}</Text>
      <Text style={styles.featureArtist} numberOfLines={1}>{card.subtitle}</Text>
      <TvButton style={styles.featureButton} label="Open album" accessibilityLabel={`Open ${card.title}`} tone="primary"
        onPress={() => navigate(card.route)} />
    </View>
    <View style={styles.featureArt}>
      <BrowseArt artworks={card.artworks} size={size} />
    </View>
  </View>;
}

function HomeTracks({ section, navigate }: { section: Extract<HomeSection, { kind: 'tracks' }>; navigate: BrowseProps['navigate'] }) {
  const actions = usePlaybackActions();
  return <View style={styles.homeSongs}>
    <View style={styles.sectionHeader}>
      <Text accessibilityRole="header" style={browseStyles.section}>{section.title}</Text>
      {section.tracks.length > 4 && <TvButton label="See all" accessibilityLabel={`See all ${section.title}`} tone="quiet"
        onPress={() => navigate({ screen: 'homeSongs', id: section.id })} />}
    </View>
    {section.tracks.slice(0, 4).map((track, index) => <BrowseTrackRow key={`${track.id}:${index}`} track={track}
      onMenu={() => navigate({ screen: 'track', track })} play={() => {
        if (actions.toggleIfCurrent(track.id)) return;
        actions.playTracks(section.tracks, { start: index, context: { type: 'other', id: section.id, title: section.title } });
      }} />)}
  </View>;
}

function HomeSongs({ id, ...props }: BrowseProps & { id: string }) {
  const home = useHome();
  const section = home.data?.sections.find((item): item is Extract<HomeSection, { kind: 'tracks' }> => item.kind === 'tracks' && item.id === id);
  if (section) return <HomeSongList section={section} {...props} />;
  return <BrowseScroll>
    {home.data ? <BrowseMessage title="This list is empty" /> : <BrowseQuery query={home} what="these songs" />}
  </BrowseScroll>;
}

function Library({ navigate }: BrowseProps) {
  const [sort, setSort] = useState<LibraryItemsSort>('played');
  const list = useLibraryItems(sort);
  return <BrowseGrid cards={list.items.map(libraryCard)} navigate={navigate} header={<>
    <BrowseHeader title="Your library" />
    <View style={styles.filterBar}>
      {sortNames.map(name => <TvButton key={name} label={name} tone="quiet" selected={sort === sortOptions[name]}
        onPress={() => setSort(sortOptions[name])} />)}
    </View>
    {!list.data && <BrowseQuery query={list} what="your library" />}
    {list.data && !list.items.length && <BrowseMessage title="Your library is empty" detail="Save albums, artists or songs to find them here." />}
  </>} page={{ hasMore: list.hasNextPage, loadingMore: list.isFetchingNextPage, moreFailed: list.isFetchNextPageError, loadMore: list.loadMore }} />;
}

function Collection({ navigate }: BrowseProps) {
  const list = useServerAlbums('recent');
  return <BrowseGrid cards={list.items.map(album => albumCard(album))} navigate={navigate} header={<>
    <BrowseHeader title="On this server" />
    {!list.data && <BrowseQuery query={list} what="the server’s music" />}
    {list.data && !list.items.length && <BrowseMessage title="The server’s collection is empty" />}
  </>} page={{ hasMore: list.hasNextPage, loadingMore: list.isFetchingNextPage, moreFailed: list.isFetchNextPageError, loadMore: list.loadMore }} />;
}

const filterLabel: Record<SearchFilter, string> = { all: 'All', track: 'Songs', album: 'Albums', artist: 'Artists', playlist: 'Playlists' };

function Search({ navigate }: BrowseProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [filter, setFilter] = useState<SearchFilter>('all');
  const list = useSearchList(text, filter);
  const recents = useRecentSearches();
  const viewer = useViewer();
  const actions = usePlaybackActions();
  const term = text.trim();
  const searching = [...term].length >= 2;
  const items: readonly SearchItem[] = searching ? list.items ?? [] : recents.list;
  const status = searching && !list.pending && (list.failed ? 'Couldn’t search your server.' : list.catalogFailed ? 'Showing results from your server.' : null);

  return <FlatList data={items} keyExtractor={searchItemKey} contentContainerStyle={browseStyles.padding}
    contentInsetAdjustmentBehavior="never" showsVerticalScrollIndicator={false} removeClippedSubviews={false}
    ListHeaderComponent={<>
      <BrowseHeader title="Search" />
      <View style={styles.searchField}>
        <TextInput value={text} onChangeText={setText} accessibilityLabel="Search music"
          placeholder="Artists, albums, songs and playlists" placeholderTextColor={tvColors.muted}
          autoCapitalize="none" autoCorrect={false} returnKeyType="search" keyboardAppearance="dark" selectionColor={tvColors.accent}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          style={[styles.input, focused && styles.inputFocused]} />
        {text !== '' && <TvButton label="Clear" accessibilityLabel="Clear search" tone="quiet" onPress={() => setText('')} />}
      </View>
      {searching ? <View style={styles.filterBar}>
        {searchFilters.map(kind => <TvButton key={kind} label={filterLabel[kind]} tone="quiet" selected={filter === kind}
          onPress={() => setFilter(kind)} />)}
      </View> : recents.list.length > 0 && <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" style={browseStyles.section}>Recently viewed</Text>
        <TvButton label="Clear history" tone="quiet" onPress={recents.clear} />
      </View>}
      {status && <View style={styles.sectionHeader}>
        <Text accessibilityRole="alert" style={browseStyles.subtitle}>{status}</Text>
        <TvButton label="Try again" tone="quiet" onPress={() => { void list.refetch(); }} />
      </View>}
    </>}
    ListEmptyComponent={searching && !list.failed ? list.pending
      ? <BrowseLoading label="Searching" /> : <BrowseMessage title="No results" detail={`Nothing matches “${term}”.`} />
      : undefined}
    ListFooterComponent={searching
      ? <BrowseMore hasMore={!!list.loadMore || !!list.moreFailed} loadingMore={list.pending}
        moreFailed={list.moreFailed} loadMore={() => (list.retryMore ?? list.loadMore)?.()} />
      : <SearchGenres navigate={navigate} />}
    onEndReached={searching && !list.pending && !list.moreFailed ? list.loadMore : undefined} onEndReachedThreshold={0.4}
    renderItem={({ item }) => {
      if (item.type === 'track') return <BrowseTrackRow track={item.track} kind="Song"
        onMenu={() => navigate({ screen: 'track', track: item.track })}
        play={() => {
          recents.add(item);
          if (!actions.toggleIfCurrent(item.track.id)) actions.playTracks([item.track], { start: 0, context: searchContext(searching ? term : '') });
        }} />;
      const card = item.type === 'artist' ? artistCard(item.artist)
        : item.type === 'playlist' ? playlistCard(item.playlist)
          : albumCard(item.album, `${albumTypeLabel(item.album.type)} · ${item.album.artistCredit}`);
      const dim = item.type === 'album' && albumPresentation(item.album, viewer) === 'dimmed';
      return <BrowseRow title={card.title} subtitle={card.subtitle} detail={dim ? 'Not available' : undefined} dim={dim}
        artworks={card.artworks} glyph={card.glyph ?? '♪'} round={card.round} onPress={() => {
          recents.add(item);
          navigate(card.route);
        }} />;
    }} />;
}

function genreCard(name: string, count: number, artwork?: Artwork | null): Card {
  return {
    key: name, title: name, subtitle: plural(count, 'album'),
    route: { screen: 'genre', id: name }, artworks: artwork ? [artwork] : undefined, glyph: '♫',
  };
}

function SearchGenres({ navigate }: { navigate: BrowseProps['navigate'] }) {
  const query = useGenres();
  const genres = query.data?.slice(0, 12) ?? [];
  const art = useGenreCovers(genres.map(genre => genre.name));
  if (!query.data) return <BrowseQuery query={query} what="genres" />;
  if (!genres.length) return null;
  return <BrowseShelf title="Browse genres" cards={genres.map((genre, index) => genreCard(genre.name, genre.albumCount, art[index]?.artwork))}
    navigate={navigate} more={query.data.length > genres.length ? { label: 'See all', onPress: () => navigate({ screen: 'genres' }) } : undefined} />;
}

function Genres({ navigate }: BrowseProps) {
  const query = useGenres();
  const cards = (query.data ?? []).map(genre => genreCard(genre.name, genre.albumCount));
  return <BrowseGrid cards={cards} navigate={navigate} header={<>
    <BrowseHeader title="Genres" />
    {!query.data && <BrowseQuery query={query} what="genres" />}
  </>} />;
}

const styles = StyleSheet.create({
  feature: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 310,
    borderRadius: 25, paddingVertical: 34, paddingHorizontal: 48, gap: 50, overflow: 'hidden',
  },
  featureDetails: { flex: 1, gap: 9, alignItems: 'flex-start' },
  source: { fontSize: 22, fontWeight: '600', color: tvColors.accent },
  featureTitle: { fontSize: 70, fontWeight: '700', lineHeight: 73, letterSpacing: -2.7, color: tvColors.text },
  featureArtist: { fontSize: 30, color: tvColors.text },
  featureButton: { marginTop: 15 },
  featureBackdrop: { position: 'absolute', width: '100%', height: '135%', right: 0, top: -44, opacity: 0.43 },
  featureArt: { shadowColor: '#07060A', shadowOffset: { width: 0, height: 16 }, shadowRadius: 26, shadowOpacity: 0.62 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  homeSongs: { marginTop: 28, maxWidth: 1100 },
  filterBar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 18 },
  searchField: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18, maxWidth: 1120 },
  input: {
    flex: 1, minHeight: 66, borderWidth: 2, borderColor: tvColors.border, backgroundColor: tvColors.surface,
    borderRadius: 16, color: tvColors.text, paddingHorizontal: 21, fontSize: 28,
  },
  inputFocused: { borderColor: tvColors.accent },
});
