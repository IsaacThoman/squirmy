/**
 * What Siri, Shortcuts and the widgets' buttons ask of the app, done with the same rules as
 * its own screens: commands go to the session (so they act on whichever device plays), and
 * only what plays for this listener is offered or started. Plain logic over `IntentDeps`, so
 * it is tested without React Native; `SystemSurfaces` gives it the app's clients.
 */
import { albumPresentation, artworkUrl, mergeSearch, type SearchItem, type Viewer } from '@squirmy/client-core';
import type { Artwork, PlaybackContext, RadioResponse, SearchResults, TrackSummary } from '@squirmy/contracts';
import type { IntentItem } from '../../modules/app-intents';
import type { Api } from '../account/AccountProvider';
import { loadRest, maxPlayed } from '../library/loadAll';

export type IntentDeps = {
  api: Api | null;
  serverUrl: string;
  viewer: Viewer | null;
  offline: boolean;
  canPlay: (track: TrackSummary) => boolean;
  /** The current entry's track, for a radio of it. */
  currentTrackId: () => string | null;
  prime: (tracks: readonly TrackSummary[]) => void;
  actions: {
    playPause: () => void;
    play: () => void;
    pause: () => void;
    next: () => void;
    previous: () => void;
    playTracks: (tracks: readonly TrackSummary[], options: { start?: number; shuffle?: boolean; context?: PlaybackContext }) => void;
    playRadio: (radio: RadioResponse) => void;
  };
  /** Shuffling the library stops loading pages after this long, and shuffles what it has. */
  libraryBudgetMs?: number;
  now?: () => number;
};

/**
 * What a request waits for before it is answered: the server taking the command, or for a
 * play, also the music starting (iOS lets the app start audio from the background only
 * while the intent runs).
 */
export type IntentOutcome = { wait: 'none' | 'command' | 'playback'; result: Record<string, unknown> };

/** A refusal in words Siri can say. */
export class IntentRefusal extends Error {}

export const intentText = {
  signedOut: 'Open Squirmy and sign in first.',
  offline: 'Squirmy can’t reach your server right now.',
  notFound: 'Squirmy couldn’t find that.',
  nothingPlaying: 'Nothing is playing in Squirmy.',
  unplayable: (title: string) => `Nothing in “${title}” can play right now.`,
  noLiked: 'You haven’t liked any songs yet.',
  emptyLibrary: 'Your library has no songs to shuffle yet.',
  unknown: 'Squirmy can’t do that.',
} as const;

const searchLimit = 12;
/** Siri asks again after a few seconds; the catalog's answer is waited for this long at most. */
const catalogWaitMs = 1200;
const libraryBudgetMs = 4000;
const pageSize = 200;
const artworkSize = 300;

const kinds = new Set(['album', 'artist', 'playlist', 'track', 'liked', 'mix', 'radio']);

export async function runIntent(action: string, payload: Record<string, unknown>, deps: IntentDeps): Promise<IntentOutcome> {
  const command = (run: () => void): IntentOutcome => {
    run();
    return { wait: 'command', result: {} };
  };
  switch (action) {
    case 'togglePlayback': return command(deps.actions.playPause);
    case 'pause': return command(deps.actions.pause);
    case 'resume': return { ...command(deps.actions.play), wait: 'playback' };
    case 'next': return command(deps.actions.next);
    case 'previous': return command(deps.actions.previous);
    case 'play': return play(itemOf(payload.item), payload.shuffle === true, deps);
    case 'shuffleLibrary': return shuffleLibrary(deps);
    case 'radio': return radio(deps);
    case 'search': return { wait: 'none', result: { items: await search(String(payload.query ?? ''), deps) } };
    case 'lookup': return { wait: 'none', result: { items: await lookup(Array.isArray(payload.ids) ? payload.ids.map(String) : [], deps) } };
    default: throw new IntentRefusal(intentText.unknown);
  }
}

function itemOf(value: unknown): Pick<IntentItem, 'id' | 'kind' | 'title'> {
  const item = value as Partial<IntentItem> | undefined;
  if (!item || typeof item.id !== 'string' || typeof item.kind !== 'string' || !kinds.has(item.kind)) throw new IntentRefusal(intentText.notFound);
  return { id: item.id, kind: item.kind, title: typeof item.title === 'string' ? item.title : '' };
}

function online(deps: IntentDeps): Api {
  if (!deps.api || deps.offline) throw new IntentRefusal(intentText.offline);
  return deps.api;
}

/** The id after the kind: `album:<id>` is `<id>`, `radio:track:<id>` is `track:<id>`. */
function idOf(id: string): string {
  return id.slice(id.indexOf(':') + 1);
}

async function play(item: Pick<IntentItem, 'id' | 'kind' | 'title'>, shuffle: boolean, deps: IntentDeps): Promise<IntentOutcome> {
  const api = online(deps);
  const start = (tracks: readonly TrackSummary[], context: PlaybackContext, title = item.title) => {
    if (!tracks.some(deps.canPlay)) throw new IntentRefusal(intentText.unplayable(title));
    deps.prime(tracks);
    deps.actions.playTracks(tracks, { shuffle, context });
    return { wait: 'playback' as const, result: {} };
  };
  const startRadio = (radio: RadioResponse) => {
    if (!radio.tracks.length) throw new IntentRefusal(intentText.unplayable(item.title));
    deps.actions.playRadio(radio);
    return { wait: 'playback' as const, result: {} };
  };
  const id = idOf(item.id);
  switch (item.kind) {
    case 'album': {
      const album = await api.catalog.album(id);
      return start(album.discs.flatMap(disc => disc.tracks), { type: 'album', id: album.id, title: album.title }, album.title);
    }
    case 'playlist': {
      const playlist = await api.userdata.playlist(id);
      return start(playlist.items.map(entry => entry.track), { type: 'playlist', id: playlist.id, title: playlist.name }, playlist.name);
    }
    case 'liked': {
      const first = await api.userdata.likes('track', { limit: pageSize });
      if (!first.items.length) throw new IntentRefusal(intentText.noLiked);
      const tracks = await loadRest(first.items, first.nextCursor, (cursor, limit) => api.userdata.likes('track', { cursor, limit }), maxPlayed);
      return start(tracks, { type: 'liked', id: null, title: 'Liked Songs' }, 'Liked Songs');
    }
    case 'artist': {
      // As the app's artist pages do: the artist's radio when there is one, else their top songs.
      const artist = await api.catalog.artist(id);
      if (artist.radio) {
        const radio = await api.radio.artist(artist.id).catch(() => null);
        if (radio?.tracks.length) return startRadio(radio);
      }
      return start(artist.topTracks, { type: 'artist', id: artist.id, title: artist.name }, artist.name);
    }
    case 'track': {
      const track = await api.catalog.track(id);
      // A song plays on its own, as one found in Search does; Autoplay goes on from it.
      return start([track], { type: 'search', id: null, title: track.title }, track.title);
    }
    case 'mix': {
      const mix = await api.radio.mix(id);
      return start(mix.tracks, { type: 'mix', id: mix.id, title: mix.name }, mix.name);
    }
    case 'radio': {
      const [seed, seedId] = [id.slice(0, id.indexOf(':')), idOf(id)];
      if (seed === 'artist') return startRadio(await api.radio.artist(seedId));
      if (seed === 'track') return startRadio(await api.radio.track(seedId));
      throw new IntentRefusal(intentText.notFound);
    }
    default: throw new IntentRefusal(intentText.notFound);
  }
}

/**
 * The library's songs, shuffled. A big library is loaded page by page for a few seconds at
 * most, then what was loaded plays: Siri does not wait long.
 */
async function shuffleLibrary(deps: IntentDeps): Promise<IntentOutcome> {
  const api = online(deps);
  const now = deps.now ?? Date.now;
  const until = now() + (deps.libraryBudgetMs ?? libraryBudgetMs);
  const tracks: TrackSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.catalog.tracks({ cursor, limit: pageSize, sort: 'recent' });
    tracks.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && tracks.length < maxPlayed && now() < until);
  if (!tracks.some(deps.canPlay)) throw new IntentRefusal(intentText.emptyLibrary);
  deps.prime(tracks);
  deps.actions.playTracks(tracks.slice(0, maxPlayed), { shuffle: true, context: { type: 'other', id: null, title: 'Songs' } });
  return { wait: 'playback', result: {} };
}

async function radio(deps: IntentDeps): Promise<IntentOutcome> {
  const trackId = deps.currentTrackId();
  if (!trackId) throw new IntentRefusal(intentText.nothingPlaying);
  const radio = await online(deps).radio.track(trackId);
  if (!radio.tracks.length) throw new IntentRefusal(intentText.unknown);
  deps.actions.playRadio(radio);
  return { wait: 'playback', result: {} };
}

/** The library's answer at once and the catalog's if it comes soon, merged as Search merges them, playable only. */
export async function search(query: string, deps: IntentDeps): Promise<IntentItem[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  const api = online(deps);
  const params = { q, limit: searchLimit };
  const library = api.search.library(params).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const catalog = Promise.race<SearchResults | undefined>([
    api.search.catalog(params).catch(() => undefined),
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), catalogWaitMs); }),
  ]);
  const [local, remote] = await Promise.all([library, catalog]);
  clearTimeout(timer);
  if (!local && !remote) throw new IntentRefusal(intentText.offline);
  const merged = mergeSearch(local, remote, deps.viewer, { query: q });
  const items = merged.top && !merged.items.some(item => sameItem(item, merged.top!)) ? [merged.top, ...merged.items] : merged.items;
  return items.filter(item => plays(item, deps)).slice(0, searchLimit).map(item => intentItem(item, deps.serverUrl));
}

function sameItem(a: SearchItem, b: SearchItem): boolean {
  return a.type === b.type && idOfSearch(a) === idOfSearch(b);
}

function idOfSearch(item: SearchItem): string {
  switch (item.type) {
    case 'album': return item.album.id;
    case 'artist': return item.artist.id;
    case 'playlist': return item.playlist.id;
    case 'track': return item.track.id;
  }
}

function plays(item: SearchItem, deps: IntentDeps): boolean {
  switch (item.type) {
    case 'album': return albumPresentation(item.album, deps.viewer) === 'normal';
    case 'track': return deps.canPlay(item.track);
    default: return true;
  }
}

export function intentItem(item: SearchItem, serverUrl: string): IntentItem {
  const art = (artwork: Artwork | null | undefined) => {
    const url = artworkUrl(serverUrl, artwork, artworkSize);
    return url ? { artworkUrl: url } : {};
  };
  switch (item.type) {
    case 'album': return { id: `album:${item.album.id}`, kind: 'album', title: item.album.title, subtitle: `Album · ${item.album.artistCredit}`, ...art(item.album.artwork) };
    case 'artist': return { id: `artist:${item.artist.id}`, kind: 'artist', title: item.artist.name, subtitle: 'Artist', ...art(item.artist.image) };
    case 'playlist': return { id: `playlist:${item.playlist.id}`, kind: 'playlist', title: item.playlist.name, subtitle: `Playlist · ${item.playlist.ownerName}`, ...art(item.playlist.artworks[0]) };
    case 'track': return { id: `track:${item.track.id}`, kind: 'track', title: item.track.title, subtitle: `Song · ${item.track.artistCredit}`, ...art(item.track.album?.artwork) };
  }
}

/** Names for saved shortcuts' items the intents no longer remember. One the server no longer has is left out. */
async function lookup(ids: readonly string[], deps: IntentDeps): Promise<IntentItem[]> {
  const api = online(deps);
  const found = await Promise.all(ids.slice(0, 20).map(async (id): Promise<IntentItem | null> => {
    const [kind] = id.split(':');
    const key = idOf(id);
    try {
      switch (kind) {
        case 'liked': return { id: 'liked', kind: 'liked', title: 'Liked Songs', subtitle: 'Playlist' };
        case 'album': return intentItem({ type: 'album', album: await api.catalog.album(key) }, deps.serverUrl);
        case 'artist': return intentItem({ type: 'artist', artist: await api.catalog.artist(key) }, deps.serverUrl);
        case 'playlist': return intentItem({ type: 'playlist', playlist: await api.userdata.playlist(key) }, deps.serverUrl);
        case 'track': return intentItem({ type: 'track', track: await api.catalog.track(key) }, deps.serverUrl);
        default: return null;
      }
    } catch {
      return null;
    }
  }));
  return found.filter((item): item is IntentItem => item !== null);
}

/** What the session played from, as a Siri donation: only what an intent can play again. */
export function donationFor(context: PlaybackContext | null | undefined): IntentItem | null {
  if (!context?.title) return null;
  switch (context.type) {
    case 'album':
    case 'playlist':
    case 'artist':
    case 'mix':
      return context.id ? { id: `${context.type}:${context.id}`, kind: context.type, title: context.title } : null;
    case 'liked': return { id: 'liked', kind: 'liked', title: 'Liked Songs', subtitle: 'Playlist' };
    case 'radio': return context.id && /^(track|artist):/.test(context.id) ? { id: `radio:${context.id}`, kind: 'radio', title: context.title } : null;
    default: return null;
  }
}

