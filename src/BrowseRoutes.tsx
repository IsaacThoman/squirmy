import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { AlbumScreen, HomeScreen, LibraryScreen, SearchScreen } from './Library';
import { useColors } from './theme';

type Tab = 'home' | 'library' | 'search';

export function BrowseStack() {
  const colors = useColors();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}

function useBrowseProps(tab: Tab) {
  const router = useRouter();
  return {
    onOpenAlbum: (id: string) => router.push({ pathname: `/(tabs)/(${tab})/album/[id]`, params: { id } }),
    onTrackMenu: (id: string) => router.push({ pathname: '/track-actions', params: { id } }),
    onOpenDevices: () => router.push('/devices'),
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

export function AlbumRoute({ tab }: { tab: Tab }) {
  const props = useBrowseProps(tab);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return <AlbumScreen albumId={id} onBack={() => router.back()} {...props} />;
}
