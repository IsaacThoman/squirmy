import type {
  AlbumDetail, Artwork, PlaybackDescriptor, PlaylistSummary, StreamQuality, TrackSummary, User,
} from '@squirmy/contracts';

/**
 * - `queued`: waiting for its turn, for Wi-Fi, for the server, or for a retry.
 * - `downloading`: a transfer is running.
 * - `done`: the file is on the device.
 * - `failed`: given up on after several tries; the person can retry.
 */
export type DownloadState = 'queued' | 'downloading' | 'done' | 'failed';

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
  /** Its tracks in order. */
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

/** What the track looks like downloaded: the third availability tier, on top of the server's. */
export type TrackDownload =
  | { state: 'queued'; wait: WaitReason | 'retry' | null }
  | { state: 'downloading'; progress: number }
  | { state: 'done'; bytes: number; gone: boolean }
  | { state: 'failed'; error: string };

/** A row as the screens show it. A row with a file plays from it even while a newer one downloads. */
export function trackDownload(row: DownloadRow | undefined, progress: number | undefined, wait: WaitReason | null): TrackDownload | undefined {
  if (!row) return undefined;
  if (row.file) return { state: 'done', bytes: row.bytes ?? 0, gone: row.gone };
  switch (row.state) {
    case 'downloading': return { state: 'downloading', progress: progress ?? 0 };
    case 'failed': return { state: 'failed', error: row.error ?? 'The download failed.' };
    case 'queued': return { state: 'queued', wait: row.retryAt !== null ? 'retry' : wait };
    case 'done': return { state: 'done', bytes: row.bytes ?? 0, gone: row.gone };
  }
}

export type CollectionDownload = {
  state: 'queued' | 'downloading' | 'done' | 'failed';
  /** Tracks downloaded, and in the collection. */
  done: number;
  total: number;
  /** 0 to 1, by tracks, counting the running ones' progress. */
  progress: number;
  bytes: number;
  wait: WaitReason | null;
  gone: boolean;
};

/** A collection's downloads summed up: done when every track is, failed when the rest have all failed. */
export function collectionDownload(collection: CollectionRow, rows: ReadonlyMap<string, DownloadRow>,
  progress: ReadonlyMap<string, number>, wait: WaitReason | null): CollectionDownload {
  let done = 0;
  let failed = 0;
  let running = 0;
  let partial = 0;
  let bytes = 0;
  for (const id of collection.trackIds) {
    const row = rows.get(id);
    if (!row) continue;
    if (row.file) {
      done += 1;
      bytes += row.bytes ?? 0;
    } else if (row.state === 'failed') failed += 1;
    else if (row.state === 'downloading') {
      running += 1;
      partial += progress.get(id) ?? 0;
    }
  }
  const total = collection.trackIds.length;
  const state = done === total ? 'done' : running ? 'downloading' : done + failed === total ? 'failed' : 'queued';
  return { state, done, total, progress: total ? (done + partial) / total : 1, bytes, wait: state === 'queued' ? wait : null, gone: collection.gone };
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

/** Admins, and members allowed to, may have on-demand tracks fetched; for others those tracks are gray. */
export function canRequestMusic(user: Pick<User, 'role' | 'canAcquire'>): boolean {
  return user.role === 'admin' || user.canAcquire;
}

/**
 * Whether `track` can be played: with no connection only downloads can; otherwise what the
 * server has, what it can fetch when `canRequest`, and downloads.
 */
export function canPlay(track: Pick<TrackSummary, 'id' | 'availability'>, { offline, downloaded, canRequest }: {
  offline: boolean; downloaded: (trackId: string) => boolean; canRequest: boolean;
}): boolean {
  if (downloaded(track.id)) return true;
  if (offline) return false;
  return track.availability === 'server' || (track.availability === 'on_demand' && canRequest);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000 ** 2) return `${Math.max(0, Math.round(bytes / 1000))} KB`;
  if (bytes < 1000 ** 3) return `${(bytes / 1000 ** 2).toFixed(bytes < 10 * 1000 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1000 ** 3).toFixed(bytes < 10 * 1000 ** 3 ? 1 : 0)} GB`;
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

/** Why a gray track is gray, for screen readers. */
export function unavailableReason(track: Pick<TrackSummary, 'availability'>, offline: boolean): string {
  if (offline && track.availability !== 'none') return 'not downloaded';
  return track.availability === 'on_demand' ? 'not on the server yet; ask an admin to let you fetch missing music' : 'not in your library';
}

/** The small mark next to a track's artist: its download, or that the server fetches it when played. */
export function trackMark(download: TrackDownload | undefined, track: Pick<TrackSummary, 'availability'>, playable: boolean): string | null {
  return downloadSymbol(download) ?? (track.availability === 'on_demand' && playable ? 'icloud.and.arrow.down' : null);
}

/** The page a song downloaded on its own opens: its album, or its first artist when it has no album. */
export function songPage(track: Pick<TrackSummary, 'album' | 'artists'>): { page: 'album' | 'artist'; id: string } | null {
  if (track.album) return { page: 'album', id: track.album.id };
  const artist = track.artists[0];
  return artist ? { page: 'artist', id: artist.id } : null;
}
