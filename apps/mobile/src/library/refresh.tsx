import { useCallback, useRef, useState } from 'react';
import { Platform, RefreshControl } from 'react-native';
import { useColors } from '../theme';

/**
 * Pull to refresh for a page. It spins only for the reload the pull started, so a background
 * refetch (a socket invalidation, the app coming back) never pulls the spinner down by itself.
 * `top` is how far down the page's content starts, for pages drawn under the status bar.
 */
export function useRefreshControl(refresh: () => Promise<unknown>, top = 0) {
  const colors = useColors();
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(refresh);
  latest.current = refresh;
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void latest.current().catch(() => undefined).finally(() => setRefreshing(false));
  }, []);
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted}
    colors={[colors.accent]} progressBackgroundColor={colors.surface} progressViewOffset={top} />;
}

/**
 * Scroll view props for a page drawn under the status bar. iOS puts the refresh spinner at the
 * top of the content inset, so the status bar becomes the inset there and the spinner shows
 * below it instead of behind it. `contentTop` is what the content still has to leave itself.
 */
export function underStatusBar(top: number) {
  return Platform.OS === 'ios'
    ? { props: { contentInset: { top }, contentOffset: { x: 0, y: -top }, scrollIndicatorInsets: { top } }, contentTop: 0, inset: top }
    : { props: {}, contentTop: top, inset: 0 };
}
