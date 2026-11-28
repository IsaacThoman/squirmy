import { formatBytes, GIGABYTE, plural, reduceSession, type Session } from '@squirmy/client-core';
import type { PlaybackDescriptor, QueueEntry, StreamQuality, TrackSummary } from '@squirmy/contracts';
import { checkIntervalMs, type NetworkKind } from '../downloads/model';

/**
 * One recording kept by the streaming cache, in one quality. Unlike a download nobody
 * asked for it: it is here because it was played or is about to be, and it goes when the
 * cache needs the room.
 */
export type CacheRow = {
  trackId: string;
  /** The album the file was asked for, which decides which file the server picks. */
  albumId: string | null;
  quality: StreamQuality;
  /** The file in the cache folder. */
  file: string;
  /** The server's file, to notice when it has been replaced. */
  fileId: string;
  bytes: number;
  /** The cover of the track's album, kept next to the audio. */
  art: string | null;
  /** What the server said it delivers, kept for the normalization values and the codec. */
  descriptor: Omit<PlaybackDescriptor, 'url' | 'expiresAt'>;
  /** Enough to show the track with no connection. */
  track: TrackSummary | null;
  addedAt: number;
  /** Null for a file fetched ahead that has not been played yet. */
  playedAt: number | null;
  /** When the server last confirmed the file is still the one it would serve. */
  checkedAt: number;
};

export const defaultLimitBytes = 2 * GIGABYTE;
/** The sizes Settings offers. Zero turns the cache off. */
export const limitOptions: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Off' },
  ...[1, 2, 5, 10].map(size => ({ value: size * GIGABYTE, label: `${size} GB` })),
];

/** Queue entries fetched ahead of the one playing. */
export const aheadCount = 2;
/** How far past the current entry the queue is read: far enough to find two ready entries behind ones still being prepared. */
export const lookahead = 5;
/** Nothing is fetched with less room than this on the device. */
export const minFreeBytes = 500 * 1024 ** 2;
/** Tries before a fetch is left alone until the track comes round again. */
export const maxAttempts = 3;

const order: readonly StreamQuality[] = ['data_saver', 'high', 'original'];
const rank = (quality: StreamQuality) => order.indexOf(quality);

/**
 * The copy to play when `wanted` would stream: that quality or, failing that, the nearest
 * better one, which costs nothing to play. With `any`, a lesser one rather than none, for
 * when the server cannot be reached.
 */
export function pick(copies: readonly CacheRow[], wanted: StreamQuality, any = false): CacheRow | undefined {
  const enough = copies.filter(row => rank(row.quality) >= rank(wanted)).sort((a, b) => rank(a.quality) - rank(b.quality));
  if (enough.length || !any) return enough[0];
  return [...copies].sort((a, b) => rank(b.quality) - rank(a.quality))[0];
}

const kbps: Record<StreamQuality, number> = { original: 1000, high: 256, data_saver: 192 };

/** A guess at a file's size before the server has said it: lossless for Original, the transcode's bitrate otherwise. */
export function estimateBytes(quality: StreamQuality, durationMs: number): number {
  return Math.round(kbps[quality] * 125 * durationMs / 1000);
}

/** When a row was last useful: played, or fetched to be played. */
export function lastUsed(row: Pick<CacheRow, 'playedAt' | 'addedAt'>): number {
  return row.playedAt ?? row.addedAt;
}

/**
 * A row another account on this device keeps. The limit is the device's, so these count
 * toward it and go like any other, least recently played first; they are never played here.
 */
export type ForeignRow = Pick<CacheRow, 'trackId' | 'quality' | 'file' | 'art' | 'bytes' | 'addedAt' | 'playedAt'> & { account: string };

/** The rows to remove so the cache fits `limitBytes`: least recently played first, never a track in `keep`. */
export function evictions(rows: readonly CacheRow[], limitBytes: number, keep: ReadonlySet<string>): CacheRow[] {
  return evictionsAcross(rows, [], limitBytes, keep).own;
}

/** As `evictions`, with other accounts' rows counted toward the limit too. `keep` names this account's tracks only. */
export function evictionsAcross(rows: readonly CacheRow[], foreign: readonly ForeignRow[], limitBytes: number, keep: ReadonlySet<string>) {
  let total = [...rows, ...foreign].reduce((sum, row) => sum + row.bytes, 0);
  const own: CacheRow[] = [];
  const others: ForeignRow[] = [];
  const candidates = [
    ...rows.filter(row => !keep.has(row.trackId)).map(row => ({ row, foreign: false as const })),
    ...foreign.map(row => ({ row, foreign: true as const })),
  ].sort((a, b) => lastUsed(a.row) - lastUsed(b.row));
  for (const candidate of candidates) {
    if (total <= limitBytes) break;
    if (candidate.foreign) others.push(candidate.row);
    else own.push(candidate.row);
    total -= candidate.row.bytes;
  }
  return { own, foreign: others };
}

/**
 * What the cache folder and the index disagree on after a launch. The system may empty
 * the folder while the app is closed, so a row whose file is gone or cut short is
 * forgotten (`lost`), as is a file no row of any account names (`orphans`).
 */
export function reconcile(rows: readonly CacheRow[], files: ReadonlyMap<string, number>, referenced: ReadonlySet<string>) {
  const orphans = [...files.keys()].filter(name => !referenced.has(name));
  const lost = rows.filter(row => files.get(row.file) !== row.bytes);
  const updates = rows.filter(row => !lost.includes(row) && row.art !== null && !files.has(row.art)).map(row => ({ ...row, art: null }));
  return { orphans, lost, updates };
}

/** The part of a queue entry the cache needs. */
export type Near = Pick<QueueEntry, 'trackId' | 'albumId' | 'durationMs' | 'state'>;

/**
 * What the session will play soon, as this device sees it.
 * - `active`: this device plays the session.
 * - `idle`: no device does; pressing play would start it here.
 * - `remote`: another device does, and this one is only its remote.
 */
export type Outlook = {
  role: 'active' | 'idle' | 'remote';
  current: Near | null;
  /** The entries that follow, nearest first, whatever their state. */
  upcoming: readonly Near[];
};

export const nothingNear: Outlook = { role: 'idle', current: null, upcoming: [] };

const near = ({ trackId, albumId, durationMs, state }: QueueEntry): Near => ({ trackId, albumId, durationMs, state });

/**
 * Reads the outlook from the session by ending the current entry a few times with the
 * shared reducer, so shuffle, repeat and autoplay are followed exactly as playback will.
 */
export function outlookOf(session: Session, role: Outlook['role']): Outlook {
  if (!session.current) return { role, current: null, upcoming: session.queue.slice(0, lookahead).map(near) };
  const upcoming: Near[] = [];
  let state = session;
  for (let step = 0; step < lookahead; step += 1) {
    const ended = state.current!;
    const next = reduceSession(state, { command: { type: 'trackEnded', entryId: ended.id }, now: state.anchorAt, commandId: `ahead-${step}` });
    if (!next.current || next.current.id === ended.id) break;
    upcoming.push(near(next.current));
    state = next;
  }
  return { role, current: near(session.current), upcoming };
}

export function sameOutlook(a: Outlook, b: Outlook): boolean {
  const same = (x: Near | null | undefined, y: Near | null | undefined) => x?.trackId === y?.trackId && x?.albumId === y?.albumId && x?.state === y?.state;
  return a.role === b.role && same(a.current, b.current) && a.upcoming.length === b.upcoming.length
    && a.upcoming.every((entry, index) => same(entry, b.upcoming[index]));
}

/** The tracks whose files the player may hold open: what plays (or would on play) and what follows it. */
export function inUse({ role, current, upcoming }: Outlook): Set<string> {
  return new Set(role === 'remote' ? [] : [current, upcoming[0]].flatMap(entry => entry?.trackId ?? []));
}

/** How eagerly the cache fills: entries fetched ahead, whether the stream being played is fetched as well, and fetches at once. */
export type Policy = { ahead: number; current: boolean; concurrency: number };
const idle: Policy = { ahead: 0, current: false, concurrency: 0 };

/**
 * Wi-Fi fetches the next two entries, two at a time. With the classic player it also
 * fetches the playing stream a second time to keep it, since that player gives no access to
 * the bytes it streams; the native engine keeps what it streams itself (`shared`), so the
 * stream is fetched once, on any network. Cellular fetches ahead too, one at a time, since
 * those bytes would be streamed anyway, but never pays twice for the stream being played,
 * and fetches nothing ahead when the user chose Data Saver there.
 */
export function policyFor(network: NetworkKind, cellularQuality: StreamQuality, shared = false): Policy {
  if (network === 'none') return idle;
  if (network === 'cellular') return cellularQuality === 'data_saver' ? idle : { ahead: aheadCount, current: false, concurrency: 1 };
  return { ahead: aheadCount, current: !shared, concurrency: 2 };
}

/** A track to fetch, or with `check` only to ask the server whether its cached file is still current. */
export type Target = { trackId: string; albumId: string | null; quality: StreamQuality; check: boolean };

export type PlanInput = {
  outlook: Outlook;
  network: NetworkKind;
  /** The server can be reached. */
  online: boolean;
  /** What streams on this network, from the user's Wi-Fi and cellular settings. */
  quality: StreamQuality;
  cellularQuality: StreamQuality;
  limitBytes: number;
  /** Bytes free on the device. */
  freeBytes: number;
  now: number;
  /** A track's cached copies. */
  copies: (trackId: string) => readonly CacheRow[];
  downloaded: (trackId: string) => boolean;
  /** The fetches in flight, with the quality each asks for. */
  running: ReadonlyMap<string, StreamQuality>;
  /** A file's size, once the server has said it. */
  size: (trackId: string) => number | undefined;
  /** When a track whose fetch failed may be tried again. */
  retryAt: (trackId: string) => number | undefined;
  /**
   * The engine keeps what it streams (the native engine): a fetch reads the same download a
   * load of that stream does. The stream being played is then never fetched again, and a
   * fetch of it already running is left to finish, since it is the download being played.
   */
  shared?: boolean;
};

export type Plan = {
  /** Fetches to begin now, nearest first. */
  start: Target[];
  /** Fetches in flight for tracks that are no longer near, or in a quality no longer wanted. */
  cancel: string[];
  /** Tracks whose files stay whatever the limit says: the ones in use and the ones about to play. */
  keep: Set<string>;
};

/**
 * Decides what to fetch and what to stop fetching. The entries about to play must fit
 * the limit on their own: a track is fetched only when it does, so making room never
 * means evicting something that was just fetched.
 */
export function plan(input: PlanInput): Plan {
  const { outlook, quality, now } = input;
  const { role, current, upcoming } = outlook;
  const keep = inUse(outlook);
  if (role === 'remote') return { start: [], cancel: [...input.running.keys()], keep };

  const bytesOf = (trackId: string) => input.copies(trackId).reduce((sum, row) => sum + row.bytes, 0);
  let room = input.limitBytes;
  for (const trackId of keep) room -= bytesOf(trackId);

  const policy = input.limitBytes > 0 ? policyFor(input.network, input.cellularQuality, input.shared) : idle;
  const ready = (entry: Near | null): entry is Near => entry?.state === 'ready';
  const ahead = upcoming.filter(ready);
  // With nothing playing the current entry is what play would start. While it plays, what follows matters more.
  const order = role === 'idle' ? [current, ...ahead].filter(ready).slice(0, aheadCount) : [...ahead.slice(0, aheadCount), ...[current].filter(ready)];

  const targets: Target[] = [];
  const seen = new Set<string>();
  for (const entry of order) {
    const { trackId } = entry;
    if (seen.has(trackId) || input.downloaded(trackId)) continue;
    seen.add(trackId);
    const streaming = role === 'active' && entry === current;
    const allowed = policy.ahead > 0 && (!streaming || policy.current);
    const copy = pick(input.copies(trackId), quality);
    if (copy) {
      if (!keep.has(trackId)) {
        if (bytesOf(trackId) > room) continue;
        room -= bytesOf(trackId);
        keep.add(trackId);
      }
      // Asked about the album it was fetched for: the same recording on another album may be another file.
      if (allowed && now - copy.checkedAt >= checkIntervalMs) targets.push({ trackId, albumId: copy.albumId, quality: copy.quality, check: true });
      continue;
    }
    if (!allowed) continue;
    const size = input.size(trackId) ?? estimateBytes(quality, entry.durationMs);
    if (size > room) continue;
    room -= size;
    targets.push({ trackId, albumId: entry.albumId, quality, check: false });
  }
  // Cached entries further down the queue stay too while there is room, rather than being evicted and fetched again.
  for (const { trackId } of upcoming) {
    if (keep.has(trackId) || !input.copies(trackId).length || bytesOf(trackId) > room) continue;
    room -= bytesOf(trackId);
    keep.add(trackId);
  }

  const wanted = new Map(targets.map(target => [target.trackId, target.quality]));
  const playing = role === 'active' && input.shared ? current?.trackId : undefined;
  const stays = (trackId: string) => input.running.get(trackId) === wanted.get(trackId) || trackId === playing;
  const cancel = [...input.running.keys()].filter(trackId => !stays(trackId));
  let free = input.online && input.freeBytes >= minFreeBytes ? policy.concurrency - (input.running.size - cancel.length) : 0;
  const start: Target[] = [];
  for (const target of targets) {
    if (free <= 0) break;
    if (input.running.has(target.trackId) && stays(target.trackId)) continue;
    if ((input.retryAt(target.trackId) ?? 0) > now) continue;
    start.push(target);
    free -= 1;
  }
  return { start, cancel, keep };
}

/**
 * What Clear in Settings takes away, said before it happens: the cached songs stop playing
 * offline. Downloads are kept apart and stay.
 */
export function clearCacheMessage({ count, usedBytes }: { count: number; usedBytes: number }, device: string): string {
  return `The ${plural(count, 'song')} (${formatBytes(usedBytes)}) kept from streaming will be removed from this ${device} and won’t play without a connection until you play them again. Downloads stay.`;
}
