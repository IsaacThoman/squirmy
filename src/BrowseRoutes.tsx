import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Platform } from 'react-native';
import { AlbumScreen, HomeScreen, LibraryScreen, SearchScreen } from './Library';
import { useColors } from './theme';

type Tab = 'home' | 'library' | 'search';

export function BrowseStack() {
  const colors = useColors();
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="album/[id]" options={Platform.OS === 'ios' ? {
        // Keep the time before another collection can open bounded by the short slide.
        animation: 'simple_push',
        animationDuration: 180,
        fullScreenGestureEnabled: true,
        gestureResponseDistance: { end: 40 },
        animationMatchesGesture: true,
      } : undefined} />
    </Stack>
  );
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
