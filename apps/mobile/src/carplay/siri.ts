import { mergeSearch, playlistScore, type ApiClient, type SearchItem, type Viewer } from '@squirmy/client-core';
import type { PlaylistSummary, SearchKind, SearchResults, TrackSummary } from '@squirmy/contracts';
import type { PlayOptions, PlaybackActions } from '../playback';
import type { MediaIntent } from './bridge';

type Context = {
  api: ApiClient;
  viewer: Viewer | null;
  offline: boolean;
  actions: PlaybackActions;
  canPlay: (track: TrackSummary) => boolean;
  signal: AbortSignal;
  isCurrent: () => boolean;
  prime?: (tracks: readonly TrackSummary[]) => void;
};

async function findPlaylist(api: ApiClient, query: string, signal: AbortSignal): Promise<PlaylistSummary | undefined> {
  let cursor: string | undefined;
  let best: PlaylistSummary | undefined;
  let bestScore = 0;
  while (!signal.aborted) {
    const page = await api.userdata.playlists({ cursor, limit: 100 });
    for (const playlist of page.items) {
      const score = playlistScore(query, playlist.name);
      if (score <= bestScore) continue;
      best = playlist;
      bestScore = score;
    }
    if (best?.name.localeCompare(query, undefined, { sensitivity: 'base' }) === 0) return best;
    if (!page.nextCursor || cursor === page.nextCursor) return best;
    cursor = page.nextCursor;
  }
  return best;
}

/** Resolve Siri's request against the same catalog and playback rules as the mobile app. */
export async function playMedia(intent: MediaIntent, context: Context): Promise<boolean> {
  const { api, actions, offline, canPlay, viewer, signal, isCurrent } = context;
  const valid = () => !signal.aborted && isCurrent();
  const query = intent.query?.trim().slice(0, 200);
  if (!query) return Boolean(intent.resume && valid() && actions.resumeHere());
  if (offline || !valid()) return false;
  const start = (tracks: readonly TrackSummary[], options: PlayOptions) => {
    if (!valid()) return false;
    context.prime?.(tracks);
    return actions.playHere(tracks, { ...options, shuffle: intent.shuffle ?? false });
  };

  let result: SearchItem | undefined;
  if (intent.mediaType === 'playlist') {
    const playlist = await findPlaylist(api, query, signal);
    if (playlist) result = { type: 'playlist', playlist };
  } else {
    const type: SearchKind | undefined = intent.mediaType === 'track' || intent.mediaType === 'artist' || intent.mediaType === 'album'
      ? intent.mediaType : undefined;
    const params = { q: query, type, limit: 12 };
    const library = api.search.library(params, { signal }).catch(() => undefined);
    // Local music can answer immediately while the catalog lookup is still running.
    const catalogRequest = api.search.catalog(params, { signal }).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const catalog = Promise.race<SearchResults | undefined>([
      catalogRequest,
      new Promise<undefined>(resolve => { timer = setTimeout(resolve, 1200); }),
    ]);
    const [local, remote] = await Promise.all([library, catalog]);
    clearTimeout(timer);
    const usable = (item: SearchItem | null) => item && (!type || item.type === type)
      && (item.type !== 'track' || canPlay(item.track));
    const merged = mergeSearch(local, remote, viewer, { query });
    result = usable(merged.top) ? merged.top! : merged.items.find(usable);
    if (!result && !remote && valid()) {
      const full = mergeSearch(local, await catalogRequest, viewer, { query });
      result = usable(full.top) ? full.top! : full.items.find(usable);
    }
  }
  if (!result || !valid()) return false;

  switch (result.type) {
    case 'track':
      return start([result.track], { start: 0, context: { type: 'search', id: null, title: query } });
    case 'album': {
      const album = await api.catalog.album(result.album.id);
      return start(album.discs.flatMap(disc => disc.tracks), { context: { type: 'album', id: album.id, title: album.title } });
    }
    case 'playlist': {
      const playlist = await api.userdata.playlist(result.playlist.id);
      return start(playlist.items.map(item => item.track), { context: { type: 'playlist', id: playlist.id, title: playlist.name } });
    }
    case 'artist': {
      const artist = await api.catalog.artist(result.artist.id);
      if (artist.radio && valid()) {
        const radio = await api.radio.artist(artist.id).catch(() => null);
        if (radio && valid()) return actions.playRadioHere(radio, intent.shuffle);
      }
      return start(artist.topTracks, { context: { type: 'artist', id: artist.id, title: artist.name } });
    }
  }
}
