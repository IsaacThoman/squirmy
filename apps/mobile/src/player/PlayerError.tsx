import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmptyState } from '../library/shared';
import { ErrorBoundary } from '../ScreenError';
import { createThemedStyles } from '../theme';
import { CollapseButton } from './Controls';
import { usePlayerTransition } from './transition';
import { usePlayerShown } from './visibility';

/**
 * Keeps an error in Now Playing to Now Playing. Music goes on, and the mini-player and the
 * pages stay as they were; opening the player shows the error with a way to try again.
 */
export function PlayerErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary where="Now Playing" fallback={({ retry }) => <PlayerError retry={retry} />}>{children}</ErrorBoundary>;
}

/**
 * In place of Now Playing while it is open: the grabber to close it, and Try again. Closed,
 * it draws nothing and lets every touch through, as the player does. Closing tries again
 * too, so the next time it opens it is the player, if the error has passed.
 */
function PlayerError({ retry }: { retry: () => void }) {
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  const { close } = usePlayerTransition();
  const shown = usePlayerShown();
  if (!shown) return null;
  return <View style={[StyleSheet.absoluteFill, styles.page, { paddingTop: top }]} aria-modal>
    <View style={styles.grabber}><CollapseButton onPress={() => { close(); retry(); }} /></View>
    <EmptyState icon="exclamationmark.triangle" title="Something went wrong"
      description="Now Playing hit an error. Try again, or close it; the music goes on." action={{ title: 'Try again', onPress: retry }} />
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  page: { backgroundColor: colors.background },
  grabber: { alignItems: 'center' },
}));
