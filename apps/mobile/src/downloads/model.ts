import { ApiError, formatBytes, GIGABYTE, isPlayable, plural, UNAVAILABLE_LABEL, type Viewer } from '@squirmy/client-core';
import type {
  AcquisitionJob, AlbumDetail, Artwork, PlaybackDescriptor, PlaylistSummary, StreamQuality, TrackSummary,
} from '@squirmy/contracts';

/**
 * - `fetching`: the server does not have the song yet and was asked to get it; it is
 *   downloaded once the server has it. `retryAt` is when to ask again if no word came.
 * - `queued`: waiting for its turn, for Wi-Fi, for the server, or for a retry.
 * - `downloading`: a transfer is running.
 * - `done`: the file is on the device.
 * - `failed`: given up on after several tries; the person can retry.
 * - `unavailable`: the server could not get the song; the person can retry.
 */
export type DownloadState = 'fetching' | 'queued' | 'downloading' | 'done' | 'failed' | 'unavailable';

/** One recording kept on the device. Each recording is downloaded once, whatever lists it is in. */
export type DownloadRow = {
  trackId: string;
  /** The album the file was asked for, which decides which file the server picks. */
  albumId: string | null;
  state: DownloadState;
  quality: StreamQuality;
  /**
   * The file in the downloads folder. A row being refreshed (the server replaced its file)
   * keeps playing the old one until the new one is complete.
   */
  file: string | null;
  /** The cover of the track's album, kept next to the audio. */
  art: string | null;
  bytes: number | null;
  /** What the server said it would deliver, kept for the normalization values and the codec. */
  descriptor: Omit<PlaybackDescriptor, 'url' | 'expiresAt'> | null;
  /** Enough to show the track with no connection. */
  track: TrackSummary;
  attempts: number;
  retryAt: number | null;
  error: string | null;
  /** The server no longer has the track. The file stays until it is removed. */
  gone: boolean;
  addedAt: number;
  doneAt: number | null;
  /** When the server last confirmed the file is still the one it would serve. */
  checkedAt: number | null;
};

export type CollectionKind = 'album' | 'playlist' | 'liked' | 'songs';

/** Something downloaded as a whole: an album, a playlist, Liked Songs, or the songs downloaded one by one. */
export type CollectionRow = {
  /** `album:<id>`, `playlist:<id>`, `liked` or `songs`. */
  id: string;
  kind: CollectionKind;
  title: string;
  subtitle: string;
  artworks: readonly Artwork[];
  /** The album or playlist as last seen, so its page opens with no connection. */
  album: Omit<AlbumDetail, 'discs'> | null;
  playlist: PlaylistSummary | null;
  /**
   * All of its tracks in order, also those that will not download (the server has no file
   * and will not get one for this user), so its status counts every song.
   */
  trackIds: readonly string[];
  /** Cover files of `artworks`. */
  art: readonly string[];
  /** The server no longer has the album or playlist. Its downloads stay until removed. */
  gone: boolean;
  addedAt: number;
  syncedAt: number | null;
};

/** Why queued downloads are not running. */
export type WaitReason = 'offline' | 'wifi' | 'storage';

export type NetworkKind = 'wifi' | 'cellular' | 'other' | 'none';

export const songsId = 'songs';
export const likedId = 'liked';
export const albumCollectionId = (id: string) => `album:${id}`;
export const playlistCollectionId = (id: string) => `playlist:${id}`;

/** Downloads running at once. */
export const concurrency = 3;
/** Tries before a download is marked failed. */
export const maxAttempts = 5;
/** Downloaded files are checked against the server at most this often. */
export const checkIntervalMs = 24 * 3600_000;

/** Wait before the next try after `attempts` failures: 15 s, doubling, at most 15 minutes. */
export function retryDelay(attempts: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

/** Requests for a song the server is getting before it counts as not available: about an hour in all. */
export const maxFetchAsks = 8;
/** The acquire routes allow 120 requests a minute per user; one every 600 ms leaves room for playback's. */
export const fetchGapMs = 600;
/** How long requests stop after the server says too many were sent or are running. */
export const fetchPauseMs = 30_000;

/**
 * When to ask again about a song the server is getting, after `asks` requests: a minute,
 * doubling, at most 15 minutes. The server says when a song arrives (an `invalidate` of the
 * track); asking again covers a word that was missed, and a fetch that ended without one
 * (a source that is down records no miss, so nothing is invalidated).
 */
export function fetchRecheckDelay(asks: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, asks - 1), 15 * 60_000);
}

/** Why nothing may start now, or null when downloads can run. */
export function waitReason({ online, network, wifiOnly, usedBytes, capBytes }: {
  online: boolean; network: NetworkKind; wifiOnly: boolean; usedBytes: number; capBytes: number | null;
}): WaitReason | null {
  if (!online || network === 'none') return 'offline';
  if (wifiOnly && network === 'cellular') return 'wifi';
  if (capBytes !== null && usedBytes >= capBytes) return 'storage';
  return null;
}

/** The queued rows to start now, oldest first, filling the free slots. */
export function nextToStart(rows: Iterable<DownloadRow>, running: ReadonlySet<string>, now: number, slots = concurrency): DownloadRow[] {
  const free = slots - running.size;
  if (free <= 0) return [];
  return [...rows]
    .filter(row => row.state === 'queued' && !running.has(row.trackId) && (row.retryAt === null || row.retryAt <= now))
    .sort((a, b) => a.addedAt - b.addedAt)
    .slice(0, free);
}

/** A row after a failed try: queued again later, or failed once the tries run out (or there is no file to get). */
export function afterFailure(row: DownloadRow, error: string, now: number, final = false): DownloadRow {
  const attempts = row.attempts + 1;
  if (final || attempts >= maxAttempts) return { ...row, state: 'failed', attempts, retryAt: null, error };
  return { ...row, state: 'queued', attempts, retryAt: now + retryDelay(attempts), error };
}

/** What an acquire request said about the songs it named. */
export type AcquireOutcome =
  /** The server has them: download them. */
  | 'ready'
  /** The server is getting them. */
  | 'requested'
  /** The server cannot get them for this user. */
  | 'unavailable'
  /** Too many requests, or fetches running: ask again a little later, counting nothing. */
  | 'busy'
  /** No answer, or a server error: ask again later. */
  | 'error';

/** Reads the answer to `POST /tracks/:id/acquire` or `POST /albums/:id/acquire`. */
export function acquireOutcome(answer: { jobs: readonly Pick<AcquisitionJob, 'status'>[] } | { error: unknown }): AcquireOutcome {
  if ('error' in answer) {
    const { error } = answer;
    if (!(error instanceof ApiError)) return 'error';
    // `already_available`.
    if (error.status === 409) return 'ready';
    // The rate limit, or `acquire_limit_reached`.
    if (error.status === 429) return 'busy';
    // `acquire_not_allowed`, `not_available` (no provider can supply it), or no such track.
    if (error.status === 403 || error.status === 404) return 'unavailable';
    return 'error';
  }
  const { jobs } = answer;
  if (jobs.some(job => job.status === 'completed')) return 'ready';
  // A request that cannot go ahead is answered with a job that has already failed.
  if (jobs.length && jobs.every(job => job.status === 'failed' || job.status === 'rejected')) return 'unavailable';
  return 'requested';
}

/** A `fetching` row after an acquire request: queued to download, given up on, or asked about again later. */
export function afterAcquire(row: DownloadRow, outcome: Exclude<AcquireOutcome, 'busy'>, now: number): DownloadRow {
  if (outcome === 'ready') return { ...row, state: 'queued', attempts: 0, retryAt: null, error: null };
  const attempts = row.attempts + 1;
  if (outcome === 'unavailable' || attempts >= maxFetchAsks) {
    return { ...row, state: 'unavailable', attempts, retryAt: null, error: UNAVAILABLE_LABEL };
  }
  return { ...row, attempts, retryAt: now + (outcome === 'requested' ? fetchRecheckDelay(attempts) : retryDelay(attempts)) };
}

/** The `fetching` rows to ask the server about now, oldest first. */
export function dueFetches(rows: Iterable<DownloadRow>, now: number): DownloadRow[] {
  return [...rows].filter(row => row.state === 'fetching' && (row.retryAt === null || row.retryAt <= now))
    .sort((a, b) => a.addedAt - b.addedAt);
}

/**
 * A row after the server described its track again. A song the server is getting is queued
 * once it has it, and given up on when no one can have it; one given up on is queued once
 * the server has it after all (someone else got it); a queued song whose file the server
 * let go is asked for again, when this user may ask.
 */
export function withTrack(row: DownloadRow, track: TrackSummary, canFetch: boolean): DownloadRow {
  const gone = track.availability === 'none';
  const next = gone !== row.gone || JSON.stringify(row.track) !== JSON.stringify(track) ? { ...row, track, gone } : row;
  if (row.file) return next;
  const state = stateFor(row.state, track.availability, canFetch);
  if (state === row.state) return next;
  return { ...next, state, attempts: 0, retryAt: null, error: state === 'unavailable' ? UNAVAILABLE_LABEL : null };
}

function stateFor(state: DownloadState, availability: TrackSummary['availability'], canFetch: boolean): DownloadState {
  switch (availability) {
    case 'server': return state === 'fetching' || state === 'unavailable' ? 'queued' : state;
    case 'none': return state === 'fetching' ? 'unavailable' : state;
    case 'on_demand':
      if (state === 'fetching' && !canFetch) return 'unavailable';
      return state === 'queued' && canFetch ? 'fetching' : state;
  }
}

/** Whether a finished transfer is whole: it must match the size the server announced, when it announced one. */
export function sizeMatches(written: number | null, expected: readonly (number | null | undefined)[]): boolean {
  if (written === null || written <= 0) return false;
  return expected.every(size => size === null || size === undefined || size < 0 || size === written);
}

const extensions: Record<string, string> = {
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/aacp': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
};
const codecExtensions: Record<string, string> = { flac: 'flac', mp3: 'mp3', aac: 'm4a', alac: 'm4a', opus: 'ogg', vorbis: 'ogg', wav: 'wav', aiff: 'aiff' };

/** The file extension AVPlayer needs to recognise a local file. */
export function extensionFor(descriptor: Pick<PlaybackDescriptor, 'mime' | 'codec' | 'transcoded'>): string {
  // Transcodes to AAC are raw ADTS streams, not MP4.
  if (descriptor.transcoded && descriptor.codec === 'aac') return 'aac';
  return extensions[descriptor.mime.split(';')[0]!.trim().toLowerCase()] ?? codecExtensions[descriptor.codec] ?? 'audio';
}

/**
 * What the track looks like downloaded: the third availability tier, on top of the server's.
 * A song the server is still getting looks queued: to the person it is waiting to download.
 */
export type TrackDownload =
  | { state: 'queued'; wait: WaitReason | 'retry' | null }
  | { state: 'downloading'; progress: number }
  | { state: 'done'; bytes: number; gone: boolean }
  | { state: 'failed'; error: string; unavailable?: true };

/** A row as the screens show it. A row with a file plays from it even while a newer one downloads. */
export function trackDownload(row: DownloadRow | undefined, progress: number | undefined, wait: WaitReason | null): TrackDownload | undefined {
  if (!row) return undefined;
  if (row.file) return { state: 'done', bytes: row.bytes ?? 0, gone: row.gone };
  switch (row.state) {
    case 'downloading': return { state: 'downloading', progress: progress ?? 0 };
    case 'failed': return { state: 'failed', error: row.error ?? 'The download failed.' };
    case 'unavailable': return { state: 'failed', error: UNAVAILABLE_LABEL, unavailable: true };
    case 'queued': return { state: 'queued', wait: row.retryAt !== null ? 'retry' : wait };
    // Asking the server needs only a connection; Wi-Fi and the storage limit hold up the download after it.
    case 'fetching': return { state: 'queued', wait: wait === 'offline' ? wait : null };
    case 'done': return { state: 'done', bytes: row.bytes ?? 0, gone: row.gone };
  }
}

export type CollectionDownload = {
  /**
   * `done` only when every song of the collection is on the device. `incomplete`: nothing
   * is left to do, but some songs are not available, so what is on the device is all of it.
   */
  state: 'queued' | 'downloading' | 'done' | 'failed' | 'incomplete';
  /** Tracks downloaded, and in the collection (every song it lists). */
  done: number;
  total: number;
  /** Downloads given up on after several tries. */
  failed: number;
  /** Songs that will not download: the server has no file and cannot get one for this user. */
  unavailable: number;
  /** Whether a retry could change anything: a download failed, or the server could not get a song. */
  retryable: boolean;
  /** 0 to 1, by tracks, counting the running ones' progress. */
  progress: number;
  bytes: number;
  wait: WaitReason | null;
  gone: boolean;
};

/**
 * A collection's downloads summed up. Every song it lists counts, so one the server is
 * still getting keeps it downloading, and one that cannot be had keeps it from `done`.
 */
export function collectionDownload(collection: CollectionRow, rows: ReadonlyMap<string, DownloadRow>,
  progress: ReadonlyMap<string, number>, wait: WaitReason | null): CollectionDownload {
  let done = 0;
  let failed = 0;
  let unavailable = 0;
  let givenUp = 0;
  let running = 0;
  let fetching = 0;
  let queued = 0;
  let partial = 0;
  let bytes = 0;
  for (const id of collection.trackIds) {
    const row = rows.get(id);
    // No row: the server has no file of the song and would not get one for this user.
    if (!row) unavailable += 1;
    else if (row.file) {
      done += 1;
      bytes += row.bytes ?? 0;
    } else if (row.state === 'failed') failed += 1;
    else if (row.state === 'unavailable') {
      unavailable += 1;
      givenUp += 1;
    } else if (row.state === 'downloading') {
      running += 1;
      partial += progress.get(id) ?? 0;
    } else if (row.state === 'fetching') fetching += 1;
    else queued += 1;
  }
  const total = collection.trackIds.length;
  // The server is asked for songs over any connection; it is the downloads that wait for Wi-Fi or space.
  const held = wait === 'offline' || (queued > 0 && wait !== null);
  const state = done === total ? 'done' : running || (fetching && !held) ? 'downloading'
    : fetching || queued ? 'queued' : failed ? 'failed' : 'incomplete';
  return {
    state, done, total, failed, unavailable, retryable: failed + givenUp > 0, progress: total ? (done + partial) / total : 1, bytes,
    wait: state === 'queued' ? wait : null, gone: collection.gone,
  };
}

const waiting: Record<WaitReason, string> = {
  offline: 'Waiting for the server',
  wifi: 'Waiting for Wi-Fi',
  storage: 'Storage limit reached',
};

const songs = (count: number) => plural(count, 'song');

/**
 * The line under a collection's buttons while it is downloaded or downloading. It counts
 * every song of the collection, says "Downloaded" only once all of them are on the device,
 * and names the songs that will not come ("1 not available"). A song the server is still
 * getting counts as downloading, like one whose transfer runs.
 */
export function downloadStatus(download: CollectionDownload): { icon: string; text: string; retry?: boolean } {
  const missing = download.unavailable ? ` · ${download.unavailable} not available` : '';
  switch (download.state) {
    case 'queued': return { icon: 'arrow.down.circle.dotted', text: (download.wait ? waiting[download.wait] : 'Waiting to download') + missing };
    case 'downloading': return {
      icon: 'arrow.down.circle.dotted', text: `Downloading ${Math.min(download.done + 1, download.total)} of ${download.total}${missing}`,
    };
    case 'failed': return { icon: 'exclamationmark.circle', text: `${songs(download.failed)} couldn’t be downloaded${missing}`, retry: true };
    case 'incomplete': return {
      icon: 'exclamationmark.circle', text: `${download.done} of ${download.total} downloaded${missing}`, retry: download.retryable,
    };
    case 'done': return {
      icon: 'arrow.down.circle.fill',
      text: download.gone ? 'Downloaded · No longer on the server' : `Downloaded · ${formatBytes(download.bytes)}`,
    };
  }
}

/**
 * What the downloads folder and the index disagree on after a launch: files no row of any
 * account names (left by a crash, or by a removal that stopped half way), rows whose file
 * is gone or cut short, and rows that were downloading when the app was killed.
 */
export function reconcile(rows: readonly DownloadRow[], files: ReadonlyMap<string, number>, referenced: ReadonlySet<string>) {
  const orphans = [...files.keys()].filter(name => !referenced.has(name));
  const updates: DownloadRow[] = [];
  for (const row of rows) {
    const size = row.file ? files.get(row.file) : undefined;
    const intact = row.file !== null && size !== undefined && (row.bytes === null || size === row.bytes);
    const art = row.art && files.has(row.art) ? row.art : null;
    if (row.file && !intact) {
      updates.push({ ...row, state: 'queued', file: null, art, bytes: null, attempts: 0, retryAt: null, error: null, doneAt: null });
    } else if (row.state === 'downloading') {
      updates.push({ ...row, state: 'queued', art, retryAt: null });
    } else if (art !== row.art) {
      updates.push({ ...row, art });
    }
  }
  return { orphans, updates };
}

/** Rows no collection lists any more. */
export function unreferenced(rows: Iterable<DownloadRow>, collections: Iterable<CollectionRow>): string[] {
  const kept = new Set<string>();
  for (const collection of collections) for (const id of collection.trackIds) kept.add(id);
  return [...rows].filter(row => !kept.has(row.trackId)).map(row => row.trackId);
}

/**
 * Whether `track` can be played now: a download or a cached copy always can; with no
 * connection nothing else can; otherwise client-core's rule decides (`isPlayable`: what the
 * server has, and what it fetches for this viewer).
 */
export function canPlay(track: Pick<TrackSummary, 'id' | 'availability'>, { offline, onDevice, viewer }: {
  offline: boolean; onDevice: (trackId: string) => boolean; viewer: Viewer | null | undefined;
}): boolean {
  if (onDevice(track.id)) return true;
  if (offline) return false;
  return isPlayable(track, viewer);
}

/**
 * A size limit as chosen, from one saved before limits were counted in 1024s, when
 * `5 GB` was 5·1000³ bytes: the same choice in today's gigabytes. Anything else is as saved.
 */
export function savedLimit<T extends number | null | undefined>(bytes: T): T {
  if (typeof bytes !== 'number' || bytes <= 0) return bytes;
  const decimal = bytes / 1000 ** 3;
  return (Number.isInteger(decimal) ? decimal * GIGABYTE : bytes) as T;
}

/** The small mark a downloaded (or downloading) track carries next to its artist. */
export function downloadSymbol(download: TrackDownload | undefined): string | null {
  switch (download?.state) {
    case 'done': return 'arrow.down.circle.fill';
    case 'queued':
    case 'downloading': return 'arrow.down.circle.dotted';
    case 'failed': return 'exclamationmark.circle';
    default: return null;
  }
}

/**
 * Why a gray track is gray, in the one or two words every surface uses: offline it is
 * "Not downloaded" (it would play with a connection), otherwise "Not available".
 */
export function unavailableReason(track: Pick<TrackSummary, 'availability'>, offline: boolean, viewer: Viewer | null | undefined): string {
  return offline && isPlayable(track, viewer) ? NOT_DOWNLOADED_LABEL : UNAVAILABLE_LABEL;
}

export const NOT_DOWNLOADED_LABEL = 'Not downloaded';

/** The page a song downloaded on its own opens: its album, or its first artist when it has no album. */
export function songPage(track: Pick<TrackSummary, 'album' | 'artists'>): { page: 'album' | 'artist'; id: string } | null {
  if (track.album) return { page: 'album', id: track.album.id };
  const artist = track.artists[0];
  return artist ? { page: 'artist', id: artist.id } : null;
}
