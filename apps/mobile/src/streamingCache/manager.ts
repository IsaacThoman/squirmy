import { ApiError } from '@squirmy/client-core';
import type { Artwork, PlaybackDescriptor, StreamQuality, TrackSummary } from '@squirmy/contracts';
import type { DownloadNetwork } from '../downloads/manager';
import { extensionFor, retryDelay, sizeMatches } from '../downloads/model';
import {
  estimateBytes, evictionsAcross, inUse, maxAttempts, nothingNear, pick, plan, reconcile, sameOutlook, type CacheRow, type ForeignRow,
  type Near, type Outlook, type Plan, type Target,
} from './model';

/** The index of the cache, for one account. Writes are synchronous so a row and its file change together. */
export type CacheIndex = {
  load(): CacheRow[];
  put(rows: readonly CacheRow[]): void;
  remove(rows: readonly Pick<CacheRow, 'trackId' | 'quality'>[]): void;
  /**
   * Every other account's rows. They stay for when that account is opened again, and count
   * toward the device's limit.
   */
  others(): ForeignRow[];
  /** Forgets rows of other accounts. */
  removeOthers(rows: readonly ForeignRow[]): void;
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
  /** Moves a whole file from elsewhere on the device (`uri`) into the folder as `name`, and gives its size. */
  adopt(uri: string, name: string): number;
  /** Deletes a file outside the folder: a stream the engine wrote that the cache does not keep. */
  discardOutside(uri: string): void;
};

/** What the engine says of a stream it downloaded under a key: its whole file, or that there is none. */
export type StreamReport = { key: string; uri: string; bytes: number } | { key: string; uri: null; message: string };

/**
 * The native engine's streams, when it is the one playing. It writes what it streams to a
 * file and hands the file over once it is whole, so the cache keeps what plays instead of
 * fetching it a second time, and its fetches go through the engine too, so a fetch and the
 * load of the same stream share one download.
 */
export type EngineStreams = {
  /** Downloads `url` under `key` without playing it, unless it is downloading already. */
  prefetch(key: string, url: string): void;
  /** Stops a prefetch; the download goes on while the engine plays it. */
  cancelPrefetch(key: string): void;
  /** Each keyed stream once, as it ends. Returns a function that stops listening. */
  subscribe(listener: (report: StreamReport) => void): () => void;
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
/** A stream the engine fills that the cache will keep: what the file is, for its row. */
type Stream = { trackId: string; albumId: string | null; quality: StreamQuality; descriptor: PlaybackDescriptor };

/** Skipping through a queue changes what is near several times a second; fetches begin once it has settled. */
const settleMs = 1000;
const farFuture = '2100-01-01T00:00:00.000Z';
const artSuffix = '.webp';
const qualities: readonly StreamQuality[] = ['original', 'high', 'data_saver'];
const keyOf = (row: Pick<CacheRow, 'trackId' | 'quality'>) => `${row.trackId}:${row.quality}`;
/** Streams waiting for the engine's word are forgotten past this many, oldest first: most are of songs skipped or never loaded. */
const maxStreams = 64;

/** The stream's key for the engine: the same file in the same profile is the same bytes, whatever URL signs it. */
export function streamKeyOf(descriptor: Pick<PlaybackDescriptor, 'fileId' | 'profile'>): string {
  return `${descriptor.fileId}:${descriptor.profile}`;
}

/**
 * The streaming cache of one account: audio files of what was played and what plays next,
 * kept in the app's Caches folder under a size limit. It follows the session's outlook,
 * fetches the entries about to play (and, on Wi-Fi with the classic player, the stream being
 * played), cancels fetches the queue has moved away from, and removes the least recently
 * played files when over the limit. Files the player may hold are never removed under it.
 *
 * With the native engine (`streams`), what plays is what is kept: the player names each
 * stream it loads from the server (`streamKey`), the engine hands the file over once it is
 * whole, and the cache moves it into its folder. Fetches ahead go through the engine, so a
 * track that starts while its fetch runs reads the same download.
 */
export class StreamingCache {
  private rows = new Map<string, CacheRow>();
  /** Other accounts' rows, read at start: the limit applies to all of them together. */
  private foreign: ForeignRow[] = [];
  private readonly jobs = new Map<string, Job>();
  /** File sizes the server has announced, for tracks that are near. */
  private readonly sizes = new Map<string, number>();
  private readonly failures = new Map<string, { attempts: number; retryAt: number }>();
  /** Files whose rows are gone but which the player may still hold, by the track that holds them. */
  private readonly retired = new Map<string, string>();
  private readonly art = new Set<string>();
  private readonly artFetches = new Map<string, Promise<string | null>>();
  /** Streams the engine fills that the cache will keep, by stream key. */
  private readonly streams = new Map<string, Stream>();
  /** Fetches through the engine waiting for its report, by stream key. */
  private readonly arrivals = new Map<string, (report: StreamReport) => void>();
  /** Files the engine handed over being recorded, so their covers are spared meanwhile. */
  private readonly keeping = new Set<Job>();
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
  private stopStreams: (() => void) | undefined;

  constructor(private readonly ports: {
    index: CacheIndex;
    files: CacheFiles;
    network: DownloadNetwork;
    source: CacheSource;
    settings: CacheSettings;
    /** The native engine's streams, when it plays; absent for the classic player. */
    streams?: EngineStreams;
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
    const rows = index.load();
    const onDisk = files.list();
    const { orphans, lost, updates } = reconcile(rows, onDisk, index.referencedFiles());
    // Another account's file the system purged is forgotten too, so it no longer counts toward the limit.
    const others = index.others();
    const othersLost = others.filter(row => onDisk.get(row.file) !== row.bytes);
    if (othersLost.length) index.removeOthers(othersLost);
    this.foreign = others.filter(row => !othersLost.includes(row));
    if (lost.length) index.remove(lost);
    if (updates.length) index.put(updates);
    for (const name of [...orphans, ...lost.map(row => row.file)]) files.remove(name);
    const kept = rows.filter(row => !lost.includes(row)).map(row => updates.find(update => keyOf(update) === keyOf(row)) ?? row);
    this.rows = new Map(kept.map(row => [keyOf(row), row]));
    for (const name of onDisk.keys()) if (name.endsWith(artSuffix) && !orphans.includes(name)) this.art.add(name);
    this.pruneArt();
    this.stopNetwork = network.subscribe(() => this.pump());
    this.stopStreams = this.ports.streams?.subscribe(report => this.streamEnded(report));
    this.changed();
    this.pump();
  }

  /** Stops the fetches. Nothing half fetched is kept. */
  dispose(): void {
    this.disposed = true;
    this.stopNetwork?.();
    this.stopStreams?.();
    clearTimeout(this.settleTimer);
    clearTimeout(this.retryTimer);
    for (const trackId of [...this.jobs.keys()]) this.cancel(trackId);
    for (const job of this.keeping) job.cancelled = true;
  }

  /** Removes what another account keeps here, when it is removed from the device. */
  forgetAccount(account: string): void {
    const gone = this.foreign.filter(row => row.account === account);
    if (!gone.length) return;
    this.dropForeign(gone);
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

  /**
   * The key the engine streams `descriptor` under while it plays `entry` at `quality`, so the
   * file is kept once it is whole; null when nothing would keep it (the classic player, the
   * cache off or just cleared, or a downloaded track).
   */
  streamKey(entry: Pick<Near, 'trackId' | 'albumId'>, quality: StreamQuality, descriptor: PlaybackDescriptor): string | null {
    const { streams, settings, downloaded } = this.ports;
    if (!streams || this.disposed || this.held || settings.limitBytes <= 0 || downloaded(entry.trackId)) return null;
    return this.expect({ trackId: entry.trackId, albumId: entry.albumId, quality, descriptor });
  }

  /**
   * Gives up the cached file of exactly this stream (the same file in the same profile) to
   * be moved into downloads: the cache forgets it without deleting it. Null when there is
   * none, or while the classic player may open it again by its name.
   */
  take(trackId: string, stream: Pick<PlaybackDescriptor, 'fileId' | 'profile'>): { uri: string; bytes: number } | null {
    const { files, index, streams } = this.ports;
    const row = this.copies(trackId).find(copy => copy.fileId === stream.fileId && copy.descriptor.profile === stream.profile);
    if (!row || !files.exists(row.file)) return null;
    // The native engine reads through the open file wherever it is moved.
    if (!streams && inUse(this.outlook).has(trackId)) return null;
    this.rows.delete(keyOf(row));
    index.remove([row]);
    this.pruneArt();
    this.changed([trackId]);
    return { uri: files.uri(row.file), bytes: row.bytes };
  }

  // Changing

  /**
   * Empties the cache and stops its fetches. A file the player holds goes once it lets go.
   * The cache fills again once the queue moves on, not straight away with what was just cleared.
   */
  clear(): void {
    for (const trackId of [...this.jobs.keys()]) this.cancel(trackId);
    for (const job of this.keeping) job.cancelled = true;
    this.held = true;
    this.drop([...this.rows.values()]);
    this.pump();
  }

  /**
   * Drops the copies of these tracks and stops their fetches: the server now serves another
   * file for them, as after the user picked another version, and a copy plays before the
   * server is asked. They are fetched again as they come near; a file the player holds goes
   * once it lets go.
   */
  forget(trackIds: readonly string[]): void {
    for (const trackId of trackIds) this.cancel(trackId);
    this.drop(trackIds.flatMap(trackId => this.copies(trackId)));
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
      shared: Boolean(this.ports.streams),
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
    const evicted = evictionsAcross([...this.rows.values()], this.foreign, this.ports.settings.limitBytes, keep);
    this.drop(evicted.own);
    this.dropForeign(evicted.foreign);
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
      const { written, total } = await this.download(target, descriptor, name, job);
      if (job.cancelled) return;
      if (!sizeMatches(written, [total, descriptor.transcoded ? null : descriptor.bytes])) throw new Error('The file was incomplete.');
      // A transcode's size was an estimate. One that turns out too big is let go now, and not fetched again while it is near.
      this.sizes.set(trackId, written);
      if (this.plan().cancel.includes(trackId)) return;
      if (await this.record(target, descriptor, name, written, job)) name = null;
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

  /** Fetches the stream into `name`: through the engine when it plays, so a load of the same stream reads this download. */
  private download(target: Target, descriptor: PlaybackDescriptor, name: string, job: Job): Promise<{ written: number; total: number }> {
    const { files, source, streams } = this.ports;
    const url = source.url(descriptor);
    if (!streams) {
      const transfer = files.fetch(url, name);
      job.cancel = transfer.cancel;
      return transfer.done;
    }
    const key = this.expect({ trackId: target.trackId, albumId: target.albumId, quality: target.quality, descriptor });
    return new Promise((resolve, reject) => {
      const arrived = (report: StreamReport) => {
        if (report.uri === null) return reject(new Error(report.message));
        try {
          resolve({ written: files.adopt(report.uri, name), total: report.bytes });
        } catch (error) {
          files.discardOutside(report.uri);
          reject(error);
        }
      };
      this.arrivals.set(key, arrived);
      job.cancel = () => {
        if (this.arrivals.get(key) === arrived) this.arrivals.delete(key);
        streams.cancelPrefetch(key);
        reject(new Error('cancelled'));
      };
      streams.prefetch(key, url);
    });
  }

  /**
   * Makes `name`, a whole file of `written` bytes in the folder, the track's copy at
   * `target.quality`, with its cover and summary. False when it was cancelled meanwhile.
   */
  private async record(target: Target, descriptor: PlaybackDescriptor, name: string, written: number, job: Job): Promise<boolean> {
    const { trackId } = target;
    const track = await this.ports.source.track(trackId, target.albumId).catch(() => null);
    job.art = track?.album?.artwork ? await this.fetchArt(track.album.artwork, job) : null;
    if (job.cancelled || this.disposed) return false;

    const { url: _url, expiresAt: _expiresAt, ...kept } = descriptor;
    // Any copy the track already had is of a lesser quality, or of a file the server has replaced.
    const replaced = this.copies(trackId);
    const playing = this.outlook.role === 'active' && this.outlook.current?.trackId === trackId;
    const playedAt = playing ? this.now : Math.max(0, ...replaced.map(old => old.playedAt ?? 0)) || null;
    const row: CacheRow = {
      trackId, albumId: target.albumId, quality: target.quality, file: name, fileId: descriptor.fileId, bytes: written,
      art: job.art, descriptor: kept, track, addedAt: this.now, playedAt, checkedAt: this.now,
    };
    this.rows.set(keyOf(row), row);
    this.ports.index.put([row]);
    this.failures.delete(trackId);
    for (const old of replaced) if (keyOf(old) === keyOf(row)) this.discard(old.file, trackId);
    this.drop(replaced.filter(old => keyOf(old) !== keyOf(row)), false);
    this.changed([trackId]);
    return true;
  }

  /** Remembers that the stream is wanted, so its file is kept when the engine hands it over. */
  private expect(stream: Stream): string {
    const key = streamKeyOf(stream.descriptor);
    this.streams.delete(key);
    this.streams.set(key, stream);
    if (this.streams.size > maxStreams) this.streams.delete(this.streams.keys().next().value!);
    return key;
  }

  /** The engine finished a keyed stream: a fetch waiting for it takes it, a stream the player streamed is kept, any other goes. */
  private streamEnded(report: StreamReport): void {
    const waiting = this.arrivals.get(report.key);
    if (waiting) {
      this.arrivals.delete(report.key);
      if (report.uri !== null) this.streams.delete(report.key);
      return waiting(report);
    }
    // Its name is kept, should the player stream it again.
    if (report.uri === null) return;
    const stream = this.streams.get(report.key);
    this.streams.delete(report.key);
    if (!stream || this.disposed) return this.ports.files.discardOutside(report.uri);
    void this.keepStream(stream, report.uri, report.bytes);
  }

  /** Keeps a file the engine streamed while it played, as if it had been fetched. */
  private async keepStream(stream: Stream, uri: string, bytes: number): Promise<void> {
    const { files, settings, downloaded } = this.ports;
    const { trackId, albumId, quality, descriptor } = stream;
    // Too big for the whole cache, or a download plays instead.
    if (this.held || settings.limitBytes <= 0 || bytes > settings.limitBytes || downloaded(trackId)) return files.discardOutside(uri);
    const name = files.newName(extensionFor(descriptor));
    let written: number;
    try {
      written = files.adopt(uri, name);
    } catch {
      return files.discardOutside(uri);
    }
    const job: Job = { quality, cancelled: false, cancel: null, art: null };
    this.keeping.add(job);
    let kept = false;
    try {
      if (!sizeMatches(written, [bytes, descriptor.transcoded ? null : descriptor.bytes])) return;
      this.sizes.set(trackId, written);
      kept = await this.record({ trackId, albumId, quality, check: false }, descriptor, name, written, job);
      if (kept) this.pump();
    } finally {
      this.keeping.delete(job);
      if (!kept) files.remove(name);
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

  /** Removes other accounts' rows and their files; no player here holds those. */
  private dropForeign(rows: readonly ForeignRow[]): void {
    if (!rows.length) return;
    this.foreign = this.foreign.filter(row => !rows.includes(row));
    this.ports.index.removeOthers(rows);
    for (const row of rows) this.ports.files.remove(row.file);
    this.pruneArt();
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
    const used = new Set([...this.rows.values(), ...this.jobs.values(), ...this.keeping, ...this.foreign].map(item => item.art));
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
