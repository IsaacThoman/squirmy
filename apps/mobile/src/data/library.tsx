import { TrackStore } from '@squirmy/client-core';
import {
  queryKeys, type AlbumDetail, type LibraryEntityType, type LikeEntityType, type Page, type PlaylistDetail, type PlaylistSummary, type TrackSummary,
  type WantEntityType,
} from '@squirmy/contracts';
import { useMutation, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren,
} from 'react';
import { useAccountKey, useSignedInApi, type Api } from '../account/AccountProvider';
import { useNotice } from '../Notice';
import { accountItem } from './accountStorage';
import { LikeQueue, type QueuedLike } from './likeQueue';
import { findTrack, patchEntity, withLikedTrack } from './likePatch';
import { useRealtime } from './realtime';

type LikeKey = `${LikeEntityType}:${string}`;
type SaveKey = `${LibraryEntityType}:${string}`;

type LibraryValue = {
  tracks: TrackStore;
  /** Likes changed here (or on another device) since the screens' data was loaded. */
  likes: ReadonlyMap<LikeKey, boolean>;
  setLiked: (type: LikeEntityType, id: string, liked: boolean) => void;
  want: (type: WantEntityType, id: string, title: string) => void;
  /** Library additions and removals made here that the screens' data may not show yet. */
  saves: ReadonlyMap<SaveKey, boolean>;
  /** Adds to or removes from the user's library, showing it at once; a refusal sets it back with a notice. */
  setSaved: (type: LibraryEntityType, id: string, saved: boolean, title: string) => void;
};

const LibraryContext = createContext<LibraryValue | null>(null);

const noSummaries = () => Promise.reject(new Error('Signed out'));
/** Likes the server could not take (a 5xx, a dropped request) are sent again after this, then twice as long each time. */
const retryFirstMs = 15_000;
const retryMaxMs = 4 * 60_000;
const likedTracksKey = [...queryKeys.likes(), 'track'];

/**
 * Shows a like everywhere at once: every cached answer that carries the item gets the new
 * flag, and Liked Songs gains or loses the track, so nothing has to be fetched again.
 */
function patchLike(queryClient: QueryClient, type: LikeEntityType, id: string, liked: boolean) {
  const queries = queryClient.getQueryCache().getAll();
  for (const query of queries) {
    const data = query.state.data;
    const patched = patchEntity(data, id, { liked });
    // Keeps the time the data was loaded, so the patch does not make old data look fresh.
    if (patched !== data) queryClient.setQueryData(query.queryKey, patched, { updatedAt: query.state.dataUpdatedAt });
  }
  if (type !== 'track') return;
  const list = queryClient.getQueryState(likedTracksKey);
  if (!list?.data) return;
  let track: TrackSummary | undefined;
  for (const query of queries) if (liked && !track) track = findTrack(query.state.data, id);
  if (liked && !track) {
    void queryClient.invalidateQueries({ queryKey: likedTracksKey, refetchType: 'none' });
    return;
  }
  queryClient.setQueryData<InfiniteData<Page<TrackSummary>>>(likedTracksKey,
    data => data && withLikedTrack(data, id, track ?? null), { updatedAt: list.dataUpdatedAt });
}

/**
 * What the user keeps: likes, the wantlist and the track summaries every screen shares.
 * Likes apply at once. Made offline, they wait in a queue (kept across launches) and are
 * sent when the server is back; one the server refuses rolls back.
 */
export function LibraryProvider({ children }: PropsWithChildren) {
  const api = useSignedInApi();
  const account = useAccountKey();
  const queryClient = useQueryClient();
  const notify = useNotice();
  const { onInvalidate, offline, expectEcho } = useRealtime();
  // One store per account, reading the current client: a new client (a token or server
  // update) must not drop the cached summaries or rebuild what is built on the store.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  const tracks = useMemo(() => new TrackStore(body => apiRef.current?.catalog.trackSummaries(body) ?? noSummaries()), [account]);
  const queue = useMemo(() => api && account ? new LikeQueue(likeStorage(account), async ({ type, id, liked }) => {
    // The server tells this phone too; it already shows the change, so that echo is not refetched.
    expectEcho([type, id]);
    await (liked ? api.userdata.like(type, id) : api.userdata.unlike(type, id));
  }) : null, [account, api, expectEcho]);
  const [likes, setLikes] = useState<ReadonlyMap<LikeKey, boolean>>(new Map());
  useEffect(() => setLikes(new Map(queue?.pending.map(like => [`${like.type}:${like.id}`, like.liked] as const))), [queue]);

  const remember = useCallback((key: LikeKey, liked: boolean | undefined) => setLikes(current => {
    const next = new Map(current);
    if (liked === undefined) next.delete(key);
    else next.set(key, liked);
    return next;
  }), []);

  // Another device changed a like: the pages refetch on their own, so only the cached
  // track summaries (queue rows, Now Playing) need the new value, and what this device
  // remembered for albums and artists gives way to the server's.
  useEffect(() => onInvalidate((keys, { own }) => {
    if (own) return;
    for (const [root, id] of keys) {
      if (typeof id !== 'string') continue;
      if (root === 'track' && api) {
        api.catalog.track(id).then(track => {
          tracks.prime([track]);
          remember(`track:${id}`, track.liked);
        }, () => undefined);
      } else if (root === 'album' || root === 'artist') {
        remember(`${root}:${id}`, undefined);
      }
    }
  }), [api, onInvalidate, remember, tracks]);

  const isOffline = useRef(offline);
  isOffline.current = offline;
  const retry = useRef<{ timer?: ReturnType<typeof setTimeout>; delayMs: number }>({ delayMs: retryFirstMs });
  const flush = useCallback(() => {
    if (!queue) return;
    clearTimeout(retry.current.timer);
    void queue.flush().then(({ refused }) => {
      for (const like of refused) {
        remember(`${like.type}:${like.id}`, undefined);
        patchLike(queryClient, like.type, like.id, !like.liked);
        notify(like.liked ? 'Couldn’t add that to your likes.' : 'Couldn’t remove that from your likes.');
      }
      // Offline, the reconnect sends what is left; online, the server failed, so try again later.
      if (queue.pending.length && !isOffline.current) {
        clearTimeout(retry.current.timer);
        retry.current.timer = setTimeout(flush, retry.current.delayMs);
        retry.current.delayMs = Math.min(retry.current.delayMs * 2, retryMaxMs);
      } else if (!queue.pending.length) {
        retry.current.delayMs = retryFirstMs;
      }
    });
  }, [notify, queryClient, queue, remember]);
  useEffect(() => {
    if (!offline) flush();
  }, [flush, offline]);
  useEffect(() => () => clearTimeout(retry.current.timer), [queue]);

  const [saves, setSaves] = useState<ReadonlyMap<SaveKey, boolean>>(new Map());
  useEffect(() => setSaves(new Map()), [account]);
  const rememberSave = useCallback((key: SaveKey, saved: boolean | undefined) => setSaves(current => {
    const next = new Map(current);
    if (saved === undefined) next.delete(key);
    else next.set(key, saved);
    return next;
  }), []);
  // Each change waits for the one before it on the same item, so a quick add and remove
  // reach the server in order.
  const saving = useRef(new Map<SaveKey, Promise<unknown>>());

  const value: LibraryValue = useMemo<LibraryValue>(() => ({
    tracks,
    likes,
    saves,
    setSaved: (type, id, saved, title) => {
      if (!api) return;
      const key: SaveKey = `${type}:${id}`;
      rememberSave(key, saved);
      patchSaved(queryClient, type, id, saved);
      const send = () => saved ? api.library.save(type, id) : api.library.remove(type, id);
      // A quick confirmation that can be taken back, as streaming apps do; the button itself changes too.
      notify(saved ? `Added “${title}” to your library.` : `Removed “${title}” from your library.`,
        { label: 'Undo', run: () => value.setSaved(type, id, !saved, title) });
      const run = (saving.current.get(key) ?? Promise.resolve()).then(send, send).then(() => {
        // Library lists and Home's "Recently added" change; the item's own pages now carry the new state.
        void queryClient.invalidateQueries({ queryKey: queryKeys.libraryAlbums() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.libraryTracks() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.libraryArtists() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
      }, () => {
        rememberSave(key, undefined);
        patchSaved(queryClient, type, id, !saved);
        notify(saved ? `Couldn’t add “${title}” to your library.` : `Couldn’t remove “${title}” from your library.`);
      }).finally(() => {
        if (saving.current.get(key) === run) saving.current.delete(key);
      });
      saving.current.set(key, run);
    },
    setLiked: (type, id, liked) => {
      if (!queue) return;
      remember(`${type}:${id}`, liked);
      patchLike(queryClient, type, id, liked);
      queue.add({ type, id, liked });
      flush();
    },
    want: (type, id, title) => {
      if (!api) return;
      api.userdata.want(type, id).then(() => {
        notify(`Added “${title}” to your wantlist.`);
        if (type === 'album') {
          queryClient.setQueryData<AlbumDetail>(queryKeys.album(id), album => album && { ...album, wanted: true });
        }
      }, () => notify('Couldn’t add that to your wantlist.'));
    },
  }), [api, flush, likes, notify, queryClient, queue, remember, rememberSave, saves, tracks]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

/**
 * Shows an addition or removal everywhere at once: track summaries get `inLibrary`, an
 * album's page `library`. A collection album stays `collection`: removing never applies to it.
 */
function patchSaved(queryClient: QueryClient, type: LibraryEntityType, id: string, saved: boolean) {
  for (const query of queryClient.getQueryCache().getAll()) {
    const data = query.state.data;
    const patched = type === 'track'
      ? patchEntity(data, id, { inLibrary: saved })
      : patchAlbumLibrary(data, id, saved);
    if (patched !== data) queryClient.setQueryData(query.queryKey, patched, { updatedAt: query.state.dataUpdatedAt });
  }
}

function patchAlbumLibrary(data: unknown, id: string, saved: boolean): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const album = data as Partial<AlbumDetail>;
  if (album.id !== id || !('library' in album) || album.library === 'collection') return data;
  const library = saved ? 'saved' : null;
  return album.library === library ? data : { ...album, library };
}

function likeStorage(account: string) {
  const item = accountItem<QueuedLike[]>('likes', account);
  return { load: () => item.read() ?? [], save: (likes: readonly QueuedLike[]) => item.write([...likes]) };
}

function useLibrary(): LibraryValue {
  const library = useContext(LibraryContext);
  if (!library) throw new Error('useLibrary must be used inside LibraryProvider');
  return library;
}

export function useTrackStore(): TrackStore {
  return useLibrary().tracks;
}

/** A track's summary from the shared store, fetched in a batch when it is not there yet. */
export function useTrack(trackId: string | null | undefined, albumId: string | null | undefined): TrackSummary | undefined {
  const { tracks } = useLibrary();
  return useSyncExternalStore(tracks.subscribe, () => trackId ? tracks.get(trackId, albumId ?? null) : undefined);
}

/** Whether the user likes it, counting changes not yet reflected in `liked` from the server. */
export function useLiked(type: LikeEntityType, id: string | undefined, liked: boolean | undefined): boolean {
  const { likes } = useLibrary();
  return (id ? likes.get(`${type}:${id}`) : undefined) ?? liked ?? false;
}

export function useLibraryActions() {
  const { setLiked, want, setSaved } = useLibrary();
  return { setLiked, want, setSaved };
}

/**
 * Whether an item is in the user's library, counting changes made here that the server's
 * answer does not show yet. Undefined when the server does not say (an older server).
 */
export function useSaved(type: LibraryEntityType, id: string | undefined, saved: boolean | undefined): boolean | undefined {
  const { saves } = useLibrary();
  return (id ? saves.get(`${type}:${id}`) : undefined) ?? saved;
}

/** Playlist edits. Each one updates the cached playlist from the server's answer. */
export function usePlaylistActions() {
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  const notify = useNotice();
  const settle = (playlist: PlaylistDetail | PlaylistSummary) => {
    if ('items' in playlist) queryClient.setQueryData(queryKeys.playlist(playlist.id), playlist);
    void queryClient.invalidateQueries({ queryKey: [...queryKeys.playlists(), 'list'] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
  };
  const failed = (what: string) => () => notify(`Couldn’t ${what}. Try again.`);
  const run = <T,>(work: (api: Api) => Promise<T>) => api ? work(api) : Promise.reject(new Error('Signed out'));

  const create = useMutation({
    mutationFn: (name: string) => run(api => api.userdata.createPlaylist({ name })),
    onSuccess: settle,
    onError: failed('create the playlist'),
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => run(api => api.userdata.updatePlaylist(id, { name })),
    onSuccess: summary => {
      queryClient.setQueryData<PlaylistDetail>(queryKeys.playlist(summary.id), playlist => playlist && { ...playlist, ...summary });
      settle(summary);
    },
    onError: failed('rename the playlist'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => run(api => api.userdata.deletePlaylist(id)),
    onSuccess: (_ok, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.playlist(id) });
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.playlists(), 'list'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
    },
    onError: failed('delete the playlist'),
  });
  const add = useMutation({
    mutationFn: ({ id, tracks }: { id: string; name: string; tracks: readonly TrackSummary[] }) => run(api => api.userdata.addPlaylistItems(id, {
      tracks: tracks.map(track => ({ trackId: track.id, albumId: track.album?.id ?? null })),
    })),
    onSuccess: (playlist, { name }) => {
      settle(playlist);
      notify(`Added to “${name}”.`);
    },
    onError: failed('add to the playlist'),
  });
  /** Moves and removals show at once; the server's answer replaces the guess. */
  const edit = useMutation({
    mutationFn: (change: { id: string; itemId: string; toIndex?: number }) => run(api => change.toIndex === undefined
      ? api.userdata.removePlaylistItem(change.id, change.itemId)
      : api.userdata.movePlaylistItem(change.id, { itemId: change.itemId, toIndex: change.toIndex })),
    onMutate: async ({ id, itemId, toIndex }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.playlist(id) });
      const previous = queryClient.getQueryData<PlaylistDetail>(queryKeys.playlist(id));
      if (previous) {
        const items = previous.items.filter(item => item.itemId !== itemId);
        const moved = previous.items.find(item => item.itemId === itemId);
        if (toIndex !== undefined && moved) items.splice(toIndex, 0, moved);
        queryClient.setQueryData(queryKeys.playlist(id), { ...previous, items, trackCount: items.length });
      }
      return { previous };
    },
    onError: (_error, { id }, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.playlist(id), context.previous);
      notify('Couldn’t change the playlist. Try again.');
    },
    onSuccess: settle,
  });

  return {
    create: (name: string) => create.mutateAsync(name),
    rename: (id: string, name: string) => rename.mutate({ id, name }),
    remove: (id: string) => remove.mutate(id),
    add: (playlist: Pick<PlaylistSummary, 'id' | 'name'>, tracks: readonly TrackSummary[]) => add.mutate({ id: playlist.id, name: playlist.name, tracks }),
    move: (id: string, itemId: string, toIndex: number) => edit.mutate({ id, itemId, toIndex }),
    removeItem: (id: string, itemId: string) => edit.mutate({ id, itemId }),
  };
}
