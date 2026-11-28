import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { Platform, PlatformColor } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AccountProvider, createQueryClient, useAccount } from '../src/account/AccountProvider';
import { LibraryProvider } from '../src/data/library';
import { RealtimeProvider } from '../src/data/realtime';
import { DownloadsProvider } from '../src/downloads/DownloadsProvider';
import Player from '../src/Player';
import { PlayerErrorBoundary } from '../src/player/PlayerError';
import { PlayerTransitionProvider } from '../src/player/transition';
import { PlaybackProvider } from '../src/playback';
import { noScrollEdgeEffects } from '../src/scrollEdgeEffects';
import { StreamingCacheProvider } from '../src/streamingCache/StreamingCacheProvider';
import { useAppearance, useColors } from '../src/theme';

// Sheets opened by a link or a restored route still get the tabs beneath them.
export const unstable_settings = { anchor: '(tabs)' };

// Pages and sheets have their own; this catches what fails outside them, such as a provider.
export { AppError as ErrorBoundary } from '../src/ScreenError';

// Held until the stored session and the saved lists are read, so launch never flashes the wrong screen.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const appearance = useAppearance();
  const colors = useColors();
  const theme = appearance === 'dark' ? DarkTheme : DefaultTheme;
  const [queryClient] = useState(createQueryClient);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <ThemeProvider value={theme}>
        <QueryClientProvider client={queryClient}>
          <PlayerTransitionProvider>
            <AccountProvider>
              <RealtimeProvider>
                <LibraryProvider>
                  <DownloadsProvider>
                    <StreamingCacheProvider>
                      <PlaybackProvider>
                        <StatusBar style={appearance === 'dark' ? 'light' : 'dark'} />
                        <Routes />
                      </PlaybackProvider>
                    </StreamingCacheProvider>
                  </DownloadsProvider>
                </LibraryProvider>
              </RealtimeProvider>
            </AccountProvider>
          </PlayerTransitionProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

/** Connect, then sign in, then the app. Each step is the only one reachable until it is done. */
function Routes() {
  const colors = useColors();
  const { state } = useAccount();
  const restoring = state.status === 'restoring';
  const signedIn = state.status === 'signedIn';
  const sheetBackground = Platform.OS === 'ios' ? PlatformColor('secondarySystemBackgroundColor') : colors.sheet;
  const sheet = { ...sheetOptions, contentStyle: { backgroundColor: sheetBackground } };

  useEffect(() => {
    if (!restoring) SplashScreen.hide();
  }, [restoring]);

  if (restoring) return null;
  return <>
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, scrollEdgeEffects: noScrollEdgeEffects }}>
      <Stack.Protected guard={state.status === 'connect'}>
        <Stack.Screen name="connect" options={authOptions} />
      </Stack.Protected>
      <Stack.Protected guard={state.status === 'signIn'}>
        <Stack.Screen name="sign-in" options={authOptions} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" options={authOptions} />
        <Stack.Screen name="devices" options={sheet} />
        <Stack.Screen name="listen-together" options={sheet} />
        <Stack.Screen name="track-actions" options={sheet} />
        <Stack.Screen name="track-info" options={sheet} />
        <Stack.Screen name="add-to-playlist" options={sheet} />
        <Stack.Screen name="account" options={sheet} />
        <Stack.Screen name="settings" options={{ ...sheet, sheetAllowedDetents: [0.92] }} />
        <Stack.Screen name="downloads" options={{ ...sheet, sheetAllowedDetents: [0.92] }} />
        <Stack.Screen name="name-playlist" options={sheet} />
        <Stack.Protected guard={__DEV__}>
          <Stack.Screen name="dev/engine" options={{ presentation: 'modal' }} />
        </Stack.Protected>
      </Stack.Protected>
    </Stack>
    {signedIn && <PlayerErrorBoundary><Player /></PlayerErrorBoundary>}
  </>;
}

const authOptions = { animation: 'fade' } as const;

const sheetOptions = {
  presentation: 'formSheet',
  sheetAllowedDetents: 'fitToContents',
  sheetGrabberVisible: true,
  sheetCornerRadius: 34,
} as const;
