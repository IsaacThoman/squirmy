import { planChanges, TrackStore } from '@squirmy/client-core';
import {
  queryKeys, type AlbumDetail, type LikeEntityType, type Page, type PlaylistDetail, type PlaylistSummary, type TrackSummary,
  type WantEntityType,
} from '@squirmy/contracts';
import { useMutation, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren,
} from 'react';
import { useAccountKey, useSignedInApi, type Api } from '../account/AccountProvider';
import { useNotice } from '../Notice';
import { accountItem } from './accountStorage';
import { applyChanges } from './changes';
import { LikeQueue, refusedNotice, type QueuedLike } from './likeQueue';
import { findTrack, remembersToDrop, withLikedTrack } from './likePatch';
import { useRealtime } from './realtime';

type LikeKey = `${LikeEntityType}:${string}`;

type LibraryValue = {
  tracks: TrackStore;
  /** Hearts changed here (or on another device) since the screens' data was loaded. */
  likes: ReadonlyMap<LikeKey, boolean>;
  /**
   * The heart, the one way to save to or remove from the library. It shows at once with a
   * notice that can undo it; a refusal sets it back, and its notice, which replaces that one,
   * can try again. `title` names the item there.
   */
  setLiked: (type: LikeEntityType, id: string, liked: boolean, title?: string) => void;
  want: (type: WantEntityType, id: string, title: string) => void;
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
  const notify = useNotice();
  const { onInvalidate, onChanges, offline, expectEcho } = useRealtime();
  // One store per account, reading the current client: a new client (a token or server
  // update) must not drop the cached summaries or rebuild what is built on the store.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  const tracks = useMemo(() => new TrackStore(body => apiRef.current?.catalog.trackSummaries(body) ?? noSummaries()), [account]);
  const queue = useMemo(() => api && account ? new LikeQueue(likeStorage(account), async ({ type, id, liked }, savedAt) => {
    // The server patches this phone too (it already shows the change, so that echo is not
    // refetched) and invalidates the lists that gain or lose the item: the library's, Liked
    // Songs (in its place, for an Undo) and Home. A reconnect refreshes them if that is missed.
    expectEcho([type, id]);
    // An Undo of a removal gives the save its old time back, so it keeps its place in the lists.
    const answer = liked
      ? await api.userdata.like(type, id, savedAt ? { savedAt } : {}).then(() => undefined)
      : await api.userdata.unlike(type, id).then(removed => ({ savedAt: removed.savedAt }));
    return answer;
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
  // `change`, for a refusal's Try again; it is made below, from `flush`.
  const changeRef = useRef<(like: QueuedLike) => void>(() => undefined);
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
        // Takes the place of the "Saved" notice the heart showed, which would otherwise still be up.
        notify(refusedNotice(like.liked), { action: { label: 'Try again', run: () => changeRef.current(like) } });
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

  /** Applies a heart at once and queues it. Offline it waits in the queue: that is not a failure, so the notice stands. */
  const change = useCallback(function change(like: QueuedLike) {
    if (!queue) return;
    const { type, id, liked, title } = like;
    remember(`${type}:${id}`, liked);
    patchLike(queryClient, type, id, liked);
    queue.add(like);
    flush();
    // A quick confirmation that can be taken back, as streaming apps do; the heart itself changes too.
    // Undoing a removal restores the save with its old time.
    const name = title ? `“${title}” ` : '';
    notify(liked ? `Saved ${name}to your library.` : `Removed ${name}from your library.`,
      { action: { label: 'Undo', run: () => change({ type, id, liked: !liked, title, ...!liked && { restore: true } }) } });
  }, [flush, notify, queryClient, queue, remember]);
  useEffect(() => {
    changeRef.current = change;
  }, [change]);
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

  const value: LibraryValue = useMemo<LibraryValue>(() => ({
    tracks,
    likes,
    setLiked,
    want: (type, id, title) => {
      if (!api) return;
      api.userdata.want(type, id).then(() => {
        notify(`Added “${title}” to your wantlist.`);
        if (type === 'album') {
          queryClient.setQueryData<AlbumDetail>(queryKeys.album(id), album => album && { ...album, wanted: true });
        }
      }, () => notify('Couldn’t add that to your wantlist.'));
    },
  }), [api, likes, notify, queryClient, setLiked, tracks]);

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

export function useLibraryActions() {
  const { setLiked, want } = useLibrary();
  return { setLiked, want };
}

type AddChange = { id: string; name: string; tracks: readonly TrackSummary[]; anyway?: boolean; before?: number };

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
  const cached = (id: string) => queryClient.getQueryData<PlaylistDetail>(queryKeys.playlist(id));
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
  // Without `anyway`, tracks the playlist already has are left out, and the notice says so.
  const add = useMutation({
    mutationFn: ({ id, tracks, anyway }: AddChange) => run(api => api.userdata.addPlaylistItems(id, {
      tracks: tracks.map(track => ({ trackId: track.id, albumId: track.album?.id ?? null })),
      skipDuplicates: !anyway,
    })),
    onSuccess: (playlist, change) => {
      settle(playlist);
      const { name, before } = change;
      // The answer is the whole playlist, so an unchanged length is how a skipped duplicate shows.
      if (!change.anyway && before !== undefined && playlist.items.length === before) {
        notify(`Already in “${name}”.`, { action: { label: 'Add Anyway', run: () => add.mutate({ ...change, anyway: true }) } });
      } else {
        notify(`Added to “${name}”.`);
      }
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

  /**
   * Removes an item with an Undo notice. Undo adds the track again (the server gives it a
   * new item) and moves it back to where it was; the list shows it there at once.
   */
  const removeItem = (id: string, itemId: string) => {
    const playlist = cached(id);
    const index = playlist?.items.findIndex(item => item.itemId === itemId) ?? -1;
    const item = playlist?.items[index];
    // Whether the server took the removal; a refusal has its own notice and puts the item back.
    const removed = edit.mutateAsync({ id, itemId }).then(() => true, () => false);
    if (!playlist || !item) return;
    const putBack = () => run(async api => {
      const added = await api.userdata.addPlaylistItems(id, { tracks: [{ trackId: item.track.id, albumId: item.track.album?.id ?? null }] });
      const restored = added.items.at(-1);
      if (!restored || index >= added.items.length - 1) return added;
      return api.userdata.movePlaylistItem(id, { itemId: restored.itemId, toIndex: index });
    }).then(settle, () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.playlist(id) });
      notify(`Couldn’t put the song back in “${playlist.name}”. Try again.`);
    });
    const undo = () => {
      queryClient.setQueryData<PlaylistDetail>(queryKeys.playlist(id), current => {
        if (!current || current.items.some(other => other.itemId === itemId)) return current;
        const items = [...current.items];
        items.splice(Math.min(index, items.length), 0, item);
        return { ...current, items, trackCount: items.length };
      });
      void removed.then(ok => ok ? putBack() : undefined);
    };
    notify(`Removed from “${playlist.name}”.`, { action: { label: 'Undo', run: undo } });
  };

  return {
    create: (name: string) => create.mutateAsync(name),
    rename: (id: string, name: string) => rename.mutateAsync({ id, name }),
    remove: (id: string) => remove.mutate(id),
    /**
     * Whether the playlist already has the track, from its cached page; undefined when
     * that page has not been loaded.
     */
    has: (id: string, trackId: string) => cached(id)?.items.some(item => item.track.id === trackId),
    /** Adds the tracks, leaving out ones the playlist has unless `anyway` (the person chose to add them again). */
    add: (playlist: Pick<PlaylistSummary, 'id' | 'name'> & Partial<Pick<PlaylistSummary, 'trackCount'>>, tracks: readonly TrackSummary[], options: { anyway?: boolean } = {}) =>
      add.mutate({
        id: playlist.id, name: playlist.name, tracks, anyway: options.anyway,
        before: cached(playlist.id)?.items.length ?? playlist.trackCount,
      }),
    move: (id: string, itemId: string, toIndex: number) => edit.mutate({ id, itemId, toIndex }),
    removeItem,
  };
}
