import { Stack } from 'expo-router';
import { Platform, PlatformColor } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Player from '../src/Player';
import { PlayerTransitionProvider } from '../src/player/transition';
import { PlaybackProvider } from '../src/playback';
import { screenBackground } from '../src/ui';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: screenBackground }}>
      <PlaybackProvider>
        <PlayerTransitionProvider>
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: screenBackground } }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="devices" options={sheetOptions} />
            <Stack.Screen name="track-actions" options={sheetOptions} />
          </Stack>
          <Player />
        </PlayerTransitionProvider>
      </PlaybackProvider>
    </GestureHandlerRootView>
  );
}

const sheetOptions = {
  presentation: 'formSheet',
  sheetAllowedDetents: 'fitToContents',
  sheetGrabberVisible: true,
  sheetCornerRadius: 34,
  contentStyle: { backgroundColor: Platform.OS === 'ios' ? PlatformColor('secondarySystemBackgroundColor') : '#201c29' },
} as const;
