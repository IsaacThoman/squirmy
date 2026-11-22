export type Tab = 'home' | 'library' | 'search';

type NavigationState = { index?: number; routes: readonly { name: string; state?: NavigationState }[] };

/** How deep `tabIn` looks for the tabs navigator: expo-router nests it under its own root routes. */
const maxDepth = 4;

/**
 * The tab on screen in a navigation state, wherever the tabs navigator sits in it (expo-router
 * wraps the app's stack in a `__root` route of its own). Home when there are no tabs yet.
 */
export function tabIn(state: NavigationState | undefined, depth = 0): Tab {
  const tabs = findTabs(state, depth);
  const name = tabs?.routes[tabs.index ?? 0]?.name;
  return name === '(library)' ? 'library' : name === '(search)' ? 'search' : 'home';
}

function findTabs(state: NavigationState | undefined, depth: number): NavigationState | undefined {
  if (!state || depth > maxDepth) return undefined;
  for (const route of state.routes) {
    if (route.name === '(tabs)') return route.state;
    const found = findTabs(route.state, depth + 1);
    if (found) return found;
  }
  return undefined;
}
