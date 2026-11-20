import { ApiError } from '@squirmy/client-core';
import type {
  AlbumDetail, Artwork, PlaybackDescriptor, PlaylistDetail, StreamQuality, TrackSummary,
} from '@squirmy/contracts';
import {
  afterFailure, checkIntervalMs, collectionDownload, concurrency, extensionFor, nextToStart, reconcile, sizeMatches,
  songsId, trackDownload, unreferenced, waitReason, type CollectionDownload, type CollectionKind, type CollectionRow,
  type DownloadRow, type NetworkKind, type TrackDownload, type WaitReason,
} from './model';

/** The index of downloads, for one account. Writes are synchronous so a row and its file change together. */
export type DownloadIndex = {
  load(): { downloads: DownloadRow[]; collections: CollectionRow[] };
  putDownloads(rows: readonly DownloadRow[]): void;
  removeDownloads(trackIds: readonly string[]): void;
  putCollection(row: CollectionRow): void;
  removeCollection(id: string): void;
  /** Every file any account's rows use; the rest of the folder can go. */
  referencedFiles(): Set<string>;
};

/** One file being downloaded. */
export type Transfer = {
  /** Starts, or resumes after `pause`. Resolves with the bytes on disk, or null when paused. */
  run(): Promise<number | null>;
  pause(): Promise<void>;
  cancel(): void;
  /** Tells the system the app is done with a download that may have completed in the background. */
  finish(): void;
};

/** The downloads folder. */
export type DownloadFiles = {
  /** A paused transfer of `url` into `name`; `total` is -1 when the server sends no length. */
  transfer(url: string, name: string, onProgress: (written: number, total: number) => void): Transfer;
  /** Fetches a small file, such as a cover, in one go. */
  fetch(url: string, name: string): Promise<void>;
  remove(name: string): void;
  /** Every file in the folder, with its size. */
  list(): Map<string, number>;
  uri(name: string): string;
  /** A name no other file has or will have. */
  newName(extension: string): string;
};

export type DownloadNetwork = { kind(): NetworkKind; subscribe(listener: () => void): () => void };

export type CollectionContent = { tracks: readonly TrackSummary[]; album?: AlbumDetail; playlist?: PlaylistDetail };

/** The server, as downloads need it. */
export type DownloadSource = {
  /** `GET /tracks/:id/playback?download=1` with this device's codecs. */
  describe(trackId: string, albumId: string | null, quality: StreamQuality): Promise<PlaybackDescriptor>;
  url(descriptor: PlaybackDescriptor): string;
  artworkUrl(artwork: Artwork): string | null;
  /** A collection's current tracks. Throws a 404 `ApiError` when the server no longer has it. */
  collection(kind: Exclude<CollectionKind, 'songs'>, id: string): Promise<CollectionContent>;
  summaries(tracks: readonly { id: string; albumId: string | null }[]): Promise<TrackSummary[]>;
};

export type DownloadOptions = { quality: StreamQuality; wifiOnly: boolean; capBytes: number | null };

/** What `addCollection` needs to know about the album, playlist or Liked Songs. */
export type CollectionMeta = Pick<CollectionRow, 'id' | 'kind' | 'title' | 'subtitle' | 'artworks'> & Partial<Pick<CollectionRow, 'album' | 'playlist'>>;

type Job = {
  transfer: Transfer | null;
  descriptor: PlaybackDescriptor | null;
  name: string | null;
  total: number;
  paused: boolean;
  cancelled: boolean;
};

export type DownloadsSummary = {
  usedBytes: number;
  /** Downloaded tracks. */
  count: number;
  /** Tracks waiting or downloading. */
  pending: number;
  failed: number;
  wait: WaitReason | null;
  collections: readonly CollectionRow[];
};

const progressIntervalMs = 250;
const checkConcurrency = 2;
const summaryBatch = 500;
const farFuture = '2100-01-01T00:00:00.000Z';
const artSuffix = '.webp';

/**
 * Downloads for one account on one server. Each recording is downloaded once, whatever
 * albums and playlists list it, and stays while at least one of them is downloaded. A
 * few run at a time; a failed one is retried with backoff, and pauses (keeping what it
 * has) on cellular when only Wi-Fi is allowed. Downloaded collections follow the server
 * on `sync`: new tracks are added, removed ones dropped, and files the server replaced
 * or lost are refreshed or flagged.
 */
export class DownloadManager {
  private rows = new Map<string, DownloadRow>();
  private collections = new Map<string, CollectionRow>();
  private readonly progress = new Map<string, number>();
  private readonly jobs = new Map<string, Job>();
  private readonly art = new Set<string>();
  private readonly artFetches = new Map<string, Promise<string | null>>();
  private readonly listeners = new Set<() => void>();
  private readonly fileListeners = new Set<() => void>();
  private readonly trackCache = new Map<string, { row: DownloadRow | undefined; progress: number | undefined; wait: WaitReason | null; value: TrackDownload | undefined }>();
  private readonly collectionCache = new Map<string, CollectionDownload | undefined>();
  private summaryCache: { version: number; value: DownloadsSummary } | null = null;
  private version = 0;
  private filesVersion = 0;
  private online = false;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private syncing: Promise<void> | null = null;
  private stopNetwork: (() => void) | undefined;

  constructor(private readonly ports: {
    index: DownloadIndex;
    files: DownloadFiles;
    network: DownloadNetwork;
    source: DownloadSource;
    options: DownloadOptions;
    now?: () => number;
  }) {}

  private get now() {
    return this.ports.now?.() ?? Date.now();
  }

  /** Loads the index, reconciles it with the folder, and starts what is queued. */
  start(): void {
    const { index, files, network } = this.ports;
    const { downloads, collections } = index.load();
    this.rows = new Map(downloads.map(row => [row.trackId, row]));
    this.collections = new Map(collections.map(row => [row.id, row]));
    const onDisk = files.list();
    const { orphans, updates } = reconcile(downloads, onDisk, index.referencedFiles());
    if (updates.length) this.put(updates);
    for (const name of orphans) files.remove(name);
    for (const name of onDisk.keys()) if (!orphans.includes(name) && name.endsWith(artSuffix)) this.art.add(name);
    this.stopNetwork = network.subscribe(() => {
      this.changed();
      this.pump();
    });
    this.changed();
    this.pump();
  }

  /** Stops the transfers. They start again from the index next time. */
  dispose(): void {
    this.disposed = true;
    this.stopNetwork?.();
    clearTimeout(this.retryTimer);
    clearTimeout(this.progressTimer);
    for (const job of this.jobs.values()) this.cancelJob(job);
    this.jobs.clear();
  }

  /** Whether the server can be reached. Nothing starts without it. */
  setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    this.changed();
    this.pump();
  }

  setOptions(options: Partial<DownloadOptions>): void {
    Object.assign(this.ports.options, options);
    this.changed();
    this.pump();
  }

  // Reading

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called when a download finished or was removed, so playback can change where a track plays from. */
  onFilesChanged(listener: () => void): () => void {
    this.fileListeners.add(listener);
    return () => this.fileListeners.delete(listener);
  }

  /** Bumped on every change, progress included. */
  getVersion = (): number => this.version;

  /** Bumped only when a file arrived or went, i.e. when what can play offline changed. */
  getFilesVersion = (): number => this.filesVersion;

  /** The track has a file on the device. */
  isDownloaded = (trackId: string): boolean => Boolean(this.rows.get(trackId)?.file);

  track(trackId: string): TrackDownload | undefined {
    const row = this.rows.get(trackId);
    const progress = this.progress.get(trackId);
    const wait = this.wait();
    const cached = this.trackCache.get(trackId);
    if (cached && cached.row === row && cached.progress === progress && cached.wait === wait) return cached.value;
    const value = trackDownload(row, progress, wait);
    this.trackCache.set(trackId, { row, progress, wait, value });
    return value;
  }

  collection(id: string): CollectionDownload | undefined {
    const row = this.collections.get(id);
    const value = row && collectionDownload(row, this.rows, this.progress, this.wait());
    const cached = this.collectionCache.get(id);
    if (cached && value && shallowEqual(cached, value)) return cached;
    this.collectionCache.set(id, value);
    return value;
  }

  collectionRow(id: string): CollectionRow | undefined {
    return this.collections.get(id);
  }

  /** Downloaded tracks of a collection, in its order, as last seen. */
  collectionTracks(id: string): TrackSummary[] {
    return (this.collections.get(id)?.trackIds ?? []).flatMap(trackId => this.rows.get(trackId)?.track ?? []);
  }

  /** Every downloaded track, for hydrating queue rows with no connection. */
  tracks(): TrackSummary[] {
    return [...this.rows.values()].map(row => row.track);
  }

  summary(): DownloadsSummary {
    if (this.summaryCache?.version === this.version) return this.summaryCache.value;
    let usedBytes = 0;
    let count = 0;
    let pending = 0;
    let failed = 0;
    for (const row of this.rows.values()) {
      if (row.file) {
        usedBytes += row.bytes ?? 0;
        count += 1;
      } else if (row.state === 'failed') failed += 1;
      else pending += 1;
    }
    const value = { usedBytes, count, pending, failed, wait: pending ? this.wait() : null, collections: [...this.collections.values()] };
    this.summaryCache = { version: this.version, value };
    return value;
  }

  /** A descriptor for the downloaded file, or null when the track is not downloaded. */
  playback(trackId: string): PlaybackDescriptor | null {
    const row = this.rows.get(trackId);
    if (!row?.file || !row.descriptor) return null;
    return { ...row.descriptor, url: this.ports.files.uri(row.file), expiresAt: farFuture };
  }

  /** The kept cover, when one is on the device. */
  artworkUri(artworkId: string): string | null {
    const name = artName(artworkId);
    return this.art.has(name) ? this.ports.files.uri(name) : null;
  }

  // Changing

  /** Downloads the tracks of an album, playlist or Liked Songs, and keeps them in step with it. */
  addCollection(meta: CollectionMeta, tracks: readonly TrackSummary[]): void {
    const wanted = tracks.filter(track => track.availability === 'server' || this.isDownloaded(track.id));
    const previous = this.collections.get(meta.id);
    const row: CollectionRow = {
      album: null, playlist: null, ...previous, ...meta, trackIds: unique(wanted.map(track => track.id)),
      art: previous?.art ?? [], gone: false, addedAt: previous?.addedAt ?? this.now, syncedAt: this.now,
    };
    this.ensureRows(wanted);
    this.putCollection(row);
    void this.fetchCollectionArt(row);
    this.dropUnreferenced();
    this.pump();
  }

  /** Downloads one track on its own. */
  addTrack(track: TrackSummary): void {
    const songs = this.collections.get(songsId);
    this.ensureRows([track]);
    this.putCollection({
      id: songsId, kind: 'songs', title: 'Songs', subtitle: '', artworks: [], album: null, playlist: null, art: [], gone: false,
      addedAt: songs?.addedAt ?? this.now, syncedAt: this.now, trackIds: unique([...songs?.trackIds ?? [], track.id]),
    });
    this.pump();
  }

  removeCollection(id: string): void {
    if (!this.collections.has(id)) return;
    this.collections.delete(id);
    this.ports.index.removeCollection(id);
    this.dropUnreferenced();
    this.changed();
  }

  /** Removes a track downloaded on its own. Tracks of a downloaded album or playlist stay with it. */
  removeTrack(trackId: string): void {
    const songs = this.collections.get(songsId);
    if (!songs?.trackIds.includes(trackId)) return;
    const trackIds = songs.trackIds.filter(id => id !== trackId);
    if (trackIds.length) this.putCollection({ ...songs, trackIds });
    else {
      this.collections.delete(songsId);
      this.ports.index.removeCollection(songsId);
    }
    this.dropUnreferenced();
    this.changed();
  }

  /** Every download of this account, files and rows. */
  removeAll(): void {
    for (const id of [...this.collections.keys()]) this.ports.index.removeCollection(id);
    this.collections.clear();
    this.dropUnreferenced();
    this.changed();
  }

  /** Queues failed downloads again. */
  retry(): void {
    this.put([...this.rows.values()].filter(row => row.state === 'failed')
      .map(row => ({ ...row, state: 'queued', attempts: 0, retryAt: null, error: null })));
    this.pump();
  }

  /**
   * Brings downloaded collections in step with the server, flags tracks it no longer has,
   * and re-downloads files it replaced. Runs once at a time; does nothing offline.
   */
  sync(): Promise<void> {
    if (!this.online || this.disposed) return Promise.resolve();
    this.syncing ??= (async () => {
      for (const collection of [...this.collections.values()]) {
        if (collection.kind !== 'songs') await this.syncCollection(collection);
      }
      await this.checkSongs();
      await this.checkFiles();
    })().finally(() => {
      this.syncing = null;
      this.pump();
    });
    return this.syncing;
  }

  /** Re-reads the downloaded collections whose server data changed, e.g. after an `invalidate`. */
  async syncKinds(kinds: readonly CollectionKind[]): Promise<void> {
    if (!this.online || this.disposed) return;
    for (const collection of [...this.collections.values()]) {
      if (kinds.includes(collection.kind) && collection.kind !== 'songs') await this.syncCollection(collection);
    }
    this.pump();
  }

  // Internals

  private wait(): WaitReason | null {
    const { wifiOnly, capBytes } = this.ports.options;
    let usedBytes = 0;
    if (capBytes !== null) for (const row of this.rows.values()) usedBytes += row.file ? row.bytes ?? 0 : 0;
    return waitReason({ online: this.online, network: this.ports.network.kind(), wifiOnly, usedBytes, capBytes });
  }

  private ensureRows(tracks: readonly TrackSummary[]): void {
    const changed: DownloadRow[] = [];
    for (const track of tracks) {
      const row = this.rows.get(track.id);
      if (row) {
        const gone = track.availability === 'none';
        if (gone !== row.gone || JSON.stringify(row.track) !== JSON.stringify(track)) changed.push({ ...row, track, gone });
        continue;
      }
      changed.push({
        trackId: track.id, albumId: track.album?.id ?? null, state: 'queued', quality: this.ports.options.quality,
        file: null, art: null, bytes: null, descriptor: null, track, attempts: 0, retryAt: null, error: null, gone: false,
        addedAt: this.now, doneAt: null, checkedAt: null,
      });
    }
    if (changed.length) this.put(changed);
  }

  private put(rows: readonly DownloadRow[]): void {
    if (!rows.length) return;
    for (const row of rows) this.rows.set(row.trackId, row);
    this.ports.index.putDownloads(rows);
    this.changed();
  }

  private putCollection(row: CollectionRow): void {
    this.collections.set(row.id, row);
    this.ports.index.putCollection(row);
    this.changed();
  }

  /** Removes rows no collection lists: the index first, so a crash leaves only files for the sweep. */
  private dropUnreferenced(): void {
    const ids = unreferenced(this.rows.values(), this.collections.values());
    if (!ids.length) return this.pruneArt();
    const files = ids.flatMap(id => this.rows.get(id)?.file ?? []);
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job) this.cancelJob(job);
      this.jobs.delete(id);
      this.progress.delete(id);
      this.rows.delete(id);
    }
    this.ports.index.removeDownloads(ids);
    for (const name of files) this.ports.files.remove(name);
    this.pruneArt();
    this.changed();
    this.filesChanged();
  }

  private pruneArt(): void {
    const referenced = this.ports.index.referencedFiles();
    for (const name of [...this.art]) {
      if (referenced.has(name)) continue;
      this.art.delete(name);
      this.ports.files.remove(name);
    }
  }

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  private filesChanged(): void {
    this.filesVersion += 1;
    for (const listener of [...this.fileListeners]) listener();
  }

  private pump(): void {
    if (this.disposed) return;
    clearTimeout(this.retryTimer);
    const wait = this.wait();
    if (wait === 'wifi') {
      for (const job of this.jobs.values()) if (!job.paused && job.transfer) void job.transfer.pause().catch(() => undefined);
    }
    if (wait) return;
    const running = new Set([...this.jobs].filter(([, job]) => !job.paused).map(([id]) => id));
    for (const row of nextToStart(this.rows.values(), running, this.now, concurrency)) {
      const job = this.jobs.get(row.trackId);
      if (job?.paused && job.transfer) void this.resume(row.trackId, job);
      else void this.download(row);
    }
    const next = Math.min(...[...this.rows.values()].filter(row => row.state === 'queued' && row.retryAt !== null).map(row => row.retryAt!));
    if (Number.isFinite(next)) this.retryTimer = setTimeout(() => this.pump(), Math.max(0, next - this.now));
  }

  private setState(trackId: string, state: DownloadRow['state']): void {
    const row = this.rows.get(trackId);
    if (row && row.state !== state) this.put([{ ...row, state, retryAt: null }]);
  }

  private async download(row: DownloadRow): Promise<void> {
    const { files, source } = this.ports;
    const job: Job = { transfer: null, descriptor: null, name: null, total: -1, paused: false, cancelled: false };
    this.jobs.set(row.trackId, job);
    this.setState(row.trackId, 'downloading');
    try {
      const descriptor = await source.describe(row.trackId, row.albumId, row.quality);
      if (job.cancelled) return;
      job.descriptor = descriptor;
      job.name = files.newName(extensionFor(descriptor));
      job.transfer = files.transfer(source.url(descriptor), job.name, (written, total) => {
        job.total = total;
        const size = total > 0 ? total : descriptor.bytes ?? 0;
        this.setProgress(row.trackId, size > 0 ? Math.min(1, written / size) : 0);
      });
      // Wi-Fi went while the server was asked: wait for it before starting.
      if (this.wait() === 'wifi') return await this.finish(row.trackId, job, null);
      await this.finish(row.trackId, job, await job.transfer.run());
    } catch (error) {
      this.failed(row.trackId, job, error);
    }
  }

  private async resume(trackId: string, job: Job): Promise<void> {
    job.paused = false;
    this.setState(trackId, 'downloading');
    try {
      await this.finish(trackId, job, await job.transfer!.run());
    } catch (error) {
      this.failed(trackId, job, error);
    }
  }

  private async finish(trackId: string, job: Job, written: number | null): Promise<void> {
    if (job.cancelled) {
      if (written !== null && job.name) this.ports.files.remove(job.name);
      return;
    }
    if (written === null) {
      job.paused = true;
      this.setState(trackId, 'queued');
      return;
    }
    const descriptor = job.descriptor!;
    if (!sizeMatches(written, [job.total, descriptor.transcoded ? null : descriptor.bytes])) {
      this.ports.files.remove(job.name!);
      throw new Error('The download was incomplete.');
    }
    const row = this.rows.get(trackId);
    if (!row) {
      this.ports.files.remove(job.name!);
      return;
    }
    const art = row.track.album?.artwork ? await this.fetchArt(row.track.album.artwork) : null;
    const current = this.rows.get(trackId);
    if (job.cancelled || !current) {
      this.ports.files.remove(job.name!);
      return;
    }
    const { url: _url, expiresAt: _expiresAt, ...kept } = descriptor;
    this.jobs.delete(trackId);
    this.progress.delete(trackId);
    this.put([{
      ...current, state: 'done', file: job.name, art: art ?? current.art, bytes: written, descriptor: kept, attempts: 0,
      retryAt: null, error: null, gone: false, doneAt: this.now, checkedAt: this.now,
    }]);
    if (row.file && row.file !== job.name) this.ports.files.remove(row.file);
    job.transfer?.finish();
    this.filesChanged();
    this.pump();
  }

  private failed(trackId: string, job: Job, error: unknown): void {
    if (job.cancelled) return;
    this.jobs.delete(trackId);
    this.progress.delete(trackId);
    const row = this.rows.get(trackId);
    if (row) {
      const missing = error instanceof ApiError && error.status === 404;
      const message = missing ? 'This song is no longer on the server.' : error instanceof Error ? error.message : 'The download failed.';
      this.put([{ ...afterFailure(row, message, this.now, missing), gone: missing || row.gone }]);
    }
    this.pump();
  }

  private cancelJob(job: Job): void {
    job.cancelled = true;
    job.transfer?.cancel();
  }

  private setProgress(trackId: string, value: number): void {
    this.progress.set(trackId, value);
    this.progressTimer ??= setTimeout(() => {
      this.progressTimer = undefined;
      this.changed();
    }, progressIntervalMs);
  }

  private fetchArt(artwork: Artwork): Promise<string | null> {
    const name = artName(artwork.id);
    if (this.art.has(name)) return Promise.resolve(name);
    const url = this.ports.source.artworkUrl(artwork);
    if (!url) return Promise.resolve(null);
    let fetch = this.artFetches.get(name);
    if (!fetch) {
      fetch = this.ports.files.fetch(url, name).then(() => {
        this.art.add(name);
        return name;
      }, () => null).finally(() => this.artFetches.delete(name));
      this.artFetches.set(name, fetch);
    }
    return fetch;
  }

  private async fetchCollectionArt(row: CollectionRow): Promise<void> {
    const names = (await Promise.all(row.artworks.map(artwork => this.fetchArt(artwork)))).filter((name): name is string => name !== null);
    const current = this.collections.get(row.id);
    if (current && !this.disposed && names.join() !== current.art.join()) this.putCollection({ ...current, art: names });
  }

  private async syncCollection(collection: CollectionRow): Promise<void> {
    let content: CollectionContent;
    try {
      content = await this.ports.source.collection(collection.kind as Exclude<CollectionKind, 'songs'>, collection.id.slice(collection.id.indexOf(':') + 1));
    } catch (error) {
      const current = this.collections.get(collection.id);
      if (current && error instanceof ApiError && error.status === 404) this.putCollection({ ...current, gone: true });
      return;
    }
    const current = this.collections.get(collection.id);
    if (!current || this.disposed) return;
    const { album, playlist, tracks } = content;
    const meta: Partial<CollectionRow> = album
      ? { title: album.title, subtitle: album.artistCredit, artworks: album.artwork ? [album.artwork] : [], album: withoutDiscs(album) }
      : playlist ? { title: playlist.name, artworks: playlist.artworks, playlist: withoutItems(playlist) } : {};
    this.addCollection({ ...current, ...meta }, tracks);
  }

  /** Flags songs downloaded on their own that the server no longer has. */
  private async checkSongs(): Promise<void> {
    const ids = this.collections.get(songsId)?.trackIds ?? [];
    for (let start = 0; start < ids.length; start += summaryBatch) {
      const batch = ids.slice(start, start + summaryBatch).flatMap(id => {
        const row = this.rows.get(id);
        return row ? [{ id, albumId: row.albumId }] : [];
      });
      let found: TrackSummary[];
      try {
        found = await this.ports.source.summaries(batch);
      } catch {
        return;
      }
      const byId = new Map(found.map(track => [track.id, track]));
      this.put(batch.flatMap(({ id }) => {
        const row = this.rows.get(id);
        const track = byId.get(id);
        const gone = !track || track.availability === 'none';
        return row && (gone !== row.gone || (track && track !== row.track)) ? [{ ...row, gone, track: track ?? row.track }] : [];
      }));
    }
  }

  /** Asks the server, at most daily per file, which file it would serve now; a different one is downloaded again. */
  private async checkFiles(): Promise<void> {
    const due = [...this.rows.values()].filter(row => row.file && row.state === 'done' && !row.gone
      && (row.checkedAt === null || this.now - row.checkedAt >= checkIntervalMs));
    const check = async (row: DownloadRow) => {
      let descriptor: PlaybackDescriptor;
      try {
        descriptor = await this.ports.source.describe(row.trackId, row.albumId, row.quality);
      } catch (error) {
        const current = this.rows.get(row.trackId);
        if (current && error instanceof ApiError && error.status === 404) this.put([{ ...current, gone: true, checkedAt: this.now }]);
        return;
      }
      const current = this.rows.get(row.trackId);
      if (!current || current.state !== 'done') return;
      const replaced = descriptor.fileId !== current.descriptor?.fileId || descriptor.profile !== current.descriptor?.profile;
      this.put([replaced ? { ...current, state: 'queued', attempts: 0, retryAt: null, checkedAt: this.now } : { ...current, checkedAt: this.now }]);
    };
    for (let start = 0; start < due.length; start += checkConcurrency) {
      if (!this.online || this.disposed) return;
      await Promise.all(due.slice(start, start + checkConcurrency).map(check));
    }
  }
}

function artName(artworkId: string): string {
  return `art-${artworkId}${artSuffix}`;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function withoutDiscs({ discs: _discs, ...album }: AlbumDetail): Omit<AlbumDetail, 'discs'> {
  return album;
}

function withoutItems({ items: _items, ...playlist }: PlaylistDetail): CollectionRow['playlist'] {
  return playlist;
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]));
}
