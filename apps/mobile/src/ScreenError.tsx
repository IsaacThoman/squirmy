import { useNavigation, useRouter, type ErrorBoundaryProps } from 'expo-router';
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { closeSheet } from './closeSheet';
import { BrowseBackButton } from './library/AlbumButtons';
import { EmptyState, gutter } from './library/shared';
import { SheetAction, SheetFrame, SheetNote } from './SheetUI';
import { createThemedStyles } from './theme';

/**
 * Notes which part of the app a render error replaced. React Native reports the error itself
 * (LogBox in development, a soft exception in a release build); this says where it showed.
 */
export function logRenderError(where: string, error: unknown, componentStack?: string | null) {
  console.warn(`${where} hit an error and shows Try again in its place.`, error, ...componentStack ? [componentStack] : []);
}

/** Logs `error` once, when the fallback that replaced `where` first shows. */
function useLogged(where: string, error: unknown) {
  useEffect(() => logRenderError(where, error), [where, error]);
}

/**
 * A page that hit an error, in place of the page: the back button when there is a page to go
 * back to, as a page that failed to load has, and a way to try again. Exported by every
 * browse route as its `ErrorBoundary`, so an error in one page leaves the tabs, the other
 * pages and the player as they were.
 */
export function PageError({ error, retry }: ErrorBoundaryProps) {
  const styles = useStyles();
  const router = useRouter();
  const navigation = useNavigation();
  const { top } = useSafeAreaInsets();
  useLogged('A page', error);
  // The page's own stack: the router's root state may not have the page in it yet when the
  // error is in the page's first render, and would say there is nothing to go back to.
  const back = navigation.canGoBack();
  return <View style={[styles.page, { paddingTop: top + 8 }]}>
    {back && <View style={styles.nav}><BrowseBackButton onPress={() => router.back()} /></View>}
    <EmptyState icon="exclamationmark.triangle" title="Something went wrong"
      description={back ? 'This page hit an error. Try again, or go back.' : 'This page hit an error. Try again.'}
      action={{ title: 'Try again', onPress: () => void retry() }} />
  </View>;
}

/** A sheet that hit an error, in place of what it shows: its close button, and a way to try again. */
export function SheetError({ error, retry }: ErrorBoundaryProps) {
  const router = useRouter();
  useLogged('A sheet', error);
  return <SheetFrame title="Something went wrong" onClose={() => closeSheet(router)}>
    <SheetNote error>This hit an error. Try again, or close it.</SheetNote>
    <SheetAction title="Try again" onPress={() => void retry()} />
  </SheetFrame>;
}

/** The whole app hit an error outside any page (a layout, a provider): a way to start it again. */
export function AppError({ error, retry }: ErrorBoundaryProps) {
  const styles = useStyles();
  useLogged('The app', error);
  return <View style={[styles.page, styles.centered]}>
    <EmptyState icon="exclamationmark.triangle" title="Something went wrong"
      description="Squirmy hit an error. Try again, or close and reopen the app if it keeps happening."
      action={{ title: 'Try again', onPress: () => void retry() }} />
  </View>;
}

type BoundaryProps = {
  /** Names the part of the app, for the log. */
  where: string;
  fallback: (props: { error: unknown; retry: () => void }) => ReactNode;
  children: ReactNode;
};

/** Keeps an error in one part of the app that is not a route, such as Now Playing, from taking down the rest. */
export class ErrorBoundary extends Component<BoundaryProps, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    logRenderError(this.props.where, error, info.componentStack);
  }

  retry = () => this.setState({ error: null, failed: false });

  render() {
    return this.state.failed ? this.props.fallback({ error: this.state.error, retry: this.retry }) : this.props.children;
  }
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  centered: { justifyContent: 'center' },
  nav: { paddingHorizontal: gutter, alignItems: 'flex-start' },
}));
