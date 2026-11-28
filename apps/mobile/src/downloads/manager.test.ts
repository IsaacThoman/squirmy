import { ApiError } from '@squirmy/client-core';
import type {
  AcquireQuery, AcquireResponse, AcquisitionJob, AlbumDetail, Lyrics, PlaybackDescriptor, PlaylistDetail, StreamQuality, TrackSummary,
} from '@squirmy/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DownloadManager, type CollectionContent, type DownloadFiles, type DownloadIndex, type DownloadSource, type Transfer,
} from './manager';
import {
  albumCollectionId, downloadStatus, fetchGapMs, maxAttempts, playlistCollectionId, type CollectionRow, type DownloadRow, type NetworkKind,
} from './model';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const albumId = id(900);

function track(n: number, availability: TrackSummary['availability'] = 'server'): TrackSummary {
  return {
    id: id(n), mbid: null, title: `Track ${n}`, artistCredit: 'Artist', artists: [], durationMs: 1000,
    album: { id: albumId, title: 'Album', artwork: { id: id(800), color: null, thumbhash: null } },
    disc: 1, position: n, availability, liked: false, explicit: null, hasLyrics: false,
  };
}

/** The index as SQLite would keep it, shared between accounts. */
class MemoryIndex implements DownloadIndex {
  static readonly accounts = new Map<string, { downloads: Map<string, DownloadRow>; collections: Map<string, CollectionRow> }>();
  readonly writes: string[] = [];
  constructor(private readonly account = 'a') {
    if (!MemoryIndex.accounts.has(account)) MemoryIndex.accounts.set(account, { downloads: new Map(), collections: new Map() });
  }
  private get data() {
    return MemoryIndex.accounts.get(this.account)!;
  }
  load() {
    return { downloads: [...this.data.downloads.values()], collections: [...this.data.collections.values()] };
  }
  putDownloads(rows: readonly DownloadRow[]) {
    for (const row of rows) this.data.downloads.set(row.trackId, row);
    this.writes.push('downloads');
  }
  removeDownloads(trackIds: readonly string[]) {
    for (const trackId of trackIds) this.data.downloads.delete(trackId);
    this.writes.push('remove');
  }
  putCollection(row: CollectionRow) {
    this.data.collections.set(row.id, row);
  }
  removeCollection(collection: string) {
    this.data.collections.delete(collection);
  }
  referencedFiles() {
    const names = new Set<string>();
    for (const { downloads, collections } of MemoryIndex.accounts.values()) {
      for (const row of downloads.values()) for (const name of [row.file, row.art]) if (name) names.add(name);
      for (const row of collections.values()) for (const name of row.art) names.add(name);
    }
    return names;
  }
  row(trackId: string) {
    return this.data.downloads.get(trackId);
  }
}

class FakeTransfer implements Transfer {
  runs = 0;
  cancelled = false;
  finished = false;
  private settle: ((bytes: number | null) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  constructor(readonly url: string, readonly name: string, private readonly files: FakeFiles, private readonly onProgress: (written: number, total: number) => void) {}
  run() {
    this.runs += 1;
    return new Promise<number | null>((resolve, reject) => {
      this.settle = resolve;
      this.reject = reject;
    });
  }
  async pause() {
    this.settle?.(null);
  }
  cancel() {
    this.cancelled = true;
    this.reject?.(new Error('cancelled'));
  }
  finish() {
    this.finished = true;
  }
  progress(written: number, total: number) {
    this.onProgress(written, total);
  }
  complete(bytes = 1000, total = bytes) {
    this.onProgress(bytes, total);
    this.files.disk.set(this.name, bytes);
    this.settle?.(bytes);
  }
  fail(message = 'network down') {
    this.reject?.(new Error(message));
  }
}

class FakeFiles implements DownloadFiles {
  readonly disk = new Map<string, number>();
  readonly transfers: FakeTransfer[] = [];
  readonly removed: string[] = [];
  private serial = 0;
  transfer(url: string, name: string, onProgress: (written: number, total: number) => void) {
    const transfer = new FakeTransfer(url, name, this, onProgress);
    this.transfers.push(transfer);
    return transfer;
  }
  async fetch(_url: string, name: string) {
    this.disk.set(name, 10);
  }
  remove(name: string) {
    this.removed.push(name);
    this.disk.delete(name);
  }
  list() {
    return new Map(this.disk);
  }
  uri(name: string) {
    return `file:///downloads/${name}`;
  }
  newName(extension: string) {
    return `file-${(this.serial += 1)}.${extension}`;
  }
  /** Files moved in from elsewhere, such as the streaming cache's folder, by where they came from. */
  readonly adopted = new Map<string, string>();
  sizes = new Map<string, number>();
  adopt(uri: string, name: string) {
    const bytes = this.sizes.get(uri);
    if (bytes === undefined) throw new Error(`No file at ${uri}`);
    this.adopted.set(uri, name);
    this.disk.set(name, bytes);
    return bytes;
  }
  /** Transfers still running. */
  active() {
    return this.transfers.filter(transfer => !transfer.cancelled && !this.disk.has(transfer.name));
  }
}

class FakeNetwork {
  value: NetworkKind = 'wifi';
  private readonly listeners = new Set<() => void>();
  kind = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(value: NetworkKind) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}

function descriptorFor(trackId: string, fileId = id(700), bytes: number | null = 1000): PlaybackDescriptor {
  return {
    trackId, albumId, fileId, url: `/api/v1/stream/${fileId}?sig=x&download=1`, expiresAt: '2030-01-01T00:00:00.000Z',
    profile: 'original', transcoded: false, mime: 'audio/flac', codec: 'flac', lossless: true, bitrate: null, sampleRate: 44100,
    bitDepth: 16, durationMs: 1000, bytes, normalization: { trackGainDb: -4, albumGainDb: -5, trackPeak: 0.9, albumPeak: 0.95 },
  };
}

class FakeSource implements DownloadSource {
  fileIds = new Map<string, string>();
  missing = new Set<string>();
  collections = new Map<string, CollectionContent>();
  readonly describes: { trackId: string; quality: StreamQuality }[] = [];
  describe = vi.fn(async (trackId: string, _album: string | null, quality: StreamQuality) => {
    this.describes.push({ trackId, quality });
    if (this.missing.has(trackId)) throw new ApiError(404, 'not_available', 'No file');
    return descriptorFor(trackId, this.fileIds.get(trackId) ?? trackId);
  });
  url = (descriptor: PlaybackDescriptor) => `https://music.test${descriptor.url}`;
  artworkUrl = (artwork: { id: string }) => `https://music.test/api/v1/art/${artwork.id}/600`;
  collection = vi.fn(async (_kind: string, collectionId: string) => {
    const content = this.collections.get(collectionId);
    if (!content) throw new ApiError(404, 'not_found', 'Gone');
    return content;
  });
  /** What the server says of each track now; `server` when not set. */
  availability = new Map<string, TrackSummary['availability']>();
  summaries = vi.fn(async (tracks: readonly { id: string }[]) => tracks.filter(item => !this.missing.has(item.id))
    .map(item => track(Number(item.id.slice(-12)), this.availability.get(item.id) ?? 'server')));
  /** The answer to an acquire request: the statuses of the jobs working on it, or an error. */
  acquireAnswer: (kind: 'track' | 'album', target: string) => AcquisitionJob['status'][] | Error = () => ['queued'];
  readonly acquires: { kind: 'track' | 'album'; id: string; query: AcquireQuery }[] = [];
  /** Each track's lyrics; a track not listed has none (a 404), an error fails the request. */
  lyricsOf = new Map<string, Lyrics | Error>();
  lyrics = vi.fn(async (trackId: string) => {
    const lyrics = this.lyricsOf.get(trackId);
    if (lyrics instanceof Error) throw lyrics;
    return lyrics ?? null;
  });
  acquireTrack = vi.fn(async (trackId: string, query: AcquireQuery) => this.acquire('track', trackId, query));
  acquireAlbum = vi.fn(async (target: string, query: AcquireQuery) => this.acquire('album', target, query));
  private acquire(kind: 'track' | 'album', target: string, query: AcquireQuery): AcquireResponse {
    this.acquires.push({ kind, id: target, query });
    const answer = this.acquireAnswer(kind, target);
    if (answer instanceof Error) throw answer;
    return { items: answer.map(status => job(status, kind === 'track' ? target : null)) };
  }
}

function job(status: AcquisitionJob['status'], trackId: string | null): AcquisitionJob {
  return {
    id: id(990), providerId: id(991), providerName: 'Mock', requestedBy: 'me', trackId, albumId, title: 'Track', status, error: null,
    importId: null, origin: 'download', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', completedAt: null,
  };
}

function setup({ account = 'a', online = true, canFetch = false } = {}) {
  const index = new MemoryIndex(account);
  const files = new FakeFiles();
  const network = new FakeNetwork();
  const source = new FakeSource();
  const options = { quality: 'original' as StreamQuality, wifiOnly: true, capBytes: null as number | null, canFetch };
  const create = () => new DownloadManager({ index, files, network, source, options: { ...options } });
  const manager = create();
  manager.start();
  manager.setOnline(online);
  const settle = () => vi.advanceTimersByTimeAsync(0);
  type Availability = (n: number) => TrackSummary['availability'];
  const album = (count: number, availability: Availability = () => 'server'): AlbumDetail => ({
    id: albumId, mbid: null, title: 'Album', artistCredit: 'Artist', artists: [], year: 2020, type: 'album',
    artwork: { id: id(800), color: '#112233', thumbhash: null }, availability: 'full', trackCount: count, ownedTrackCount: count,
    releaseDate: null, genres: [], description: null, label: null, durationMs: count * 1000,
    discs: [{ disc: 1, title: null, tracks: Array.from({ length: count }, (_, n) => track(n + 1, availability(n + 1))) }], liked: false, wanted: false,
  });
  const addAlbum = (count: number, availability?: Availability) => {
    const detail = album(count, availability);
    manager.addCollection({ id: albumCollectionId(albumId), kind: 'album', title: 'Album', subtitle: 'Artist', artworks: [detail.artwork!] },
      detail.discs[0]!.tracks);
    return detail;
  };
  return { index, files, network, source, manager, create, settle, addAlbum, album };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  MemoryIndex.accounts.clear();
});
afterEach(() => vi.useRealTimers());

describe('DownloadManager queue', () => {
  it('downloads an album three at a time, verifying sizes, with its cover', async () => {
    const { manager, files, index, source, settle, addAlbum } = setup();
    addAlbum(5);
    expect(manager.collection(albumCollectionId(albumId))).toMatchObject({ state: 'downloading', done: 0, total: 5, progress: 0 });
    await settle();
    expect(files.active()).toHaveLength(3);
    expect(source.describes.every(call => call.quality === 'original')).toBe(true);
    expect(files.transfers[0]!.url).toContain('download=1');
    expect(manager.track(id(1))).toEqual({ state: 'downloading', progress: 0 });

    files.transfers[0]!.progress(500, 1000);
    await vi.advanceTimersByTimeAsync(300);
    expect(manager.track(id(1))).toEqual({ state: 'downloading', progress: 0.5 });

    for (const transfer of [...files.transfers]) transfer.complete();
    await settle();
    expect(files.active()).toHaveLength(2);
    for (const transfer of files.active()) transfer.complete();
    await settle();

    expect(manager.collection(albumCollectionId(albumId))).toMatchObject({ state: 'done', done: 5, total: 5, bytes: 5000, progress: 1 });
    expect(index.row(id(1))).toMatchObject({ state: 'done', file: 'file-1.flac', bytes: 1000, art: `art-${id(800)}.webp` });
    expect(index.row(id(1))!.descriptor).not.toHaveProperty('url');
    expect(files.transfers.every(transfer => transfer.finished)).toBe(true);
    expect(manager.summary()).toMatchObject({ usedBytes: 5000, count: 5, pending: 0 });
  });

  it('downloads a recording once, whatever lists it', async () => {
    const { manager, files, settle, addAlbum } = setup();
    addAlbum(2);
    manager.addCollection({ id: playlistCollectionId(id(500)), kind: 'playlist', title: 'Mix', subtitle: '', artworks: [] }, [track(2), track(9)]);
    manager.addTrack(track(9));
    await settle();
    expect(files.transfers.map(transfer => transfer.name)).toHaveLength(3);
    expect(new Set(files.transfers.map(transfer => transfer.url)).size).toBe(3);
  });

  it('for someone who may not have music fetched, downloads what the server has and counts the rest as not available', async () => {
    const { manager, files, source, settle } = setup();
    const mix = playlistCollectionId(id(500));
    manager.addCollection({ id: mix, kind: 'playlist', title: 'Mix', subtitle: '', artworks: [] },
      [track(1), track(2, 'none'), track(3, 'on_demand')]);
    await settle();
    expect(files.transfers).toHaveLength(1);
    expect(source.acquires).toEqual([]);
    expect(downloadStatus(manager.collection(mix)!).text).toBe('Downloading 1 of 3 · 2 not available');
    files.transfers[0]!.complete();
    await settle();
    expect(manager.collection(mix)).toMatchObject({ state: 'incomplete', done: 1, total: 3, unavailable: 2, retryable: false });
    expect(downloadStatus(manager.collection(mix)!)).toMatchObject({ text: '1 of 3 downloaded · 2 not available', retry: false });
  });

  it('retries a failed download with growing waits, then gives up until asked again', async () => {
    const { manager, files, settle } = setup();
    manager.addTrack(track(1));
    await settle();
    files.transfers[0]!.fail();
    await settle();
    expect(manager.track(id(1))).toEqual({ state: 'queued', wait: 'retry' });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(files.transfers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(files.transfers).toHaveLength(2);
    files.transfers[1]!.fail();
    await settle();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(files.transfers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(files.transfers).toHaveLength(3);

    for (let attempt = 3; attempt <= maxAttempts; attempt += 1) {
      files.transfers.at(-1)!.fail('server error');
      await vi.advanceTimersByTimeAsync(20 * 60_000);
    }
    expect(manager.track(id(1))).toEqual({ state: 'failed', error: 'server error' });
    expect(files.transfers).toHaveLength(maxAttempts);
    expect(manager.collection('songs')).toMatchObject({ state: 'failed' });

    manager.retry();
    await settle();
    files.transfers.at(-1)!.complete();
    await settle();
    expect(manager.track(id(1))).toMatchObject({ state: 'done' });
  });

  it('fails at once, flagged, when the server has no file of the track', async () => {
    const { manager, source, files, index, settle } = setup();
    source.missing.add(id(1));
    manager.addTrack(track(1));
    await settle();
    expect(files.transfers).toHaveLength(0);
    expect(manager.track(id(1))).toEqual({ state: 'failed', error: 'This song is no longer on the server.' });
    expect(index.row(id(1))).toMatchObject({ gone: true });
  });

  it('discards a transfer that is shorter than announced', async () => {
    const { manager, files, settle } = setup();
    manager.addTrack(track(1));
    await settle();
    files.transfers[0]!.complete(600, 1000);
    await settle();
    expect(files.disk.has(files.transfers[0]!.name)).toBe(false);
    expect(manager.track(id(1))).toEqual({ state: 'queued', wait: 'retry' });
  });

  it('waits for Wi-Fi on cellular, pausing what runs, and resumes it', async () => {
    const { manager, files, network, settle, addAlbum } = setup();
    addAlbum(4);
    await settle();
    files.transfers[0]!.progress(400, 1000);
    network.set('cellular');
    await settle();
    expect(manager.summary()).toMatchObject({ wait: 'wifi', pending: 4 });
    expect(manager.collection(albumCollectionId(albumId))).toMatchObject({ state: 'queued', wait: 'wifi' });
    expect(files.transfers).toHaveLength(3);

    network.set('wifi');
    await settle();
    expect(files.transfers).toHaveLength(3);
    expect(files.transfers.map(transfer => transfer.runs)).toEqual([2, 2, 2]);
    manager.setOptions({ wifiOnly: false });
    network.set('cellular');
    await settle();
    expect(manager.summary().wait).toBeNull();
  });

  it('starts nothing while the server cannot be reached, or past the storage limit', async () => {
    const offline = setup({ online: false });
    offline.manager.addTrack(track(1));
    await offline.settle();
    expect(offline.files.transfers).toHaveLength(0);
    expect(offline.manager.track(id(1))).toEqual({ state: 'queued', wait: 'offline' });

    MemoryIndex.accounts.clear();
    const capped = setup();
    capped.manager.setOptions({ capBytes: 1500 });
    capped.addAlbum(3);
    await capped.settle();
    for (const transfer of [...capped.files.transfers]) transfer.complete();
    await capped.settle();
    capped.manager.addTrack(track(4));
    await capped.settle();
    expect(capped.files.transfers).toHaveLength(3);
    expect(capped.manager.track(id(4))).toEqual({ state: 'queued', wait: 'storage' });
  });

  it('counts the other accounts’ downloads toward the device’s storage limit', async () => {
    const { manager, files, settle } = setup();
    manager.setOptions({ capBytes: 1500, otherBytes: 1500 });
    manager.addTrack(track(1));
    await settle();
    expect(files.transfers).toHaveLength(0);
    expect(manager.track(id(1))).toEqual({ state: 'queued', wait: 'storage' });
    // That account's downloads were removed: there is room again.
    manager.setOptions({ otherBytes: 0 });
    await settle();
    expect(files.transfers).toHaveLength(1);
  });

  it('moves the streaming cache’s whole file of the same stream in instead of downloading it again', async () => {
    const { manager, files, index, settle } = setup();
    const taken: string[] = [];
    files.sizes.set('file:///cache/one.flac', 1000);
    manager.setStreamingCache({
      take: (trackId, stream) => {
        taken.push(`${trackId}:${stream.fileId}:${stream.profile}`);
        return trackId === id(1) ? { uri: 'file:///cache/one.flac', bytes: 1000 } : null;
      },
    });
    manager.addTrack(track(1));
    manager.addTrack(track(2));
    await settle();
    // Asked with exactly the stream the download would fetch.
    expect(taken).toEqual([`${id(1)}:${id(1)}:original`, `${id(2)}:${id(2)}:original`]);
    expect(files.adopted.get('file:///cache/one.flac')).toBe('file-1.flac');
    expect(index.row(id(1))).toMatchObject({ state: 'done', file: 'file-1.flac', bytes: 1000 });
    expect(manager.playback(id(1))?.url).toBe('file:///downloads/file-1.flac');
    // The other is downloaded as ever.
    expect(files.transfers.map(transfer => transfer.name)).toEqual(['file-2.flac']);
  });

  it('downloads after all when the cached file cannot be moved', async () => {
    const { manager, files, settle } = setup();
    manager.setStreamingCache({ take: () => ({ uri: 'file:///cache/gone.flac', bytes: 1000 }) });
    manager.addTrack(track(1));
    await settle();
    expect(files.transfers).toHaveLength(1);
    files.transfers[0]!.complete();
    await settle();
    expect(manager.isDownloaded(id(1))).toBe(true);
  });

  it('plays a download from its file with its normalization', async () => {
    const { manager, files, settle } = setup();
    manager.addTrack(track(1));
    expect(manager.playback(id(1))).toBeNull();
    await settle();
    files.transfers[0]!.complete();
    await settle();
    expect(manager.playback(id(1))).toMatchObject({
      url: 'file:///downloads/file-1.flac', normalization: { trackGainDb: -4 }, fileId: id(1),
    });
    expect(manager.isDownloaded(id(1))).toBe(true);
    expect(manager.artworkUri(id(800))).toBe(`file:///downloads/art-${id(800)}.webp`);
  });
});

describe('DownloadManager songs the server does not have yet', () => {
  const mix = playlistCollectionId(id(500));
  const addMix = (manager: DownloadManager, tracks: TrackSummary[]) =>
    manager.addCollection({ id: mix, kind: 'playlist', title: 'Mix', subtitle: '', artworks: [] }, tracks);
  const status = (manager: DownloadManager, collection = mix) => downloadStatus(manager.collection(collection)!).text;

  it('asks the server for them as a download, and downloads each once the server has it', async () => {
    const { manager, files, source, settle } = setup({ canFetch: true });
    addMix(manager, [track(1), track(2), track(3, 'on_demand')]);
    await settle();
    expect(source.acquires).toEqual([{ kind: 'track', id: id(3), query: { albumId, origin: 'download' } }]);
    expect(files.transfers).toHaveLength(2);
    expect(manager.collection(mix)).toMatchObject({ state: 'downloading', done: 0, total: 3 });
    expect(status(manager)).toBe('Downloading 1 of 3');
    expect(manager.track(id(3))).toEqual({ state: 'queued', wait: null });

    for (const transfer of [...files.transfers]) transfer.complete();
    await settle();
    // Two of three are here: still downloading, never "Downloaded".
    expect(manager.collection(mix)).toMatchObject({ state: 'downloading', done: 2, total: 3 });
    expect(status(manager)).toBe('Downloading 3 of 3');

    // The server says it has the song (an `invalidate` of the track).
    expect(manager.awaits(id(3))).toBe(true);
    source.availability.set(id(3), 'server');
    await manager.refreshTracks([id(3)]);
    await settle();
    expect(files.transfers).toHaveLength(3);
    expect(files.transfers[2]!.url).toContain(id(3));
    files.transfers[2]!.complete();
    await settle();
    expect(manager.collection(mix)).toMatchObject({ state: 'done', done: 3, total: 3 });
    expect(status(manager)).toBe('Downloaded · 2.9 KB');
    expect(source.acquires).toHaveLength(1);
  });

  it('asks for a downloaded album’s missing songs in one request', async () => {
    const { manager, files, source, settle, addAlbum } = setup({ canFetch: true });
    addAlbum(3, n => n === 1 ? 'server' : 'on_demand');
    await settle();
    expect(source.acquires).toEqual([{ kind: 'album', id: albumId, query: { origin: 'download' } }]);
    expect(source.acquireTrack).not.toHaveBeenCalled();
    files.transfers[0]!.complete();
    await settle();
    expect(status(manager, albumCollectionId(albumId))).toBe('Downloading 2 of 3');

    source.availability.set(id(2), 'server');
    source.availability.set(id(3), 'on_demand');
    await manager.refreshTracks([id(2), id(3)]);
    await settle();
    expect(files.transfers).toHaveLength(2);
    expect(manager.awaits(id(3))).toBe(true);
  });

  it('downloads a single song the server does not have yet', async () => {
    const { manager, files, source, settle } = setup({ canFetch: true });
    manager.addTrack(track(4, 'on_demand'));
    await settle();
    expect(source.acquires).toEqual([{ kind: 'track', id: id(4), query: { albumId, origin: 'download' } }]);
    expect(files.transfers).toHaveLength(0);
    // The job finished before the next look: asking again says so.
    source.acquireAnswer = () => ['completed'];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.acquires).toHaveLength(2);
    expect(files.transfers).toHaveLength(1);
  });

  it('reports a song the server could not get, never as downloaded, and asks again on retry', async () => {
    const { manager, files, source, settle } = setup({ canFetch: true });
    source.acquireAnswer = () => new ApiError(404, 'not_available', 'No provider can supply this track right now');
    addMix(manager, [track(1), track(2), track(3, 'on_demand')]);
    await settle();
    for (const transfer of [...files.transfers]) transfer.complete();
    await settle();
    expect(manager.track(id(3))).toEqual({ state: 'failed', error: 'Not available', unavailable: true });
    expect(manager.collection(mix)).toMatchObject({ state: 'incomplete', done: 2, total: 3, unavailable: 1, retryable: true });
    expect(downloadStatus(manager.collection(mix)!)).toMatchObject({ text: '2 of 3 downloaded · 1 not available', retry: true });
    expect(manager.summary()).toMatchObject({ count: 2, pending: 0, unavailable: 1 });

    source.acquireAnswer = () => ['queued'];
    manager.retry();
    await vi.advanceTimersByTimeAsync(fetchGapMs);
    expect(source.acquires).toHaveLength(2);
    expect(status(manager)).toBe('Downloading 3 of 3');
  });

  it('gives up on a song when the server says no one can have it', async () => {
    const { manager, files, source, settle } = setup({ canFetch: true });
    addMix(manager, [track(1), track(2, 'on_demand')]);
    await settle();
    files.transfers[0]!.complete();
    await settle();
    // A missed fetch grays the song out, and the server invalidates it.
    source.availability.set(id(2), 'none');
    await manager.refreshTracks([id(2)]);
    expect(manager.collection(mix)).toMatchObject({ state: 'incomplete', done: 1, unavailable: 1 });
    expect(status(manager)).toBe('1 of 2 downloaded · 1 not available');
  });

  it('counts a request refused outright as not available', async () => {
    const { manager, source, settle } = setup({ canFetch: true });
    source.acquireAnswer = () => ['failed'];
    manager.addTrack(track(1, 'on_demand'));
    await settle();
    expect(manager.track(id(1))).toMatchObject({ state: 'failed', unavailable: true });
  });

  it('asks again later while no word comes, and gives up after a while', async () => {
    const { manager, source, settle } = setup({ canFetch: true });
    manager.addTrack(track(1, 'on_demand'));
    await settle();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(source.acquires).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(source.acquires).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3 * 3600_000);
    expect(source.acquires).toHaveLength(8);
    expect(manager.track(id(1))).toMatchObject({ state: 'failed', unavailable: true });
  });

  it('paces its requests, and waits when the server says too many are running', async () => {
    const { manager, source, settle } = setup({ canFetch: true });
    source.acquireAnswer = (_kind, target) => target === id(2) ? new ApiError(429, 'acquire_limit_reached', 'Too many') : ['queued'];
    addMix(manager, [1, 2, 3].map(n => track(n, 'on_demand')));
    await settle();
    expect(source.acquires.map(call => call.id)).toEqual([id(1)]);
    await vi.advanceTimersByTimeAsync(fetchGapMs);
    expect(source.acquires.map(call => call.id)).toEqual([id(1), id(2)]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.acquires).toHaveLength(2);
    source.acquireAnswer = () => ['queued'];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(source.acquires.map(call => call.id)).toEqual([id(1), id(2), id(2)]);
    await vi.advanceTimersByTimeAsync(fetchGapMs);
    expect(source.acquires.map(call => call.id)).toEqual([id(1), id(2), id(2), id(3)]);
  });

  it('asks the server even on cellular with Wi-Fi only, and holds only the download', async () => {
    const { manager, network, source, files, settle } = setup({ canFetch: true });
    network.set('cellular');
    addMix(manager, [track(1, 'on_demand')]);
    await settle();
    expect(source.acquires).toHaveLength(1);
    source.availability.set(id(1), 'server');
    await manager.refreshTracks([id(1)]);
    await settle();
    expect(files.transfers).toHaveLength(0);
    expect(status(manager)).toBe('Waiting for Wi-Fi');
  });

  it('keeps waiting for them across a relaunch', async () => {
    const first = setup({ canFetch: true });
    addMix(first.manager, [track(1), track(2, 'on_demand')]);
    await first.settle();
    first.manager.dispose();
    expect(first.index.row(id(2))).toMatchObject({ state: 'fetching', attempts: 1 });

    const manager = new DownloadManager({
      index: first.index, files: first.files, network: first.network, source: first.source,
      options: { quality: 'original', wifiOnly: true, capBytes: null, canFetch: true },
    });
    manager.start();
    manager.setOnline(true);
    expect(manager.collection(mix)).toMatchObject({ total: 2, state: 'downloading' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.source.acquires).toHaveLength(2);
  });

  it('picks up songs the server got for someone else on the next sync', async () => {
    const { manager, files, source, settle } = setup();
    addMix(manager, [track(1), track(2, 'on_demand')]);
    await settle();
    files.transfers[0]!.complete();
    await settle();
    expect(manager.collection(mix)).toMatchObject({ state: 'incomplete' });
    source.collections.set(id(500), { tracks: [track(1), track(2)] });
    await manager.sync();
    await settle();
    expect(files.transfers).toHaveLength(2);
    expect(source.acquires).toEqual([]);
  });
});

describe('DownloadManager removal and reconciliation', () => {
  it('removes files and rows together, keeping tracks another list still has', async () => {
    const { manager, files, index, settle, addAlbum } = setup();
    addAlbum(2);
    manager.addCollection({ id: playlistCollectionId(id(500)), kind: 'playlist', title: 'Mix', subtitle: '', artworks: [] }, [track(2)]);
    await settle();
    for (const transfer of [...files.transfers]) transfer.complete();
    await settle();
    const changed = vi.fn();
    manager.onFilesChanged(changed);

    manager.removeCollection(albumCollectionId(albumId));
    expect(index.row(id(1))).toBeUndefined();
    expect(files.disk.has('file-1.flac')).toBe(false);
    expect(manager.isDownloaded(id(2))).toBe(true);
    expect(files.disk.has(`art-${id(800)}.webp`)).toBe(true);
    expect(changed).toHaveBeenCalled();

    manager.removeCollection(playlistCollectionId(id(500)));
    expect(files.disk.size).toBe(0);
    expect(index.load()).toEqual({ downloads: [], collections: [] });
  });

  it('cancels a running download when it is removed', async () => {
    const { manager, files, settle } = setup();
    manager.addTrack(track(1));
    await settle();
    manager.removeTrack(id(1));
    await settle();
    expect(files.transfers[0]!.cancelled).toBe(true);
    expect(manager.track(id(1))).toBeUndefined();
  });

  it('removes every download of the account but not another account’s', async () => {
    const other = setup({ account: 'b' });
    other.manager.addTrack(track(1));
    await other.settle();
    other.files.transfers[0]!.complete();
    await other.settle();

    const { manager, files, settle, addAlbum } = setup({ account: 'a' });
    addAlbum(2);
    await settle();
    for (const transfer of [...files.transfers]) transfer.complete();
    await settle();
    files.disk.set('file-1.flac', 1000);
    manager.removeAll();
    expect(manager.summary()).toMatchObject({ count: 0, collections: [] });
    expect(MemoryIndex.accounts.get('b')!.downloads.size).toBe(1);
  });

  it('on launch, deletes stray files and downloads again what is missing or was cut off', async () => {
    const first = setup();
    first.addAlbum(3);
    await first.settle();
    first.files.transfers[0]!.complete();
    first.files.transfers[1]!.complete();
    await first.settle();
    first.manager.dispose();

    const files = first.files;
    files.disk.delete('file-2.flac');
    files.disk.set('stray.flac', 5);
    const before = files.transfers.length;
    const manager = new DownloadManager({ index: first.index, files, network: first.network, source: first.source, options: { quality: 'original', wifiOnly: true, capBytes: null, canFetch: false } });
    manager.start();
    expect(files.disk.has('stray.flac')).toBe(false);
    expect(first.index.row(id(1))).toMatchObject({ state: 'done' });
    expect(first.index.row(id(2))).toMatchObject({ state: 'queued', file: null });
    expect(first.index.row(id(3))).toMatchObject({ state: 'queued' });
    manager.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(files.transfers.slice(before).map(transfer => transfer.url)).toEqual([
      `https://music.test/api/v1/stream/${id(2)}?sig=x&download=1`, `https://music.test/api/v1/stream/${id(3)}?sig=x&download=1`,
    ]);
  });
});

describe('DownloadManager sync', () => {
  const playlist = (tracks: TrackSummary[]): PlaylistDetail => ({
    id: id(500), name: 'Mix', description: null, ownerId: id(1), ownerName: 'me', isPublic: false, trackCount: tracks.length,
    durationMs: 0, artworks: [], updatedAt: '2026-01-01T00:00:00.000Z',
    items: tracks.map((item, n) => ({ itemId: id(600 + n), addedAt: '2026-01-01T00:00:00.000Z', track: item })),
  });

  async function downloaded(tracks: TrackSummary[]) {
    const context = setup();
    context.manager.addCollection({ id: playlistCollectionId(id(500)), kind: 'playlist', title: 'Mix', subtitle: '', artworks: [] }, tracks);
    await context.settle();
    for (const transfer of [...context.files.transfers]) transfer.complete();
    await context.settle();
    return context;
  }

  it('picks up tracks added to a downloaded playlist and drops removed ones', async () => {
    const { manager, source, files, settle } = await downloaded([track(1), track(2)]);
    const content = playlist([track(2), track(3)]);
    source.collections.set(id(500), { tracks: content.items.map(item => item.track), playlist: content });
    await manager.sync();
    await settle();
    expect(manager.isDownloaded(id(1))).toBe(false);
    expect(files.disk.has('file-1.flac')).toBe(false);
    expect(manager.collection(playlistCollectionId(id(500)))).toMatchObject({ total: 2, done: 1, state: 'downloading' });
    expect(manager.collectionRow(playlistCollectionId(id(500)))?.playlist).toMatchObject({ name: 'Mix' });
  });

  it('downloads a file again when the server replaced it, playing the old one meanwhile', async () => {
    const { manager, source, files, settle } = await downloaded([track(1)]);
    source.collections.set(id(500), { tracks: [track(1)], playlist: playlist([track(1)]) });
    vi.setSystemTime(1_000_000 + 25 * 3600_000);
    source.fileIds.set(id(1), id(701));
    await manager.sync();
    await settle();
    expect(manager.track(id(1))).toMatchObject({ state: 'done' });
    expect(manager.playback(id(1))?.url).toBe('file:///downloads/file-1.flac');
    files.transfers.at(-1)!.complete();
    await settle();
    expect(manager.playback(id(1))).toMatchObject({ url: 'file:///downloads/file-2.flac', fileId: id(701) });
    expect(files.disk.has('file-1.flac')).toBe(false);
  });

  it('checks files at most once a day', async () => {
    const { manager, source } = await downloaded([track(1)]);
    source.collections.set(id(500), { tracks: [track(1)], playlist: playlist([track(1)]) });
    const before = source.describes.length;
    await manager.sync();
    expect(source.describes.length).toBe(before);
  });

  it('flags tracks and playlists the server no longer has, keeping their files', async () => {
    const { manager, source, index } = await downloaded([track(1), track(2)]);
    source.collections.set(id(500), { tracks: [track(1), track(2, 'none')], playlist: playlist([track(1)]) });
    await manager.sync();
    expect(index.row(id(2))).toMatchObject({ gone: true, state: 'done' });
    expect(manager.track(id(2))).toMatchObject({ state: 'done', gone: true });

    source.collections.delete(id(500));
    await manager.sync();
    expect(manager.collection(playlistCollectionId(id(500)))).toMatchObject({ gone: true, done: 2 });
  });

  it('flags songs downloaded on their own that are gone from the server', async () => {
    const { manager, source, files, settle } = setup();
    manager.addTrack(track(4));
    await settle();
    files.transfers[0]!.complete();
    await settle();
    source.missing.add(id(4));
    await manager.sync();
    expect(manager.track(id(4))).toMatchObject({ state: 'done', gone: true });
  });

  it('does nothing offline', async () => {
    const { manager, source } = setup({ online: false });
    await manager.sync();
    expect(source.collection).not.toHaveBeenCalled();
  });
});

describe('DownloadManager lyrics', () => {
  const lyricsFor = (trackId: string): Lyrics => ({ trackId, synced: '[00:01.00]Quiet tone', plain: 'Quiet tone', instrumental: false, source: 'lrclib' });
  const withLyrics = (n: number) => ({ ...track(n), hasLyrics: true });
  const addSongs = (manager: DownloadManager, tracks: TrackSummary[]) => manager.addCollection(
    { id: playlistCollectionId(id(950)), kind: 'playlist', title: 'Mix', subtitle: 'Playlist', artworks: [] }, tracks);

  it('keeps a downloaded song’s lyrics with it, and asks nothing for a song without', async () => {
    const { manager, files, index, source, settle } = setup();
    source.lyricsOf.set(id(1), lyricsFor(id(1)));
    addSongs(manager, [withLyrics(1), track(2)]);
    await settle();
    expect(manager.lyrics(id(1))).toBeUndefined();
    for (const transfer of [...files.transfers]) transfer.complete();
    await settle();
    expect(manager.lyrics(id(1))).toEqual(lyricsFor(id(1)));
    expect(index.row(id(1))!.lyrics).toEqual(lyricsFor(id(1)));
    expect(manager.lyrics(id(2))).toBeNull();
    expect(source.lyrics.mock.calls).toEqual([[id(1)]]);
  });

  it('asks again on the next sync when the request failed, and for downloads made before lyrics were kept', async () => {
    const { manager, files, index, source, settle } = setup();
    source.lyricsOf.set(id(1), new Error('network down'));
    addSongs(manager, [withLyrics(1)]);
    await settle();
    files.transfers[0]!.complete();
    await settle();
    expect(manager.lyrics(id(1))).toBeUndefined();

    source.lyricsOf.set(id(1), lyricsFor(id(1)));
    source.collections.set(id(950), { tracks: [withLyrics(1)] });
    await manager.sync();
    expect(index.row(id(1))!.lyrics).toEqual(lyricsFor(id(1)));
  });

  it('keeps lyrics read on the Lyrics page for a downloaded song only', async () => {
    const { manager, files, settle } = setup();
    addSongs(manager, [track(1), track(2)]);
    await settle();
    files.transfers[0]!.complete();
    await settle();
    manager.keepLyrics(id(1), lyricsFor(id(1)));
    manager.keepLyrics(id(2), lyricsFor(id(2)));
    expect(manager.lyrics(id(1))).toEqual(lyricsFor(id(1)));
    expect(manager.lyrics(id(2))).toBeUndefined();
  });
});
