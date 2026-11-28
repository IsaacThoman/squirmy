/**
 * Links from the widgets and the Live Activity (`squirmy://album/<id>`, `squirmy://now-playing`,
 * `squirmy://downloads`). The router is told to leave them (`app/+native-intent.tsx`), and
 * `SystemSurfaces` follows them once the app is signed in. Plain logic, tested without React Native.
 */

export type WidgetPage = 'album' | 'artist' | 'playlist' | 'songs';

export type WidgetLink =
  | { kind: 'page'; page: WidgetPage; id: string }
  | { kind: 'downloads' }
  | { kind: 'nowPlaying' };

const pages = new Set<string>(['album', 'artist', 'playlist', 'songs']);

/** The link's path, without the scheme and slashes: `album/<id>`. */
function pathOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/+/, '').split(/[?#]/)[0] ?? '';
}

/** What a link from a widget opens; null for any other link. */
export function widgetLink(url: string): WidgetLink | null {
  const path = pathOf(url);
  if (path === 'now-playing') return { kind: 'nowPlaying' };
  if (path === 'downloads') return { kind: 'downloads' };
  const [page, id, ...rest] = path.split('/');
  if (!page || !id || rest.length || !pages.has(page)) return null;
  try {
    return { kind: 'page', page: page as WidgetPage, id: decodeURIComponent(id) };
  } catch {
    return null;
  }
}

/** The route for the router: none for a widget's link, which `SystemSurfaces` follows; any other link as it came. */
export function systemPath(url: string): string | null {
  return widgetLink(url) ? null : url;
}
