import { releaseSubtitle, type Viewer } from '@squirmy/client-core';
import type {
  AlbumSummary, ArtistSummary, Artwork, HomeResponse, LibraryItem, PlaybackContext, PlaylistSummary, QueueEntry, TrackSummary,
} from '@squirmy/contracts';
import { NOT_DOWNLOADED_LABEL, unavailableReason } from '../downloads/model';
import { pendingQueueRow, queueRow } from '../player/session';

export type CarPlayLimits = {
  maximumItems: number;
  maximumSections: number;
  maximumTabCount: number;
  maximumImageRowItems: number;
  listImagePixels?: number;
  imageRowImagePixels?: number;
  headerImagePixels?: number;
};

type CarPlayImage = { id: string; title: string; imageUrl?: string };
export type CarPlayRow = {
  id: string;
  title: string;
  detail?: string;
  imageUrl?: string;
  icon?: string;
  enabled?: boolean;
  playing?: boolean;
  disclosure?: boolean;
  images?: CarPlayImage[];
};

export type CarPlayList = {
  id: string;
  title: string;
  tabIcon?: string;
  sections: { title?: string; items: CarPlayRow[] }[];
  emptyTitle?: string;
  emptyDetail?: string;
  loading?: boolean;
  header?: { title: string; detail?: string; imageUrl?: string; actionIds: string[] };
};

export type BrowseRoute =
  | { type: 'album' | 'playlist'; id: string; title: string; downloaded?: boolean }
  | { type: 'artist'; id: string; title: string }
  | { type: 'liked'; title: string; downloaded?: boolean }
  | { type: 'downloaded-songs'; title: string };

type PlayAction = {
  type: 'play';
  tracks: readonly TrackSummary[];
  options: { start?: number; shuffle?: boolean; context: PlaybackContext };
  loadTracks?: () => Promise<readonly TrackSummary[]>;
};

export type BrowseAction = PlayAction
  | { type: 'open'; route: BrowseRoute }
  | { type: 'radio'; artistId: string }
  | { type: 'queue'; entryId: string }
  | { type: 'run'; run: () => void | Promise<void> };

export type BrowsePage = { list: CarPlayList; actions: Record<string, BrowseAction> };

export type BrowsePresentation = {
  limits: CarPlayLimits;
  offline: boolean;
  viewer: Viewer | null;
  currentTrackId?: string;
  canPlay: (track: TrackSummary) => boolean;
  /** Collection metadata can be browsed offline when its music is on the phone. */
  canOpen: (route: BrowseRoute) => boolean;
  artwork: (artwork: Artwork | null | undefined, placement?: 'rail' | 'header') => string | undefined;
};

type Row = {
  item: CarPlayRow;
  artwork?: Artwork | null;
  action?: BrowseAction;
  children?: Row[];
};

type Section = { title?: string; rows: Row[] };
type ListHeader = Pick<CarPlayList, 'id' | 'title' | 'tabIcon'>;

export const homeTab = { id: 'home', title: 'Home', tabIcon: 'music.note.house' };
export const libraryTab = { id: 'library', title: 'Library', tabIcon: 'music.note.square.stack' };
export const downloadsTab = { id: 'downloads', title: 'Downloads', tabIcon: 'arrow.down.circle' };
const queueHeader = { id: 'up-next', title: 'Up Next' };
export const signInMessage = 'Open Squirmy on your iPhone to sign in.';
export const offlineMessage = 'Check your connection to the server.';

export function routeHeader(route: BrowseRoute): ListHeader {
  const id = 'id' in route ? `${route.type}:${route.id}` : route.type;
  return { id: 'downloaded' in route && route.downloaded ? `downloaded:${id}` : id, title: route.title };
}

/** Keep lists short enough to scan and respect head units with stricter limits. */
export function itemLimit(limits: CarPlayLimits): number {
  return Math.max(1, Math.min(limits.maximumItems, 24));
}

function sectionLimit(limits: CarPlayLimits): number {
  return Math.max(1, limits.maximumSections);
}

function page(
  header: ListHeader,
  sections: Section[],
  presentation: BrowsePresentation,
  empty: { title: string; detail?: string } = { title: 'Nothing here yet' },
): BrowsePage {
  const actions: BrowsePage['actions'] = {};
  let remaining = itemLimit(presentation.limits);
  const visibleSections = sections.filter(section => section.rows.length).slice(0, sectionLimit(presentation.limits)).flatMap(section => {
    const rows = section.rows.slice(0, remaining);
    remaining -= rows.length;
    if (!rows.length) return [];
    const items = rows.map(({ item, action, artwork, children }) => {
      if (action && item.enabled !== false) actions[item.id] = action;
      if (!children) return { ...item, imageUrl: presentation.artwork(artwork) };
      const images = children.map(child => {
        if (child.action && child.item.enabled !== false) actions[child.item.id] = child.action;
        return { id: child.item.id, title: child.item.title, imageUrl: presentation.artwork(child.artwork, 'rail') };
      });
      return { ...item, images };
    });
    return [{ title: section.title, items }];
  });
  return {
    list: { ...header, sections: visibleSections, emptyTitle: empty.title, emptyDetail: empty.detail },
    actions,
  };
}

export function messagePage(
  header: ListHeader,
  title: string,
  detail?: string,
  retry?: () => void | Promise<void>,
): BrowsePage {
  const retryId = 'retry';
  return {
    list: {
      ...header,
      sections: retry ? [{ items: [
        { id: 'status', title, detail, enabled: false },
        { id: retryId, title: 'Try Again', icon: 'arrow.clockwise' },
      ] }] : [],
      emptyTitle: title,
      emptyDetail: detail,
    },
    actions: retry ? { [retryId]: { type: 'run', run: retry } } : {},
  };
}

export function loadingPage(route: BrowseRoute): BrowsePage {
  const page = messagePage(routeHeader(route), 'Loading…');
  page.list.loading = true;
  return page;
}

type Paging = {
  offset: number;
  onPage: (offset: number) => void | Promise<void>;
  hasMore?: boolean;
};

/** At most one template is needed to page through a long list. The navigation rows keep
 * a fixed budget so the forward and back buttons always land on the same boundaries. */
export function pageSize(limits: CarPlayLimits, controls = 0): number {
  return Math.max(1, itemLimit(limits) - controls - 2);
}

export function pageOffset(offset: number, count: number, size: number): number {
  return offset < count ? offset : Math.floor(Math.max(0, count - 1) / size) * size;
}

function pageRows(rows: Row[], ui: BrowsePresentation, paging: Paging, controls: Row[] = []): Row[] {
  if (itemLimit(ui.limits) < 3) return [...controls, ...rows].slice(0, itemLimit(ui.limits));
  const size = pageSize(ui.limits, controls.length);
  const offset = pageOffset(paging.offset, rows.length, size);
  const end = offset + size;
  const nav = (id: string, title: string, icon: string, to: number): Row => ({
    item: { id, title, icon },
    action: { type: 'run', run: () => paging.onPage(to) },
  });
  const back = offset > 0 ? [nav('previous-page', 'Previous', 'chevron.up', Math.max(0, offset - size))] : [];
  const more = end < rows.length || paging.hasMore ? [nav('next-page', 'More', 'chevron.down', Math.min(end, rows.length))] : [];
  return [...controls, ...back, ...rows.slice(offset, end), ...more];
}

function allRows(rows: Row[], ui: BrowsePresentation, paging: Paging, controls: Row[] = []): Row[] {
  if (rows.length + controls.length <= itemLimit(ui.limits) && !paging.hasMore && paging.offset === 0) return [...controls, ...rows];
  return pageRows(rows, ui, paging, controls);
}

function routeRow(route: BrowseRoute, id: string, detail: string, icon: string, artwork: Artwork | null | undefined, ui: BrowsePresentation): Row {
  const enabled = ui.canOpen(route);
  return {
    item: { id, title: route.title, detail: enabled ? detail : NOT_DOWNLOADED_LABEL, icon, enabled, disclosure: enabled },
    artwork, action: { type: 'open', route },
  };
}

function albumRow(album: AlbumSummary, id: string, ui: BrowsePresentation, detail = album.artistCredit): Row {
  return routeRow({ type: 'album', id: album.id, title: album.title }, id, detail, 'music.note', album.artwork, ui);
}

function artistRow(artist: ArtistSummary, id: string, ui: BrowsePresentation): Row {
  return routeRow({ type: 'artist', id: artist.id, title: artist.name }, id, 'Artist', 'person.crop.circle', artist.image, ui);
}

function playlistRow(playlist: PlaylistSummary, id: string, ui: BrowsePresentation): Row {
  return routeRow({ type: 'playlist', id: playlist.id, title: playlist.name }, id, 'Playlist', 'music.note.list', playlist.artworks[0], ui);
}

function trackRows(
  prefix: string,
  tracks: readonly TrackSummary[],
  context: PlaybackContext,
  ui: BrowsePresentation,
  loadTracks?: PlayAction['loadTracks'],
): Row[] {
  return tracks.map((track, start) => {
    const enabled = ui.canPlay(track);
    return {
      item: {
        id: `${prefix}:${track.id}:${start}`, title: track.title, icon: 'music.note',
        detail: enabled ? track.artistCredit : unavailableReason(track, ui.offline, ui.viewer),
        enabled, playing: track.id === ui.currentTrackId,
      },
      artwork: track.album?.artwork,
      action: { type: 'play', tracks, options: { start, context }, loadTracks },
    };
  });
}

export function homePage(home: HomeResponse, ui: BrowsePresentation): BrowsePage {
  const groups = home.sections.flatMap(section => {
    const idFor = (id: string) => `home:${section.id}:${id}`;
    let rows: Row[];
    switch (section.kind) {
      case 'albums': rows = section.albums.map(album => albumRow(album, idFor(album.id), ui)); break;
      case 'artists': rows = section.artists.map(artist => artistRow(artist, idFor(artist.id), ui)); break;
      case 'playlists': rows = section.playlists.map(playlist => playlistRow(playlist, idFor(playlist.id), ui)); break;
      case 'tracks': rows = trackRows(idFor('song'), section.tracks, { type: 'other', id: section.id, title: section.title }, ui); break;
    }
    return rows.length ? [{ id: section.id, title: section.title, rows }] : [];
  }).slice(0, Math.min(sectionLimit(ui.limits), itemLimit(ui.limits)));
  const rowsPerSection = Math.max(1, Math.min(4, Math.floor(itemLimit(ui.limits) / Math.max(1, groups.length))));
  const sections = groups.map(({ id, title, rows }) => {
    const children = rows.slice(0, ui.limits.maximumImageRowItems);
    // A native image row has one enabled state for the whole row, and no playing marker.
    const canUseRail = children.length > 1 && children.every(child => child.item.enabled !== false && !child.item.playing)
      && children.some(child => child.artwork);
    return canUseRail
      ? { rows: [{ item: { id: `rail:${id}`, title }, children }] }
      : { title, rows: rows.slice(0, rowsPerSection) };
  });
  return page(homeTab, sections, ui, { title: 'No music yet' });
}

export function libraryPage(items: readonly LibraryItem[], ui: BrowsePresentation, paging: Paging): BrowsePage {
  const rows = items.map((item): Row => {
    switch (item.kind) {
      case 'liked': return routeRow({ type: 'liked', title: 'Liked Songs' }, 'liked', 'Playlist', 'heart.fill', null, ui);
      case 'album': return albumRow(item.album, `album:${item.album.id}`, ui);
      case 'artist': return artistRow(item.artist, `artist:${item.artist.id}`, ui);
      case 'playlist': return playlistRow(item.playlist, `playlist:${item.playlist.id}`, ui);
    }
  });
  return page(libraryTab, [{ rows: allRows(rows, ui, paging) }], ui, { title: 'Your library is empty' });
}

export type DownloadCollection = { route: BrowseRoute; detail: string; artwork?: Artwork };
const downloadIcon: Record<BrowseRoute['type'], string> = {
  album: 'music.note', playlist: 'music.note.list', artist: 'person.crop.circle', liked: 'heart.fill', 'downloaded-songs': 'music.note',
};

export function downloadsPage(collections: readonly DownloadCollection[], ui: BrowsePresentation, paging: Paging): BrowsePage {
  const rows = collections.map(({ route, detail, artwork }) =>
    routeRow(route, routeHeader(route).id, detail, downloadIcon[route.type], artwork, ui));
  return page(downloadsTab, [{ rows: allRows(rows, ui, paging) }], ui, { title: 'No downloads yet' });
}

export function songsPage(
  route: BrowseRoute,
  tracks: readonly TrackSummary[],
  context: PlaybackContext,
  ui: BrowsePresentation,
  paging: Paging,
  { loadTracks, subtitle, artwork }: { loadTracks?: PlayAction['loadTracks']; subtitle?: string; artwork?: Artwork | null } = {},
): BrowsePage {
  const controls = ui.limits.maximumItems >= 5 && tracks.some(ui.canPlay) ? [
    { item: { id: 'play', title: 'Play', icon: 'play.fill' }, action: { type: 'play', tracks, options: { shuffle: false, context }, loadTracks } },
    { item: { id: 'shuffle', title: 'Shuffle', icon: 'shuffle' }, action: { type: 'play', tracks, options: { shuffle: true, context }, loadTracks } },
  ] satisfies Row[] : [];
  const header = routeHeader(route);
  const result = page(header, [{ rows: allRows(trackRows('song', tracks, context, ui, loadTracks), ui, paging, controls) }], ui,
    { title: 'No songs yet' });
  if (controls.length && route.type !== 'downloaded-songs') {
    result.list.header = { title: header.title, detail: subtitle, imageUrl: ui.artwork(artwork, 'header'), actionIds: controls.map(row => row.item.id) };
  }
  return result;
}

export function artistPage(
  route: Extract<BrowseRoute, { type: 'artist' }>,
  artist: { id: string; name: string; radio?: boolean; topTracks: readonly TrackSummary[]; albums: readonly AlbumSummary[] },
  ui: BrowsePresentation,
  paging: Paging,
): BrowsePage {
  const radio: Row[] = artist.radio && !ui.offline ? [
    { item: { id: 'radio', title: 'Start Station', icon: 'radio' }, action: { type: 'radio', artistId: artist.id } },
  ] : [];
  const top = trackRows('top', artist.topTracks, { type: 'artist', id: artist.id, title: artist.name }, ui);
  const albums = artist.albums.map(album => albumRow(album, `album:${album.id}`, ui, releaseSubtitle(album)));
  // Leave room for a release as well as the station and top songs on smaller displays.
  const preview = top.slice(0, Math.max(1, Math.min(5, itemLimit(ui.limits) - radio.length - (albums.length ? 3 : 0))));
  const combined = !albums.length || sectionLimit(ui.limits) < 3 || itemLimit(ui.limits) < 6;
  const sections = combined
    ? [{ rows: allRows([...radio, ...top, ...albums], ui, paging) }]
    : [
      { rows: radio }, { title: ui.offline ? 'Songs' : 'Top Songs', rows: preview },
      { title: 'Releases', rows: allRows(albums, ui, paging, [...radio, ...preview]).slice(radio.length + preview.length) },
    ];
  return page({ ...routeHeader(route), title: artist.name }, sections, ui, { title: 'No songs or releases yet' });
}

export function queuePage({
  entries, current, tracks, presentation: ui, offset, onPage,
}: {
  entries: readonly QueueEntry[];
  current: QueueEntry | null;
  tracks: ReadonlyMap<string, TrackSummary>;
  presentation: BrowsePresentation;
  offset: number;
  onPage: Paging['onPage'];
}): BrowsePage {
  const row = (entry: QueueEntry, playing: boolean): Row => {
    const track = tracks.get(entry.id);
    const pending = pendingQueueRow(ui.offline);
    const { detail, unavailable } = queueRow(entry, track, { playable: track ? ui.canPlay(track) : !ui.offline, offline: ui.offline, viewer: ui.viewer });
    return {
      item: { id: entry.id, title: track?.title ?? pending.title, detail: detail || pending.detail, icon: 'music.note',
        playing, enabled: !playing && !unavailable && Boolean(track) },
      artwork: track?.album?.artwork,
      action: { type: 'queue', entryId: entry.id },
    };
  };
  const upcoming = entries.filter(entry => entry.id !== current?.id);
  const now = current && (itemLimit(ui.limits) >= 4 || upcoming.length === 0) ? [row(current, true)] : [];
  const rows = allRows(upcoming.map(entry => row(entry, false)), ui, { offset, onPage }, now);
  const visible = now.length ? rows.slice(1) : rows;
  const twoSections = now.length > 0 && sectionLimit(ui.limits) > 1;
  return page(queueHeader, twoSections ? [{ title: 'Now Playing', rows: now }, { title: 'Up Next', rows: visible }] : [{ rows: [...now, ...visible] }],
    ui, { title: 'Nothing queued' });
}
