import type { ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { Backdrop } from './Page';
import { colors, type } from './theme';

/** React Native reports the error itself; this says which part of the app it replaced. */
function logRenderError(where: string, error: unknown) {
  console.warn(`${where} hit an error and shows Try again in its place.`, error);
}

function ErrorScreen({ what, retry }: { what: string; retry: () => Promise<void> }) {
  return <View style={styles.page}>
    <Backdrop />
    <Text style={type.title2}>Something went wrong</Text>
    <Text style={styles.message}>{`Squirmy couldn’t show ${what}. Try again, or go somewhere else in the app.`}</Text>
    <Button label="Try again" icon="arrow.clockwise" onPress={() => void retry()} hasTVPreferredFocus />
  </View>;
}

/**
 * A page or tab that hit an error while drawing, in its place: the rest of the app, the other
 * tabs and the music go on. Exported by the TV's routes as their `ErrorBoundary`.
 */
export function TvPageError({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => logRenderError('A TV page', error), [error]);
  return <ErrorScreen what="this page" retry={retry} />;
}

/** What failed outside every page, such as a provider: the whole app's fallback. */
export function TvAppError({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => logRenderError('The TV app', error), [error]);
  return <ErrorScreen what="the app" retry={retry} />;
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 30, paddingHorizontal: 200 },
  message: { ...type.body, color: colors.secondary, textAlign: 'center', maxWidth: 1100 },
});
