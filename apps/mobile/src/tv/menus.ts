import { queryKeys, type PlaylistSummary, type TrackSummary } from '@squirmy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigationContainerRef, useRouter } from 'expo-router';
import { createContext, createElement, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useAccount, useSignedInApi } from '../account/AccountProvider';
import { useRealtime } from '../data/realtime';
import { useViewer } from '../downloads/DownloadsProvider';
import { useAlbumPlayer, usePinCollection } from '../library/collectionActions';
import { collectionActions } from '../library/collectionMenu';
import type { Collection } from '../library/shared';
import { usePlaylistActions } from '../data/library';
import { useAllPlaylists } from '../data/queries';
import { pageHref, type Page } from '../library/links';
import { tabIn } from '../library/tabs';
import { trackActionKey, useTrackActions, type TrackAction, type TrackActionOptions } from '../library/trackActions';
import { playbackStatus } from '../player/usePlaybackStatus';
import type { MenuAction } from './Menu';
import { chosenPlaylist, playlistSubmenu, rowMenu } from './menuModel';

export { chosenPlaylist, playlistSubmenu, rowMenu };

/** Downloads are the phone's: the TV streams, and tvOS may clear what an app stores. */
const notOnTv = new Set<TrackAction['id']>(['download', 'retryDownload', 'removeDownload']);

const noPlaylists: PlaylistSummary[] = [];
const OwnPlaylistsContext = createContext<PlaylistSummary[]>(noPlaylists);

/**
 * The viewer's own playlists, for every menu's Add to playlist, read once for the app rather
 * than by each row that has a menu.
 */
export function OwnPlaylistsProvider({ children }: { children: ReactNode }) {
  const { state } = useAccount();
  const viewer = state.status === 'signedIn' ? state.user.id : null;
  const list = useAllPlaylists(viewer !== null);
  const own = useMemo(() => list.items.filter(playlist => playlist.ownerId === viewer), [list.items, viewer]);
  return createElement(OwnPlaylistsContext.Provider, { value: own.length ? own : noPlaylists }, children);
}

/** The viewer's own playlists, which songs can be added to, newest first as the server lists them. */
export function useOwnPlaylists(): PlaylistSummary[] {
  return useContext(OwnPlaylistsContext);
}

/**
 * Opens a page in the tab on screen, or in Home from Now Playing and Settings. The tab is read
 * when it opens, so a row holding this does not redraw as the app navigates.
 */
export function useOpenPage() {
  const router = useRouter();
  const navigation = useNavigationContainerRef();
  return useCallback((page: Page, id: string) => router.navigate(pageHref(tabIn(navigation.getRootState()), page, id)), [navigation, router]);
}

/** Adds songs to a playlist from a menu, and says in the player's status line how it went. */
export function useAddToPlaylist() {
  const playlists = usePlaylistActions();
  return (playlist: PlaylistSummary, tracks: readonly TrackSummary[], what: string) => {
    playlists.add(playlist, tracks).then(
      result => playbackStatus.report({ message: result.skipped ? `“${playlist.name}” already has ${what}` : `Added ${what} to “${playlist.name}”` }),
      () => playbackStatus.report({ message: `Couldn’t add ${what} to “${playlist.name}”` }),
    );
  };
}

/**
 * A song's context menu, the phone's song menu in the system's glass menu: play, queue, the
 * heart, a radio, its album and artist, a playlist, and removing it from the playlist it is in.
 */
export function useTrackMenu(track: TrackSummary | undefined, options: TrackActionOptions = {}): { actions: MenuAction[]; onAction: (id: string) => void } {
  // The page the song is shown on is not offered again (Go to album on its own album page).
  const base = useTrackActions(track, options).filter(action => !notOnTv.has(action.id)
    && !(action.page?.page === 'album' && action.page.id === options.album)
    && !(action.page?.page === 'artist' && action.page.id === options.artist));
  const playlists = useOwnPlaylists();
  const open = useOpenPage();
  const add = useAddToPlaylist();
  // Keyed with the page too: a song by two artists has a Go to artist for each.
  const actions: MenuAction[] = base.map(action => action.id === 'playlist'
    ? playlistSubmenu(playlists)
    : { id: trackActionKey(action), title: action.title, subtitle: action.subtitle, image: action.icon, destructive: action.destructive });
  const onAction = (id: string) => {
    if (!track) return;
    const playlist = chosenPlaylist(id, playlists);
    if (playlist) return add(playlist, [track], `“${track.title}”`);
    const action = base.find(item => trackActionKey(item) === id);
    if (!action) return;
    action.run?.();
    if (action.page) open(action.page.page, action.page.id);
  };
  return { actions, onAction };
}

/**
 * The menu of a tile: an album's (play, queue, a playlist, its artists) or Open for anything
 * else, as on the phone, with the playlists as a submenu.
 */
export function useCollectionMenu() {
  const router = useRouter();
  const { offline } = useRealtime();
  const viewer = useViewer();
  const albumPlayer = useAlbumPlayer();
  const pin = usePinCollection();
  const playlists = useOwnPlaylists();
  const add = useAddToPlaylist();
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  // The commands are read when they run, so the function changes only when what the menus show
  // does, and tiles that take it stay memoized.
  const live = useRef({ router, albumPlayer, pin, add, api, queryClient });
  live.current = { router, albumPlayer, pin, add, api, queryClient };
  return useCallback((item: Collection): { actions: MenuAction[]; onAction: (id: string) => void } => {
    const rows = collectionActions(item, { offline, viewer }, {
      playAlbum: (albumId, shuffle) => live.current.albumPlayer.play(albumId, shuffle),
      enqueueAlbum: (collection, placement) => live.current.albumPlayer.enqueue(collection.key, collection.title, placement),
      addAlbumToPlaylist: () => undefined,
      open: href => live.current.router.push(href),
      pin: (collection, pinned) => live.current.pin(collection, pinned),
    });
    // The playlists submenu stands in for the album's Add to playlist row.
    const addRow = rows.find(row => row.icon === 'text.badge.plus');
    return {
      actions: rowMenu(rows, playlists, addRow?.onPress),
      onAction: id => {
        const playlist = chosenPlaylist(id, playlists);
        if (playlist) return addAlbum(item, playlist, live.current);
        rows[Number(id)]?.onPress();
      },
    };
  }, [offline, playlists, viewer]);
}

/** Adds every song of an album to a playlist, loading the album when it is not cached. */
function addAlbum(item: Collection, playlist: PlaylistSummary, { api, queryClient, add }: {
  api: ReturnType<typeof useSignedInApi>; queryClient: ReturnType<typeof useQueryClient>; add: ReturnType<typeof useAddToPlaylist>;
}) {
  if (!api) return;
  void queryClient.ensureQueryData({ queryKey: queryKeys.album(item.key), queryFn: () => api.catalog.album(item.key) })
    .then(album => add(playlist, album.discs.flatMap(disc => disc.tracks), `“${item.title}”`),
      () => playbackStatus.report({ message: `Couldn’t add “${item.title}” to “${playlist.name}”` }));
}
