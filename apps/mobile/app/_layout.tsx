import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { Platform, PlatformColor } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Player from '../src/Player';
import { PlayerTransitionProvider } from '../src/player/transition';
import { PlaybackProvider } from '../src/playback';
import { useAppearance, useColors } from '../src/theme';

export default function RootLayout() {
  const appearance = useAppearance();
  const colors = useColors();
  const theme = appearance === 'dark' ? DarkTheme : DefaultTheme;
  const sheetBackground = Platform.OS === 'ios' ? PlatformColor('secondarySystemBackgroundColor') : colors.sheet;
  const sheet = { ...sheetOptions, contentStyle: { backgroundColor: sheetBackground } };

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <ThemeProvider value={theme}>
        <PlaybackProvider>
          <PlayerTransitionProvider>
            <StatusBar style={appearance === 'dark' ? 'light' : 'dark'} />
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="devices" options={sheet} />
              <Stack.Screen name="track-actions" options={sheet} />
            </Stack>
            <Player />
          </PlayerTransitionProvider>
        </PlaybackProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const sheetOptions = {
  presentation: 'formSheet',
  sheetAllowedDetents: 'fitToContents',
  sheetGrabberVisible: true,
  sheetCornerRadius: 34,
} as const;
