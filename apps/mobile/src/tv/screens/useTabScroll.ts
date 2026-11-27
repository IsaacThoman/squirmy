import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, type ComponentRef, type RefObject } from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import { useSidebarChrome } from '../Sidebar';

/** How far a page scrolls before the sidebar's pill makes way for it. */
const scrolledAfter = 40;

/** A tab's first page: a list, or a plain scroll view. */
type Scrollable = Pick<FlatList<unknown>, 'scrollToOffset'> | Pick<ComponentRef<typeof ScrollView>, 'scrollTo'>;

/**
 * Tells the sidebar how far a tab's first page has scrolled, so its pill makes way, and lets
 * Menu scroll the page back to its top before it opens the sidebar. Only while the tab is on
 * screen: every tab's first page stays mounted, so leaving it hands both back, and a tab that
 * does not scroll is never taken for scrolled. Returns the page's `onScroll`.
 */
export function useTabScroll(list: RefObject<Scrollable | null>) {
  const chrome = useSidebarChrome();
  const scrolled = useRef(false);
  const onScreen = useRef(false);
  useFocusEffect(useCallback(() => {
    onScreen.current = true;
    chrome?.setScrolled(scrolled.current);
    chrome?.setScrollToTop(() => {
      const view = list.current;
      if (view && 'scrollToOffset' in view) view.scrollToOffset({ offset: 0, animated: true });
      else view?.scrollTo({ y: 0, animated: true });
    });
    return () => {
      onScreen.current = false;
      chrome?.setScrollToTop(null);
      chrome?.setScrolled(false);
    };
  }, [chrome, list]));
  return useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const now = event.nativeEvent.contentOffset.y > scrolledAfter;
    if (now === scrolled.current) return;
    scrolled.current = now;
    if (onScreen.current) chrome?.setScrolled(now);
  }, [chrome]);
}
