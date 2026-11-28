import { Stack, Tabs, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { pageHref, useCurrentTab, type Page, type Tab } from '../library/links';
import { HomeScreen } from './screens/Home';
import { LibraryScreen } from './screens/Library';
import { SearchScreen } from './screens/Search';
import { AlbumPage } from './pages/Album';
import { ArtistPage } from './pages/Artist';
import { GenrePage } from './pages/Genre';
import { PlaylistPage } from './pages/Playlist';
import { ReleasesPage } from './pages/Releases';
import { SongsPage } from './pages/Songs';
import { SidebarProvider, sidebarTabs } from './Sidebar';
import { colors } from './theme';

/**
 * The tabs, in a sidebar like the system's media apps' (see `Sidebar`): each tab's first screen
 * draws the sidebar's pill and panel itself, so there is no tab bar here.
 */
export function TvTabs() {
  return <SidebarProvider>
    <View style={styles.fill}>
      <Tabs backBehavior="history" tabBar={noTabBar}
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background }, animation: 'fade' }}>
        {sidebarTabs.map(item => <Tabs.Screen key={item.route} name={item.route} options={{ title: item.label }} />)}
      </Tabs>
    </View>
  </SidebarProvider>;
}

/** A tab's pages. Menu goes back a page, with the system's own transition. */
export function TvBrowseStack() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}

/** What a screen needs to open pages in its own tab. */
export type Navigate = { open: (page: Page, id: string) => void; tab: Tab };

export function useNavigate(): Navigate {
  const router = useRouter();
  const tab = useCurrentTab();
  const open = useCallback((page: Page, id: string) => router.push(pageHref(tab, page, id)), [router, tab]);
  return { open, tab };
}

export function TvTabIndex({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'home': return <HomeScreen />;
    case 'library': return <LibraryScreen />;
    case 'search': return <SearchScreen />;
  }
}

const pages = { album: AlbumPage, artist: ArtistPage, playlist: PlaylistPage, genre: GenrePage, releases: ReleasesPage, songs: SongsPage } as const;

export function TvPageRoute({ page }: { page: Page }) {
  const { id } = useLocalSearchParams<{ id: string }>();
  const Screen = pages[page];
  return <Screen key={id} id={id} />;
}

const noTabBar = () => null;

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: colors.background } });
