import { useRootNavigationState, type Href } from 'expo-router';
import { tabIn, type Tab } from './tabs';

export type { Tab };
export type Page = 'album' | 'artist' | 'playlist' | 'genre';

/** A page inside a tab's own stack, so it opens over that tab and goes back to it. */
export function pageHref(tab: Tab, page: Page, id: string): Href {
  return { pathname: `/(tabs)/(${tab})/${page}/[id]`, params: { id } } as Href;
}

/** The tab on screen, also from a sheet or Now Playing above it. */
export function useCurrentTab(): Tab {
  return tabIn(useRootNavigationState());
}

/** Links to pages in the current tab. */
export function usePageLinks() {
  const tab = useCurrentTab();
  return (page: Page, id: string) => pageHref(tab, page, id);
}
