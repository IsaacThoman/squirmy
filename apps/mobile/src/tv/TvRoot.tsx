import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { AccountProvider, createQueryClient, useAccount } from '../account/AccountProvider';
import { LibraryProvider } from '../data/library';
import { RealtimeProvider } from '../data/realtime';
import { DownloadsProvider } from '../downloads/DownloadsProvider';
import { PlaybackProvider } from '../playback';
import { PlayerTransitionProvider } from '../player/transition';
import { StreamingCacheProvider } from '../streamingCache/StreamingCacheProvider';
import { OwnPlaylistsProvider } from './menus';
import { RemoteTransport } from './player/RemoteTransport';
import { colors } from './theme';

// Sheets and the devices panel opened from a restored route still get the tabs beneath them.
export const unstable_settings = { anchor: '(tabs)' };

void SplashScreen.preventAutoHideAsync();

const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.background, card: colors.background } };

/** The Apple TV app: the phone app's providers, with the TV's own screens over them. */
export function TvRootLayout() {
  const [queryClient] = useState(createQueryClient);
  return <ThemeProvider value={theme}>
    <QueryClientProvider client={queryClient}>
      {/* The phone's song actions close its player through this; the TV has no such sheet to close. */}
      <PlayerTransitionProvider>
        <AccountProvider>
          <RealtimeProvider>
            <LibraryProvider>
              <DownloadsProvider>
                <StreamingCacheProvider>
                  <PlaybackProvider>
                    <OwnPlaylistsProvider>
                      <Routes />
                    </OwnPlaylistsProvider>
                  </PlaybackProvider>
                </StreamingCacheProvider>
              </DownloadsProvider>
            </LibraryProvider>
          </RealtimeProvider>
        </AccountProvider>
      </PlayerTransitionProvider>
    </QueryClientProvider>
  </ThemeProvider>;
}

/** Connect, then sign in, then the app; each step is the only one reachable until it is done. */
function Routes() {
  const { state } = useAccount();
  const restoring = state.status === 'restoring';
  const signedIn = state.status === 'signedIn';
  useEffect(() => {
    if (!restoring) SplashScreen.hide();
  }, [restoring]);
  if (restoring) return null;
  return <>
    {signedIn && <RemoteTransport />}
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: 'fade' }}>
      <Stack.Protected guard={state.status === 'connect'}>
        <Stack.Screen name="connect" />
      </Stack.Protected>
      <Stack.Protected guard={state.status === 'signIn'}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="devices" options={{ presentation: 'transparentModal', animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }} />
      </Stack.Protected>
    </Stack>
  </>;
}
