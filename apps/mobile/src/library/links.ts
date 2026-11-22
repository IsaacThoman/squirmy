import { useRootNavigationState, type Href } from 'expo-router';

export type Tab = 'home' | 'library' | 'search';
export type Page = 'album' | 'artist' | 'playlist' | 'genre';

/** A page inside a tab's own stack, so it opens over that tab and goes back to it. */
export function pageHref(tab: Tab, page: Page, id: string): Href {
  return { pathname: `/(tabs)/(${tab})/${page}/[id]`, params: { id } } as Href;
}

type NavigationState = { routes: readonly { name: string; state?: NavigationState }[]; index?: number } | undefined;

/** The tab navigator's state, however deep it sits. */
function tabsIn(state: NavigationState): NavigationState {
  for (const route of state?.routes ?? []) {
    if (route.name === '(tabs)') return route.state;
    const inner = tabsIn(route.state);
    if (inner) return inner;
  }
  return undefined;
}

/** The tab on screen in a navigation state. */
export function tabOf(state: NavigationState): Tab {
  const tabs = tabsIn(state);
  const name = tabs?.routes[tabs.index ?? 0]?.name;
  return name === '(library)' ? 'library' : name === '(search)' ? 'search' : 'home';
}

/** The tab on screen, also from a sheet or Now Playing above it. */
export function useCurrentTab(): Tab {
  return tabOf(useRootNavigationState());
}

/** Links to pages in the current tab. */
export function usePageLinks() {
  const tab = useCurrentTab();
  return (page: Page, id: string) => pageHref(tab, page, id);
}
