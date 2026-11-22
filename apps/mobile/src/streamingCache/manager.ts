import { ApiError } from '@squirmy/client-core';
import type { Artwork, PlaybackDescriptor, StreamQuality, TrackSummary } from '@squirmy/contracts';
import type { DownloadNetwork } from '../downloads/manager';
import { extensionFor, retryDelay, sizeMatches } from '../downloads/model';
import {
  estimateBytes, evictions, inUse, maxAttempts, nothingNear, pick, plan, reconcile, sameOutlook, type CacheRow, type Outlook,
  type Plan, type Target,
} from './model';

/** The index of the cache, for one account. Writes are synchronous so a row and its file change together. */
export type CacheIndex = {
  load(): CacheRow[];
  put(rows: readonly CacheRow[]): void;
  remove(rows: readonly Pick<CacheRow, 'trackId' | 'quality'>[]): void;
  /** Forgets every other account's rows. One account is signed in at a time, so they are left over from one that left. */
  removeOthers(): void;
  /** Every file any account's rows use; the rest of the folder can go. */
  referencedFiles(): Set<string>;
};

/** The cache folder. */
export type CacheFiles = {
  /**
   * Fetches `url` into `name`, which appears only once it is whole. `done` resolves with
   * the bytes on disk and the length the server announced (-1 when it sent none).
   */
  fetch(url: string, name: string): { done: Promise<{ written: number; total: number }>; cancel(): void };
  /** Fetches a small file, such as a cover, in one go. */
  fetchSmall(url: string, name: string): Promise<void>;
  remove(name: string): void;
  exists(name: string): boolean;
  /** Every file in the folder, with its size. */
  list(): Map<string, number>;
  uri(name: string): string;
  /** A name no other file has or will have. */
  newName(extension: string): string;
  /** Bytes free on the device. */
  freeBytes(): number;
};

/** The server, as the cache needs it. */
export type CacheSource = {
  /** `GET /tracks/:id/playback` as the player asks it, so the cached file is the one that would have streamed. */
  describe(trackId: string, albumId: string | null, quality: StreamQuality): Promise<PlaybackDescriptor>;
  url(descriptor: PlaybackDescriptor): string;
  /** The track as the app knows it, for its cover and for showing it with no connection. */
  track(trackId: string, albumId: string | null): Promise<TrackSummary | null>;
  artworkUrl(artwork: Artwork): string | null;
};

export type CacheSettings = {
  /** Zero turns the cache off. */
  limitBytes: number;
  wifiQuality: StreamQuality;
  cellularQuality: StreamQuality;
};

export type CacheSummary = { usedBytes: number; count: number };

type Job = { quality: StreamQuality; cancelled: boolean; cancel: (() => void) | null; art: string | null };

/** Skipping through a queue changes what is near several times a second; fetches begin once it has settled. */
const settleMs = 1000;
const farFuture = '2100-01-01T00:00:00.000Z';
const artSuffix = '.webp';
const qualities: readonly StreamQuality[] = ['original', 'high', 'data_saver'];
const keyOf = (row: Pick<CacheRow, 'trackId' | 'quality'>) => `${row.trackId}:${row.quality}`;

/**
 * The streaming cache of one account: audio files of what was played and what plays next,
 * kept in the app's Caches folder under a size limit. It follows the session's outlook,
 * fetches the entries about to play (and, on Wi-Fi, the stream being played), cancels
 * fetches the queue has moved away from, and removes the least recently played files
 * when over the limit. Files the player may hold are never removed under it.
 */
export class StreamingCache {
  private rows = new Map<string, CacheRow>();
  private readonly jobs = new Map<string, Job>();
  /** File sizes the server has announced, for tracks that are near. */
  private readonly sizes = new Map<string, number>();
  private readonly failures = new Map<string, { attempts: number; retryAt: number }>();
  /** Files whose rows are gone but which the player may still hold, by the track that holds them. */
  private readonly retired = new Map<string, string>();
  private readonly art = new Set<string>();
  private readonly artFetches = new Map<string, Promise<string | null>>();
  private readonly listeners = new Set<() => void>();
  private readonly fileListeners = new Set<(trackId: string) => void>();
  private outlook: Outlook = nothingNear;
  private summaryCache: { version: number; value: CacheSummary } | null = null;
  private version = 0;
  private filesVersion = 0;
  private online = false;
  private disposed = false;
  /** After Clear, nothing is fetched until the queue moves on. */
  private held = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopNetwork: (() => void) | undefined;

  constructor(private readonly ports: {
    index: CacheIndex;
    files: CacheFiles;
    network: DownloadNetwork;
    source: CacheSource;
    settings: CacheSettings;
    /** The track is a download, which plays first and needs no cached copy. */
    downloaded: (trackId: string) => boolean;
    now?: () => number;
    settleMs?: number;
  }) {}

  private get now() {
    return this.ports.now?.() ?? Date.now();
  }

  /** Loads the index and reconciles it with the folder, which the system may have emptied. */
  start(): void {
    const { index, files, network } = this.ports;
    index.removeOthers();
    const rows = index.load();
    const onDisk = files.list();
    const { orphans, lost, updates } = reconcile(rows, onDisk, index.referencedFiles());
    if (lost.length) index.remove(lost);
    if (updates.length) index.put(updates);
    for (const name of [...orphans, ...lost.map(row => row.file)]) files.remove(name);
    const kept = rows.filter(row => !lost.includes(row)).map(row => updates.find(update => keyOf(update) === keyOf(row)) ?? row);
    this.rows = new Map(kept.map(row => [keyOf(row), row]));
    for (const name of onDisk.keys()) if (name.endsWith(artSuffix) && !orphans.includes(name)) this.art.add(name);
    this.pruneArt();
    this.stopNetwork = network.subscribe(() => this.pump());
    this.changed();
    this.pump();
  }

  /** Stops the fetches. Nothing half fetched is kept. */
  dispose(): void {
    this.disposed = true;
    this.stopNetwork?.();
    clearTimeout(this.settleTimer);
    clearTimeout(this.retryTimer);
    for (const trackId of [...this.jobs.keys()]) this.cancel(trackId);
  }

  /** Whether the server can be reached. Nothing is fetched without it. */
  setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    this.pump();
  }

  /** A lower limit evicts at once. */
  setSettings(settings: Partial<CacheSettings>): void {
    Object.assign(this.ports.settings, settings);
    this.pump();
  }

  /** What the session will play soon. Fetches follow once it has stopped changing. */
  setOutlook(outlook: Outlook): void {
    if (sameOutlook(outlook, this.outlook)) return;
    const playing = (value: Outlook) => value.role === 'active' ? value.current?.trackId : undefined;
    const started = playing(outlook) !== playing(this.outlook) ? playing(outlook) : undefined;
    this.outlook = outlook;
    this.held = false;
    if (started) this.markPlayed(started);
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.pump(), this.ports.settleMs ?? settleMs);
  }

  // Reading

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called with the track whose file arrived or went, so playback can change where that track plays from. */
  onFilesChanged(listener: (trackId: string) => void): () => void {
    this.fileListeners.add(listener);
    return () => this.fileListeners.delete(listener);
  }

  /** Bumped on every change. */
  getVersion = (): number => this.version;

  /** Bumped only when a file arrived or went, i.e. when what can play with no connection changed. */
  getFilesVersion = (): number => this.filesVersion;

  /** The track has a file in the cache, in any quality. */
  has = (trackId: string): boolean => this.copies(trackId).length > 0;

  summary = (): CacheSummary => {
    if (this.summaryCache?.version === this.version) return this.summaryCache.value;
    let usedBytes = 0;
    for (const row of this.rows.values()) usedBytes += row.bytes;
    const value = { usedBytes, count: this.rows.size };
    this.summaryCache = { version: this.version, value };
    return value;
  };

  /** Every cached track the app knew when it was fetched, for hydrating queue rows with no connection. */
  tracks(): TrackSummary[] {
    return [...this.rows.values()].flatMap(row => row.track ?? []);
  }

  /**
   * A descriptor for the cached file to play when `quality` would stream, or null. With
   * `any`, a copy below that quality counts too.
   */
  playback(trackId: string, quality: StreamQuality, any = false): PlaybackDescriptor | null {
    const row = pick(this.copies(trackId), quality, any);
    if (!row) return null;
    if (!this.ports.files.exists(row.file)) {
      // The system emptied the folder while the app ran.
      this.drop([row]);
      return null;
    }
    return { ...row.descriptor, url: this.ports.files.uri(row.file), expiresAt: farFuture };
  }

  /** The kept cover, when one is on the device. */
  artworkUri(artworkId: string): string | null {
    const name = artName(artworkId);
    return this.art.has(name) ? this.ports.files.uri(name) : null;
  }

  // Changing

  /**
   * Empties the cache and stops its fetches. A file the player holds goes once it lets go.
   * The cache fills again once the queue moves on, not straight away with what was just cleared.
   */
  clear(): void {
    for (const trackId of [...this.jobs.keys()]) this.cancel(trackId);
    this.held = true;
    this.drop([...this.rows.values()]);
    this.pump();
  }

  // Internals

  private copies(trackId: string): CacheRow[] {
    return qualities.flatMap(quality => this.rows.get(keyOf({ trackId, quality })) ?? []);
  }

  private plan(): Plan {
    const { network, settings, files } = this.ports;
    const kind = network.kind();
    return plan({
      outlook: this.outlook,
      network: kind,
      online: this.online,
      quality: kind === 'cellular' ? settings.cellularQuality : settings.wifiQuality,
      cellularQuality: settings.cellularQuality,
      limitBytes: settings.limitBytes,
      freeBytes: files.freeBytes(),
      now: this.now,
      copies: trackId => this.copies(trackId),
      downloaded: this.ports.downloaded,
      running: new Map([...this.jobs].map(([trackId, job]) => [trackId, job.quality])),
      size: trackId => this.sizes.get(trackId),
      retryAt: trackId => this.failures.get(trackId)?.retryAt,
    });
  }

  /** Brings fetches and files in line with the plan. */
  private pump(): void {
    if (this.disposed) return;
    clearTimeout(this.settleTimer);
    clearTimeout(this.retryTimer);
    // What was learned about a track is kept only while it is near, so it is tried afresh when it comes round again.
    const near = new Set([this.outlook.current, ...this.outlook.upcoming].flatMap(entry => entry?.trackId ?? []));
    for (const known of [this.sizes, this.failures]) for (const trackId of [...known.keys()]) if (!near.has(trackId)) known.delete(trackId);

    const { start, cancel, keep } = this.plan();
    for (const trackId of cancel) this.cancel(trackId);
    const held = inUse(this.outlook);
    for (const [file, trackId] of [...this.retired]) {
      if (held.has(trackId)) continue;
      this.retired.delete(file);
      this.ports.files.remove(file);
    }
    this.drop(evictions([...this.rows.values()], this.ports.settings.limitBytes, keep));
    if (!this.held) for (const target of start) void this.fetch(target);

    const waits = [...this.failures.values()].map(failure => failure.retryAt).filter(at => Number.isFinite(at) && at > this.now);
    if (waits.length) this.retryTimer = setTimeout(() => this.pump(), Math.min(...waits) - this.now);
  }

  private async fetch(target: Target): Promise<void> {
    const { files, source } = this.ports;
    const { trackId } = target;
    const job: Job = { quality: target.quality, cancelled: false, cancel: null, art: null };
    this.jobs.set(trackId, job);
    let name: string | null = null;
    try {
      const descriptor = await source.describe(trackId, target.albumId, target.quality);
      if (job.cancelled) return;
      if (target.check) return this.checked(target, descriptor);
      this.sizes.set(trackId, descriptor.bytes ?? estimateBytes(target.quality, descriptor.durationMs));
      // Its real size may not fit beside what is nearer.
      if (this.plan().cancel.includes(trackId)) return;

      name = files.newName(extensionFor(descriptor));
      const transfer = files.fetch(source.url(descriptor), name);
      job.cancel = transfer.cancel;
      const { written, total } = await transfer.done;
      if (job.cancelled) return;
      if (!sizeMatches(written, [total, descriptor.transcoded ? null : descriptor.bytes])) throw new Error('The file was incomplete.');
      // A transcode's size was an estimate. One that turns out too big is let go now, and not fetched again while it is near.
      this.sizes.set(trackId, written);
      if (this.plan().cancel.includes(trackId)) return;
      const track = await source.track(trackId, target.albumId).catch(() => null);
      job.art = track?.album?.artwork ? await this.fetchArt(track.album.artwork, job) : null;
      if (job.cancelled) return;

      const { url: _url, expiresAt: _expiresAt, ...kept } = descriptor;
      // Any copy the track already had is of a lesser quality, or of a file the server has replaced.
      const replaced = this.copies(trackId);
      const playing = this.outlook.role === 'active' && this.outlook.current?.trackId === trackId;
      const playedAt = playing ? this.now : Math.max(0, ...replaced.map(old => old.playedAt ?? 0)) || null;
      const row: CacheRow = {
        trackId, albumId: target.albumId, quality: target.quality, file: name, fileId: descriptor.fileId, bytes: written,
        art: job.art, descriptor: kept, track, addedAt: this.now, playedAt, checkedAt: this.now,
      };
      name = null;
      this.rows.set(keyOf(row), row);
      this.ports.index.put([row]);
      this.failures.delete(trackId);
      for (const old of replaced) if (keyOf(old) === keyOf(row)) this.discard(old.file, trackId);
      this.drop(replaced.filter(old => keyOf(old) !== keyOf(row)), false);
      this.changed([trackId]);
    } catch (error) {
      if (job.cancelled || this.disposed) return;
      const missing = error instanceof ApiError && error.status === 404;
      const attempts = (this.failures.get(trackId)?.attempts ?? 0) + 1;
      // A track the server does not have, or that keeps failing, is left alone until it comes round again.
      this.failures.set(trackId, { attempts, retryAt: missing || attempts >= maxAttempts ? Infinity : this.now + retryDelay(attempts) });
    } finally {
      if (name) files.remove(name);
      if (this.jobs.get(trackId) === job) {
        this.jobs.delete(trackId);
        this.pump();
      }
    }
  }

  /** The server was asked which file it serves now: the same one is good for another day, a different one makes the copy stale. */
  private checked(target: Target, descriptor: PlaybackDescriptor): void {
    const row = this.rows.get(keyOf(target));
    if (!row) return;
    if (row.fileId === descriptor.fileId && row.descriptor.profile === descriptor.profile) {
      const fresh = { ...row, checkedAt: this.now };
      this.rows.set(keyOf(fresh), fresh);
      this.ports.index.put([fresh]);
    } else {
      // Forgotten rather than replaced in place: the track is then fetched like any other, while a player holding the old file plays on.
      this.drop([row]);
    }
  }

  private cancel(trackId: string): void {
    const job = this.jobs.get(trackId);
    if (!job) return;
    job.cancelled = true;
    this.jobs.delete(trackId);
    job.cancel?.();
  }

  /** Removes rows: the index first, so a crash leaves only files for the launch sweep. */
  private drop(rows: readonly CacheRow[], announce = true): void {
    if (!rows.length) return;
    for (const row of rows) this.rows.delete(keyOf(row));
    this.ports.index.remove(rows);
    for (const row of rows) this.discard(row.file, row.trackId);
    this.pruneArt();
    if (announce) this.changed(new Set(rows.map(row => row.trackId)));
  }

  /** Deletes a file no row names any more, or sets it aside while the player may hold it. */
  private discard(file: string, trackId: string): void {
    if (inUse(this.outlook).has(trackId)) this.retired.set(file, trackId);
    else this.ports.files.remove(file);
  }

  private markPlayed(trackId: string): void {
    const rows = this.copies(trackId).map(row => ({ ...row, playedAt: this.now }));
    if (!rows.length) return;
    for (const row of rows) this.rows.set(keyOf(row), row);
    this.ports.index.put(rows);
  }

  /** Tells readers the cache changed and, with `trackIds`, that those tracks gained or lost their file. */
  private changed(trackIds: Iterable<string> = []): void {
    const tracks = [...trackIds];
    this.version += 1;
    if (tracks.length) this.filesVersion += 1;
    for (const listener of [...this.listeners]) listener();
    for (const trackId of tracks) for (const listener of [...this.fileListeners]) listener(trackId);
  }

  /** Names the cover on `job` at once, so pruning spares it between the fetch and the row. */
  private fetchArt(artwork: Artwork, job: Job): Promise<string | null> {
    const name = artName(artwork.id);
    if (this.art.has(name)) {
      job.art = name;
      return Promise.resolve(name);
    }
    const url = this.ports.source.artworkUrl(artwork);
    if (!url) return Promise.resolve(null);
    job.art = name;
    let fetch = this.artFetches.get(name);
    if (!fetch) {
      fetch = this.ports.files.fetchSmall(url, name).then(() => {
        this.art.add(name);
        return name;
      }, () => null).finally(() => this.artFetches.delete(name));
      this.artFetches.set(name, fetch);
    }
    return fetch;
  }

  /** Removes covers no row uses, sparing one a fetch is about to attach to its row. */
  private pruneArt(): void {
    const used = new Set([...this.rows.values(), ...this.jobs.values()].map(item => item.art));
    for (const name of [...this.art]) {
      if (used.has(name)) continue;
      this.art.delete(name);
      this.ports.files.remove(name);
    }
  }
}

function artName(artworkId: string): string {
  return `art-${artworkId}${artSuffix}`;
}
