import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PlaybackProvider } from '../src/playback';
import { colors } from '../src/ui';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <PlaybackProvider>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="player" options={{ presentation: 'transparentModal', animation: 'slide_from_bottom', gestureEnabled: false, contentStyle: { backgroundColor: 'transparent' } }} />
          <Stack.Screen name="devices" options={sheetOptions} />
          <Stack.Screen name="track-actions" options={sheetOptions} />
          <Stack.Screen name="session" options={sheetOptions} />
        </Stack>
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
