import { planChanges, TrackStore } from '@squirmy/client-core';
import {
  queryKeys, type AlbumDetail, type LikeEntityType, type Page, type PlaylistDetail, type PlaylistSummary, type TrackSummary,
  type WantEntityType,
} from '@squirmy/contracts';
import { useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren,
} from 'react';
import { useAccountKey, useSignedInApi, useWantlistEnabled, type Api } from '../account/AccountProvider';
import { announce, useBriefFailures } from '../inlineFeedback';
import { heartFailure } from '../library/heart';
import { playlistEditFailure, wantFailure } from '../library/failures';
import { accountItem } from './accountStorage';
import { applyChanges } from './changes';
import { LikeQueue, type QueuedLike } from './likeQueue';
import { findTrack, remembersToDrop, withLikedTrack } from './likePatch';
import { useRealtime } from './realtime';

type LikeKey = `${LikeEntityType}:${string}`;

type LibraryValue = {
  tracks: TrackStore;
  /** Hearts changed here (or on another device) since the screens' data was loaded. */
  likes: ReadonlyMap<LikeKey, boolean>;
  /**
   * The heart, the one way to save to or remove from the library. It shows at once, and the
   * heart itself is the confirmation; a refusal sets it back and shows on the heart for a few
   * seconds (`likeFailures`). `title` names the item there.
   */
  setLiked: (type: LikeEntityType, id: string, liked: boolean, title?: string) => void;
  /** Hearts the server just refused, by `type:id`: the value it would not take. */
  likeFailures: ReadonlyMap<string, boolean>;
  /** Whether the item is on the wantlist: as changed here, else as the server lists it (or says so itself, `fromServer`). */
  isWanted: (id: string, fromServer?: boolean) => boolean;
  /**
   * Adds the item to the wantlist or takes it off, the same both ways as on web. It shows at
   * once; a refusal sets it back and shows on the control for a few seconds (`wantFailures`).
   */
  setWanted: (type: WantEntityType, id: string, wanted: boolean, title: string) => void;
  /** Wantlist changes the server just refused, by id: the value it would not take. */
  wantFailures: ReadonlyMap<string, boolean>;
  /** Playlist edits the server just refused, by playlist id: what the playlist's page says, for a few seconds. */
  playlistFailures: ReadonlyMap<string, string>;
  /** Shows `message` on the playlist's page and announces it; null takes it away, as the next edit does. */
  failPlaylist: (id: string, message: string | null) => void;
};

const LibraryContext = createContext<LibraryValue | null>(null);

const noSummaries = () => Promise.reject(new Error('Signed out'));
/** Likes the server could not take (a 5xx, a dropped request) are sent again after this, then twice as long each time. */
const retryFirstMs = 15_000;
const retryMaxMs = 4 * 60_000;
const likedTracksKey = [...queryKeys.likes(), 'track'];

/**
 * Shows a heart everywhere at once, as the same `patch` change the server then sends every
 * device of the user (`applyChanges`): every cached answer that carries the item gets the new
 * flag, and Liked Songs gains or loses the track, so nothing has to be fetched again. A
 * hearted track is in the library; an unhearted one may still be (its album, the server's
 * collection), so `inLibrary` waits for the server's patch then.
 */
function patchLike(queryClient: QueryClient, type: LikeEntityType, id: string, liked: boolean) {
  const fields = type === 'track' && liked ? { liked, inLibrary: true } : { liked };
  applyChanges(queryClient, planChanges([{ kind: 'patch', entity: type, id, fields }]), { own: true });
  if (type !== 'track') return;
  const queries = queryClient.getQueryCache().getAll();
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
 * What the user keeps: hearts (their library), the wantlist and the track summaries every
 * screen shares. Hearts apply at once. Made offline, they wait in a queue (kept across
 * launches) and are sent when the server is back; one the server refuses rolls back.
 */
export function LibraryProvider({ children }: PropsWithChildren) {
  const api = useSignedInApi();
  const account = useAccountKey();
  const queryClient = useQueryClient();
  const { onInvalidate, onChanges, offline, expectEcho } = useRealtime();
  // One store per account, reading the current client: a new client (a token or server
  // update) must not drop the cached summaries or rebuild what is built on the store.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  const tracks = useMemo(() => new TrackStore(body => apiRef.current?.catalog.trackSummaries(body) ?? noSummaries()), [account]);
  const queue = useMemo(() => api && account ? new LikeQueue(likeStorage(account), ({ type, id, liked }) => {
    // The server patches this phone too (it already shows the change, so that echo is not
    // refetched) and invalidates the lists that gain or lose the item: the library's, Liked
    // Songs and Home. A reconnect refreshes them if that is missed.
    expectEcho([type, id]);
    return liked ? api.userdata.like(type, id) : api.userdata.unlike(type, id);
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
  const { failures: likeFailures, fail: failLike, drop: dropLikeFailure } = useBriefFailures<boolean>();
  const flush = useCallback(() => {
    if (!queue) return;
    clearTimeout(retry.current.timer);
    void queue.flush().then(({ applied, refused }) => {
      // The server has these now, and every cached copy was patched: what is remembered
      // here gives way, so a later change from another device shows (Q47's cause).
      for (const like of applied) {
        if (queue.pending.some(item => item.type === like.type && item.id === like.id)) continue;
        remember(`${like.type}:${like.id}`, undefined);
        patchLike(queryClient, like.type, like.id, like.liked);
      }
      for (const like of refused) {
        remember(`${like.type}:${like.id}`, undefined);
        patchLike(queryClient, like.type, like.id, !like.liked);
        // The heart shows it, and a tap on it sends the same change again.
        failLike(`${like.type}:${like.id}`, like.liked);
        announce(heartFailure(like.liked, like.title));
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
  }, [failLike, queryClient, queue, remember]);
  useEffect(() => {
    if (!offline) flush();
  }, [flush, offline]);
  useEffect(() => () => clearTimeout(retry.current.timer), [queue]);

  /** Applies a heart at once and queues it. Offline it waits in the queue: that is not a failure, so nothing says so. */
  const change = useCallback((like: QueuedLike) => {
    if (!queue) return;
    const { type, id, liked } = like;
    dropLikeFailure(`${type}:${id}`);
    remember(`${type}:${id}`, liked);
    patchLike(queryClient, type, id, liked);
    queue.add(like);
    flush();
  }, [dropLikeFailure, flush, queryClient, queue, remember]);
  const setLiked = useCallback((type: LikeEntityType, id: string, liked: boolean, title?: string) =>
    change({ type, id, liked, ...title !== undefined && { title } }), [change]);

  // What the server announces reaches the queue rows, Now Playing and the lock screen too.
  // A heart from another device is the server's latest word on the item:
  // what this device remembered gives way to it, unless a change made here is still on its way.
  useEffect(() => onChanges((plan, { own }) => {
    tracks.patch(plan.patches);
    if (own) return;
    const drop = remembersToDrop(plan.fields, key => Boolean(queue?.pending.some(like => `${like.type}:${like.id}` === key)));
    for (const key of drop) remember(key as LikeKey, undefined);
  }), [onChanges, queue, remember, tracks]);

  // What is on the wantlist, for menus and album pages to offer adding or removing. Only
  // asked for while the server has the wantlist on; the first page holds what anyone keeps.
  const wantlistOn = useWantlistEnabled();
  const wants = useQuery({
    queryKey: queryKeys.wants(),
    queryFn: () => api!.userdata.wants({ limit: 200 }),
    enabled: Boolean(api) && wantlistOn,
  });
  const wantedIds = useMemo(() => new Set(wants.data?.items.map(item => item.type === 'album' ? item.album.id : item.track.id)), [wants.data]);
  // Changes made here, shown until the server's list has them.
  const [wantChanges, setWantChanges] = useState<ReadonlyMap<string, boolean>>(new Map());
  const changeWant = useCallback((id: string, wanted: boolean | undefined) => setWantChanges(current => {
    const next = new Map(current);
    if (wanted === undefined) next.delete(id);
    else next.set(id, wanted);
    return next;
  }), []);

  const { failures: wantFailures, fail: failWant, drop: dropWantFailure } = useBriefFailures<boolean>();
  const setWanted = useCallback((type: WantEntityType, id: string, wanted: boolean, title: string) => {
    if (!api) return;
    dropWantFailure(id);
    changeWant(id, wanted);
    const patchAlbum = (value: boolean) => {
      if (type === 'album') queryClient.setQueryData<AlbumDetail>(queryKeys.album(id), album => album && { ...album, wanted: value });
    };
    patchAlbum(wanted);
    (wanted ? api.userdata.want(type, id) : api.userdata.unwant(type, id)).then(
      () => queryClient.invalidateQueries({ queryKey: queryKeys.wants() }).then(() => changeWant(id, undefined)),
      () => {
        changeWant(id, undefined);
        patchAlbum(!wanted);
        // The control shows it, and a tap on it sends the same change again.
        failWant(id, wanted);
        announce(wantFailure(wanted, title));
      },
    );
  }, [api, changeWant, dropWantFailure, failWant, queryClient]);

  // Kept here rather than in the page: a removal made from a song's menu sheet is told on the playlist's page beneath it.
  const { failures: playlistFailures, fail: failPlaylistEdit, drop: dropPlaylistFailure } = useBriefFailures<string>();
  const failPlaylist = useCallback((id: string, message: string | null) => {
    if (message === null) return dropPlaylistFailure(id);
    failPlaylistEdit(id, message);
    announce(message);
  }, [dropPlaylistFailure, failPlaylistEdit]);

  const value: LibraryValue = useMemo<LibraryValue>(() => ({
    tracks,
    likes,
    setLiked,
    likeFailures,
    isWanted: (id, fromServer = false) => wantChanges.get(id) ?? (fromServer || wantedIds.has(id)),
    setWanted,
    wantFailures,
    playlistFailures,
    failPlaylist,
  }), [failPlaylist, likeFailures, likes, playlistFailures, setLiked, setWanted, tracks, wantChanges, wantFailures, wantedIds]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
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

/**
 * Whether the heart is on (the user saved it to their library), counting changes not yet
 * reflected in `liked` from the server.
 */
export function useLiked(type: LikeEntityType, id: string | undefined, liked: boolean | undefined): boolean {
  const { likes } = useLibrary();
  return (id ? likes.get(`${type}:${id}`) : undefined) ?? liked ?? false;
}

/** Hearts changed here or on another device since the screens' data was loaded, by `type:id`. */
export function useLikeChanges(): ReadonlyMap<string, boolean> {
  return useLibrary().likes;
}

/** The change to the item's heart that the server just refused, if any: the value it would not take. */
export function useLikeFailure(type: LikeEntityType, id: string | undefined): boolean | undefined {
  const { likeFailures } = useLibrary();
  return id ? likeFailures.get(`${type}:${id}`) : undefined;
}

/** Every heart change the server just refused, by `type:id`, for a list that builds its menus from what it already read. */
export function useLikeFailures(): ReadonlyMap<string, boolean> {
  return useLibrary().likeFailures;
}

/** The wantlist change the server just refused for the item, if any: the value it would not take. */
export function useWantFailure(id: string | undefined): boolean | undefined {
  const { wantFailures } = useLibrary();
  return id ? wantFailures.get(id) : undefined;
}

/** What the playlist's page says about an edit the server just refused, for a few seconds. */
export function usePlaylistFailure(id: string | undefined): string | undefined {
  const { playlistFailures } = useLibrary();
  return id ? playlistFailures.get(id) : undefined;
}

export function useLibraryActions() {
  const { setLiked, setWanted } = useLibrary();
  return { setLiked, setWanted };
}

/** Whether the item is on the wantlist; `fromServer` is what its own page says, if anything. */
export function useWanted(id: string | undefined, fromServer?: boolean): boolean {
  const { isWanted } = useLibrary();
  return id ? isWanted(id, fromServer) : false;
}

type AddChange = { id: string; tracks: readonly TrackSummary[]; anyway?: boolean };

/** What adding answered: `skipped` when the playlist already had some of the songs, so the server left them out. */
export type AddResult = { skipped: boolean };

/**
 * Playlist edits. Each one updates the cached playlist from the server's answer. Creating,
 * renaming and adding are made from sheets, which wait for the answer and show a refusal
 * themselves; a refused move, removal or deletion is shown on the playlist's page
 * (`usePlaylistFailure`), and a move or removal goes back to how it was.
 */
export function usePlaylistActions() {
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  const { failPlaylist, tracks: trackStore } = useLibrary();
  const settle = (playlist: PlaylistDetail | PlaylistSummary) => {
    if ('items' in playlist) queryClient.setQueryData(queryKeys.playlist(playlist.id), playlist);
    void queryClient.invalidateQueries({ queryKey: [...queryKeys.playlists(), 'list'] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
  };
  const cached = (id: string) => queryClient.getQueryData<PlaylistDetail>(queryKeys.playlist(id));
  const run = <T,>(work: (api: Api) => Promise<T>) => api ? work(api) : Promise.reject(new Error('Signed out'));

  const create = useMutation({
    mutationFn: (name: string) => run(api => api.userdata.createPlaylist({ name })),
    onSuccess: settle,
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => run(api => api.userdata.updatePlaylist(id, { name })),
    onSuccess: summary => {
      queryClient.setQueryData<PlaylistDetail>(queryKeys.playlist(summary.id), playlist => playlist && { ...playlist, ...summary });
      settle(summary);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => run(api => api.userdata.deletePlaylist(id)),
    onMutate: id => failPlaylist(id, null),
    onSuccess: (_ok, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.playlist(id) });
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.playlists(), 'list'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
    },
    onError: (_error, id) => failPlaylist(id, playlistEditFailure('delete')),
  });
  // Without `anyway`, tracks the playlist already has are left out.
  const add = useMutation({
    mutationFn: ({ id, tracks, anyway }: AddChange) => run(api => api.userdata.addPlaylistItems(id, {
      tracks: tracks.map(track => ({ trackId: track.id, albumId: track.album?.id ?? null })),
      skipDuplicates: !anyway,
    })),
    onSuccess: settle,
  });
  /** Moves and removals show at once; the server's answer replaces the guess, and a refusal puts it back. */
  const edit = useMutation({
    mutationFn: (change: { id: string; itemId: string; toIndex?: number }) => run(api => change.toIndex === undefined
      ? api.userdata.removePlaylistItem(change.id, change.itemId)
      : api.userdata.movePlaylistItem(change.id, { itemId: change.itemId, toIndex: change.toIndex })),
    onMutate: async ({ id, itemId, toIndex }) => {
      failPlaylist(id, null);
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
    onError: (_error, { id, toIndex }, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.playlist(id), context.previous);
      failPlaylist(id, playlistEditFailure(toIndex === undefined ? 'remove' : 'move'));
    },
    onSuccess: settle,
  });

  return {
    create: (name: string) => create.mutateAsync(name),
    rename: (id: string, name: string) => rename.mutateAsync({ id, name }),
    /** Resolves once the server has deleted it; a refusal is shown on the playlist's page. */
    remove: (id: string) => remove.mutateAsync(id),
    /**
     * Whether the playlist already has the track, from its cached page; undefined when
     * that page has not been loaded.
     */
    has: (id: string, trackId: string) => cached(id)?.items.some(item => item.track.id === trackId),
    /**
     * The tracks the playlist has already, from its page, which is loaded first when it is not
     * cached (as on web, a minute-old copy is current enough: the server's invalidations refresh
     * it). Empty when it can't be loaded: the server still leaves duplicates out.
     */
    repeated: async (id: string, tracks: readonly TrackSummary[]): Promise<TrackSummary[]> => {
      const detail = api ? await queryClient.fetchQuery({ queryKey: queryKeys.playlist(id), queryFn: async () => {
        const playlist = await api.userdata.playlist(id);
        trackStore.prime(playlist.items.map(item => item.track));
        return playlist;
      }, staleTime: 60_000 })
        .catch(() => undefined) : cached(id);
      const there = new Set(detail?.items.map(item => item.track.id));
      return tracks.filter(track => there.has(track.id));
    },
    /**
     * Adds the tracks, leaving out ones the playlist has unless `anyway` (the person chose to
     * add them again). Resolves once the server has answered; rejects when it refused.
     */
    add: async (playlist: Pick<PlaylistSummary, 'id'> & Partial<Pick<PlaylistSummary, 'trackCount'>>, tracks: readonly TrackSummary[],
      options: { anyway?: boolean } = {}): Promise<AddResult> => {
      const before = cached(playlist.id)?.items.length ?? playlist.trackCount;
      const answer = await add.mutateAsync({ id: playlist.id, tracks, anyway: options.anyway });
      // The answer is the whole playlist, so fewer new items than songs sent is how a skipped duplicate shows.
      return { skipped: !options.anyway && before !== undefined && answer.items.length < before + tracks.length };
    },
    move: (id: string, itemId: string, toIndex: number) => edit.mutate({ id, itemId, toIndex }),
    /** Removes the item at once, with no Undo: the song can be added again from its menu. */
    removeItem: (id: string, itemId: string) => edit.mutate({ id, itemId }),
  };
}
