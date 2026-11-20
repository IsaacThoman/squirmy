import type { TrackSummary } from '@squirmy/contracts';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { HomeScreen, LibraryScreen, SearchScreen } from './Library';
import { pageHref, type Page, type Tab } from './library/links';
import { AlbumScreen, ArtistScreen, GenreScreen, PlaylistScreen } from './library/Pages';
import { useColors } from './theme';

export function BrowseStack() {
  const colors = useColors();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}

function useBrowseProps(tab: Tab) {
  const router = useRouter();
  return {
    link: (page: Page, id: string) => pageHref(tab, page, id),
    onOpen: (href: Href) => router.push(href),
    onTrackMenu: (track: TrackSummary, playlist?: { id: string; itemId: string }) => router.push({
      pathname: '/track-actions',
      params: { id: track.id, albumId: track.album?.id ?? '', playlistId: playlist?.id ?? '', itemId: playlist?.itemId ?? '' },
    }),
    onOpenDevices: () => router.push('/devices'),
    onOpenAccount: () => router.push('/account'),
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

const pages = { album: AlbumScreen, artist: ArtistScreen, playlist: PlaylistScreen, genre: GenreScreen } as const;

export function PageRoute({ tab, page }: { tab: Tab; page: Page }) {
  const props = useBrowseProps(tab);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const Screen = pages[page];
  return <Screen key={id} id={id} onBack={() => router.back()} {...props} />;
}
