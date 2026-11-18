import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PlayerOriginProvider } from '../src/player/PlayerOrigin';
import { PlaybackProvider } from '../src/playback';
import { colors } from '../src/ui';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <PlaybackProvider>
        <PlayerOriginProvider>
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="player" options={{ presentation: 'transparentModal', animation: 'none', gestureEnabled: false, contentStyle: { backgroundColor: 'transparent' } }} />
            <Stack.Screen name="devices" options={sheetOptions} />
            <Stack.Screen name="track-actions" options={sheetOptions} />
            <Stack.Screen name="session" options={sheetOptions} />
          </Stack>
        </PlayerOriginProvider>
      </PlaybackProvider>
    </GestureHandlerRootView>
  );
}

const sheetOptions = {
  presentation: 'formSheet',
  sheetAllowedDetents: 'fitToContents',
  sheetGrabberVisible: true,
  sheetCornerRadius: 34,
  contentStyle: { backgroundColor: '#201c29' },
} as const;
