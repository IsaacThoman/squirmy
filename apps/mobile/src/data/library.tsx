import { TrackStore } from '@squirmy/client-core';
import {
  queryKeys, type AlbumDetail, type LikeEntityType, type PlaylistDetail, type PlaylistSummary, type TrackSummary,
  type WantEntityType,
} from '@squirmy/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren,
} from 'react';
import { useAccountKey, useSignedInApi, type Api } from '../account/AccountProvider';
import { useNotice } from '../Notice';
import { accountItem } from './accountStorage';
import { LikeQueue, type QueuedLike } from './likeQueue';
import { useRealtime } from './realtime';

type LikeKey = `${LikeEntityType}:${string}`;

type LibraryValue = {
  tracks: TrackStore;
  /** Likes changed here (or on another device) since the screens' data was loaded. */
  likes: ReadonlyMap<LikeKey, boolean>;
  setLiked: (type: LikeEntityType, id: string, liked: boolean) => void;
  want: (type: WantEntityType, id: string, title: string) => void;
};

const LibraryContext = createContext<LibraryValue | null>(null);

const noSummaries = () => Promise.reject(new Error('Signed out'));

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
  const { onInvalidate, offline } = useRealtime();
  // One store per account, reading the current client: a new client (a token or server
  // update) must not drop the cached summaries or rebuild what is built on the store.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  const tracks = useMemo(() => new TrackStore(body => apiRef.current?.catalog.trackSummaries(body) ?? noSummaries()), [account]);
  const queue = useMemo(() => api && account ? new LikeQueue(likeStorage(account), async ({ type, id, liked }) => {
    await (liked ? api.userdata.like(type, id) : api.userdata.unlike(type, id));
  }) : null, [account, api]);
  const [likes, setLikes] = useState<ReadonlyMap<LikeKey, boolean>>(new Map());
  useEffect(() => setLikes(new Map(queue?.pending.map(like => [`${like.type}:${like.id}`, like.liked] as const))), [queue]);

  const remember = useCallback((key: LikeKey, liked: boolean | undefined) => setLikes(current => {
    const next = new Map(current);
    if (liked === undefined) next.delete(key);
    else next.set(key, liked);
    return next;
  }), []);

  // Another device changed a like: the pages refetch on their own, so only the cached
  // track summaries (queue rows, Now Playing) need the new value.
  useEffect(() => onInvalidate(keys => {
    for (const key of keys) {
      if (key[0] === 'track' && typeof key[1] === 'string' && api) {
        const id = key[1];
        api.catalog.track(id).then(track => {
          tracks.prime([track]);
          remember(`track:${id}`, track.liked);
        }, () => undefined);
      } else if (key[0] === 'album' && typeof key[1] === 'string') {
        remember(`album:${key[1]}`, undefined);
      }
    }
  }), [api, onInvalidate, remember, tracks]);

  const flush = useCallback(() => {
    void queue?.flush().then(({ applied, refused }) => {
      if (applied.length) void queryClient.invalidateQueries({ queryKey: queryKeys.likes() });
      for (const like of refused) {
        remember(`${like.type}:${like.id}`, undefined);
        notify(like.liked ? 'Couldn’t add that to your likes.' : 'Couldn’t remove that from your likes.');
      }
    });
  }, [notify, queryClient, queue, remember]);
  useEffect(() => {
    if (!offline) flush();
  }, [flush, offline]);

  const value = useMemo<LibraryValue>(() => ({
    tracks,
    likes,
    setLiked: (type, id, liked) => {
      if (!queue) return;
      remember(`${type}:${id}`, liked);
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
  }), [api, flush, likes, notify, queryClient, queue, remember, tracks]);

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

/** Whether the user likes it, counting changes not yet reflected in `liked` from the server. */
export function useLiked(type: LikeEntityType, id: string | undefined, liked: boolean | undefined): boolean {
  const { likes } = useLibrary();
  return (id ? likes.get(`${type}:${id}`) : undefined) ?? liked ?? false;
}

export function useLibraryActions() {
  const { setLiked, want } = useLibrary();
  return { setLiked, want };
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
