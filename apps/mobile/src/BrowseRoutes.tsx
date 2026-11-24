import type { TrackSummary } from '@squirmy/contracts';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { HomeScreen, LibraryScreen, SearchScreen } from './Library';
import { pageHref, type Page, type Tab } from './library/links';
import { AlbumScreen, ArtistScreen, GenreScreen, PlaylistScreen, ReleasesScreen, SongsScreen } from './library/Pages';
import { useTabChrome } from './tabChrome';
import { TabBarEdge } from './TabBarEdge';
import { useColors } from './theme';

export function BrowseStack() {
  const colors = useColors();
  const { edgeHeight } = useTabChrome();
  // The edge sits over every page of the tab, not in each one, so it stays put under the
  // bars while pages push and zoom beneath it.
  return <View style={styles.stack}>
    <Stack screenOptions={{
      headerShown: false,
      contentStyle: { backgroundColor: colors.background },
      // The browse pages draw their own top edge. An automatic edge can tint the same area.
      scrollEdgeEffects: { top: 'hidden' },
    }} />
    <TabBarEdge height={edgeHeight} />
  </View>;
}

function useBrowseProps(tab: Tab) {
  const router = useRouter();
  const { contentInset } = useTabChrome();
  return {
    bottomInset: contentInset,
    link: (page: Page, id: string) => pageHref(tab, page, id),
    onOpen: (href: Href) => router.push(href),
    onTrackMenu: (track: TrackSummary, playlist?: { id: string; itemId: string }) => router.push({
      pathname: '/track-actions',
      params: { id: track.id, albumId: track.album?.id ?? '', playlistId: playlist?.id ?? '', itemId: playlist?.itemId ?? '' },
    }),
    onOpenDevices: () => router.push('/devices'),
    onOpenAccount: () => router.push('/account'),
    onOpenDownloads: () => router.push('/downloads'),
  };
}

export function BrowseIndex({ tab }: { tab: Tab }) {
  const props = useBrowseProps(tab);
  switch (tab) {
    case 'home': return <HomeScreen {...props} />;
    case 'library': return <LibraryScreen {...props} />;
    case 'search': return <SearchScreen {...props} />;
  }
}

const pages = {
  album: AlbumScreen, artist: ArtistScreen, playlist: PlaylistScreen, genre: GenreScreen, releases: ReleasesScreen, songs: SongsScreen,
} as const;

export function PageRoute({ tab, page }: { tab: Tab; page: Page }) {
  const props = useBrowseProps(tab);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const Screen = pages[page];
  return <Screen key={id} id={id} onBack={() => router.back()} {...props} />;
}

const styles = StyleSheet.create({ stack: { flex: 1 } });
