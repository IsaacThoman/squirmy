import { ApiError } from '@squirmy/client-core';
import type { PlaybackDescriptor, StreamQuality, TrackSummary } from '@squirmy/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkKind } from '../downloads/model';
import { StreamingCache, type CacheFiles, type CacheIndex, type CacheSettings, type CacheSource } from './manager';
import type { CacheRow, Near, Outlook } from './model';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const numberOf = (trackId: string) => Number(trackId.slice(-12));
const fileIdOf = (trackId: string) => id(700 + numberOf(trackId));
const day = 24 * 3600_000;

function track(n: number): TrackSummary {
  return {
    id: id(n), mbid: null, title: `Track ${n}`, artistCredit: 'Artist', artists: [], durationMs: 1000,
    album: { id: id(900), title: 'Album', artwork: { id: id(800), color: null, thumbhash: null } },
    disc: 1, position: n, availability: 'server', liked: false, explicit: null, hasLyrics: false,
  };
}

function descriptorFor(trackId: string, quality: StreamQuality, fileId = fileIdOf(trackId), bytes: number | null = 1000): PlaybackDescriptor {
  const transcoded = quality !== 'original';
  return {
    trackId, albumId: id(900), fileId, url: `/api/v1/stream/${fileId}${transcoded ? '/aac_256' : ''}?sig=x`, expiresAt: '2030-01-01T00:00:00.000Z',
    profile: transcoded ? 'aac_256' : 'original', transcoded, mime: transcoded ? 'audio/aac' : 'audio/flac', codec: transcoded ? 'aac' : 'flac',
    lossless: !transcoded, bitrate: null, sampleRate: 44100, bitDepth: 16, durationMs: 1000, bytes: transcoded ? null : bytes,
    normalization: { trackGainDb: -4, albumGainDb: -5, trackPeak: 0.9, albumPeak: 0.95 },
  };
}

function row(n: number, values: Partial<CacheRow> = {}): CacheRow {
  const quality = values.quality ?? 'original';
  const { url: _url, expiresAt: _expiresAt, ...descriptor } = descriptorFor(id(n), quality);
  return {
    trackId: id(n), albumId: id(900), quality, file: `seed-${n}-${quality}.flac`, fileId: descriptor.fileId, bytes: 1000, art: null,
    descriptor, track: track(n), addedAt: Date.now(), playedAt: null, checkedAt: Date.now(), ...values,
  };
}

/** The index as SQLite would keep it, shared between accounts. */
class MemoryIndex implements CacheIndex {
  static readonly accounts = new Map<string, Map<string, CacheRow>>();
  constructor(private readonly account = 'a') {
    if (!MemoryIndex.accounts.has(account)) MemoryIndex.accounts.set(account, new Map());
  }
  private get data() {
    return MemoryIndex.accounts.get(this.account)!;
  }
  load() {
    return [...this.data.values()];
  }
  put(rows: readonly CacheRow[]) {
    for (const item of rows) this.data.set(`${item.trackId}:${item.quality}`, item);
  }
  remove(rows: readonly Pick<CacheRow, 'trackId' | 'quality'>[]) {
    for (const item of rows) this.data.delete(`${item.trackId}:${item.quality}`);
  }
  removeOthers() {
    for (const account of [...MemoryIndex.accounts.keys()]) if (account !== this.account) MemoryIndex.accounts.delete(account);
  }
  referencedFiles() {
    const names = new Set<string>();
    for (const rows of MemoryIndex.accounts.values()) for (const item of rows.values()) for (const name of [item.file, item.art]) if (name) names.add(name);
    return names;
  }
  row(n: number, quality: StreamQuality = 'original') {
    return this.data.get(`${id(n)}:${quality}`);
  }
  tracks() {
    return [...this.data.values()].map(item => numberOf(item.trackId)).sort((a, b) => a - b);
  }
}

class FakeFetch {
  cancelled = false;
  failed = false;
  readonly done: Promise<{ written: number; total: number }>;
  private settle: (value: { written: number; total: number }) => void = () => undefined;
  private reject: (error: Error) => void = () => undefined;
  constructor(readonly url: string, readonly name: string, private readonly files: FakeFiles) {
    this.done = new Promise((resolve, reject) => {
      this.settle = resolve;
      this.reject = reject;
    });
  }
  complete(written = 1000, total = written) {
    this.files.disk.set(this.name, written);
    this.settle({ written, total });
  }
  fail(message = 'network down') {
    this.failed = true;
    this.reject(new Error(message));
  }
  cancel = () => {
    this.cancelled = true;
    this.reject(new Error('cancelled'));
  };
}

class FakeFiles implements CacheFiles {
  readonly disk = new Map<string, number>();
  readonly fetches: FakeFetch[] = [];
  free = 10 * 1000 ** 3;
  private serial = 0;
  fetch(url: string, name: string) {
    const fetch = new FakeFetch(url, name, this);
    this.fetches.push(fetch);
    return fetch;
  }
  async fetchSmall(_url: string, name: string) {
    this.disk.set(name, 10);
  }
  remove(name: string) {
    this.disk.delete(name);
  }
  exists(name: string) {
    return this.disk.has(name);
  }
  list() {
    return new Map(this.disk);
  }
  uri(name: string) {
    return `file:///cache/${name}`;
  }
  newName(extension: string) {
    return `file-${(this.serial += 1)}.${extension}`;
  }
  freeBytes() {
    return this.free;
  }
  /** Fetches still running. */
  active() {
    return this.fetches.filter(fetch => !fetch.cancelled && !fetch.failed && !this.disk.has(fetch.name));
  }
  audio() {
    return [...this.disk.keys()].filter(name => !name.endsWith('.webp')).sort();
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

class FakeSource implements CacheSource {
  fileIds = new Map<string, string>();
  missing = new Set<string>();
  bytes: number | null = 1000;
  readonly describes: string[] = [];
  describe = vi.fn(async (trackId: string, _album: string | null, quality: StreamQuality) => {
    this.describes.push(`${numberOf(trackId)}:${quality}`);
    if (this.missing.has(trackId)) throw new ApiError(404, 'not_available', 'No file');
    return descriptorFor(trackId, quality, this.fileIds.get(trackId), this.bytes);
  });
  url = (descriptor: PlaybackDescriptor) => `https://music.test${descriptor.url}`;
  track = vi.fn(async (trackId: string) => track(numberOf(trackId)));
  artworkUrl = (artwork: { id: string }) => `https://music.test/api/v1/art/${artwork.id}/600`;
}

/** Eight milliseconds of lossless audio is guessed at 1000 bytes, the size the fake server announces. */
const entry = (n: number, state: Near['state'] = 'ready'): Near => ({ trackId: id(n), albumId: id(900), durationMs: 8, state });
const outlook = (role: Outlook['role'], current: number | null, ...upcoming: (number | Near)[]): Outlook => ({
  role, current: current === null ? null : entry(current), upcoming: upcoming.map(item => typeof item === 'number' ? entry(item) : item),
});

function setup({ seed = [], settings = {}, account = 'a', online = true, files = new FakeFiles(), downloaded = () => false }: {
  seed?: CacheRow[]; settings?: Partial<CacheSettings>; account?: string; online?: boolean; files?: FakeFiles; downloaded?: (trackId: string) => boolean;
} = {}) {
  const index = new MemoryIndex(account);
  index.put(seed);
  for (const item of seed) files.disk.set(item.file, item.bytes);
  const network = new FakeNetwork();
  const source = new FakeSource();
  const cache = new StreamingCache({
    index, files, network, source, downloaded, settleMs: 0,
    settings: { limitBytes: 1_000_000, wifiQuality: 'original', cellularQuality: 'high', ...settings },
  });
  const changed: number[] = [];
  cache.onFilesChanged(trackId => changed.push(numberOf(trackId)));
  cache.start();
  cache.setOnline(online);
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) await vi.advanceTimersByTimeAsync(0);
  };
  /** Completes every running fetch, and the ones that completing them starts. */
  const finish = async (bytes = 1000) => {
    await settle();
    for (let round = 0; round < 10 && files.active().length; round += 1) {
      for (const fetch of files.active()) fetch.complete(bytes);
      await settle();
    }
  };
  return { cache, index, files, network, source, changed, settle, finish };
}

/** Runs `then` after `turns` microtasks. */
function later(turns: number, then: () => void): void {
  if (turns === 0) then();
  else queueMicrotask(() => later(turns - 1, then));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100 * day);
  MemoryIndex.accounts.clear();
});
afterEach(() => vi.useRealTimers());

describe('StreamingCache', () => {
  it('fetches the next two entries, then the stream being played, and records each file', async () => {
    const { cache, index, files, source, changed, settle } = setup();
    cache.setOutlook(outlook('active', 1, 2, 3, 4));
    await settle();
    expect(source.describes).toEqual(['2:original', '3:original']);
    expect(files.fetches.map(fetch => fetch.url)).toEqual([`https://music.test/api/v1/stream/${id(702)}?sig=x`, `https://music.test/api/v1/stream/${id(703)}?sig=x`]);
    expect(cache.has(id(2))).toBe(false);

    files.fetches[0]!.complete();
    await settle();
    expect(changed).toEqual([2]);
    expect(cache.has(id(2))).toBe(true);
    expect(index.row(2)).toMatchObject({
      file: 'file-1.flac', fileId: id(702), bytes: 1000, quality: 'original', albumId: id(900), playedAt: null, addedAt: Date.now(),
      art: `art-${id(800)}.webp`, track: { title: 'Track 2' }, descriptor: { normalization: { trackGainDb: -4 }, codec: 'flac' },
    });
    expect(index.row(2)!.descriptor).not.toHaveProperty('url');
    // The slot it freed goes to the stream being played.
    expect(source.describes).toEqual(['2:original', '3:original', '1:original']);

    files.fetches[1]!.complete();
    files.fetches[2]!.complete();
    await settle();
    expect(index.tracks()).toEqual([1, 2, 3]);
    // The track that plays has been played.
    expect(index.row(1)!.playedAt).toBe(Date.now());
    expect(cache.summary()).toEqual({ usedBytes: 3000, count: 3 });
    expect(files.active()).toEqual([]);
  });

  it('plays a cached track from its file, with the server’s normalization', async () => {
    const { cache } = setup({ seed: [row(2), row(3, { quality: 'high' })] });
    expect(cache.playback(id(2), 'original')).toMatchObject({
      url: 'file:///cache/seed-2-original.flac', fileId: id(702), expiresAt: '2100-01-01T00:00:00.000Z', normalization: { trackGainDb: -4, albumGainDb: -5 },
    });
    // A better copy than asked for plays; a lesser one only when nothing else can.
    expect(cache.playback(id(2), 'data_saver')?.url).toBe('file:///cache/seed-2-original.flac');
    expect(cache.playback(id(3), 'original')).toBeNull();
    expect(cache.playback(id(3), 'original', true)?.url).toBe('file:///cache/seed-3-high.flac');
    expect(cache.playback(id(9), 'original', true)).toBeNull();
    expect(cache.artworkUri(id(800))).toBeNull();
  });

  it('keeps the cover of a cached track and removes it with the last track that uses it', async () => {
    const { cache, files, finish } = setup();
    cache.setOutlook(outlook('active', 1, 2));
    await finish();
    expect(cache.artworkUri(id(800))).toBe(`file:///cache/art-${id(800)}.webp`);
    cache.setOutlook(outlook('remote', null));
    cache.clear();
    expect(cache.artworkUri(id(800))).toBeNull();
    expect([...files.disk.keys()]).toEqual([]);
  });

  it('removes the least recently played files once a new one takes it over the limit', async () => {
    const seed = [row(10, { playedAt: 100 }), row(11, { playedAt: 300 }), row(12, { addedAt: 200 })];
    const { cache, index, files, changed, settle, finish } = setup({ seed, settings: { limitBytes: 3500 } });
    cache.setOutlook(outlook('active', 1, 2));
    await settle();
    files.fetches[0]!.complete();
    await settle();
    // 4000 bytes: the one played longest ago goes.
    expect(index.tracks()).toEqual([2, 11, 12]);
    expect(changed).toEqual([2, 10]);
    await finish();
    // Then the one that was fetched ahead and never played, which is older than the last play of 11.
    expect(index.tracks()).toEqual([1, 2, 11]);
    expect(files.audio()).toEqual(['file-1.flac', 'file-2.flac', 'seed-11-original.flac']);
    expect(cache.summary().usedBytes).toBe(3000);
  });

  it('evicts at once when the limit is lowered, but never what plays or follows', async () => {
    const seed = [row(1, { playedAt: 1 }), row(2, { playedAt: 2 }), row(3, { playedAt: 900 }), row(4, { playedAt: 800 })];
    const { cache, index, files, changed, settle } = setup({ seed });
    cache.setOutlook(outlook('active', 1, 2));
    await settle();
    cache.setSettings({ limitBytes: 3000 });
    expect(index.tracks()).toEqual([1, 2, 3]);
    cache.setSettings({ limitBytes: 1000 });
    // Still over the limit, but the player holds both files.
    expect(index.tracks()).toEqual([1, 2]);
    expect(changed).toEqual([4, 3]);
    cache.setOutlook(outlook('active', 2));
    await settle();
    expect(index.tracks()).toEqual([2]);
    expect(files.audio()).toEqual(['seed-2-original.flac']);
  });

  it('turned off, fetches nothing and lets go of everything as the player does', async () => {
    const { cache, index, files, settle } = setup({ seed: [row(1), row(2), row(5)] });
    cache.setOutlook(outlook('active', 1, 2, 3, 4));
    await settle();
    expect(files.active().map(fetch => fetch.url)).toEqual([`https://music.test/api/v1/stream/${id(703)}?sig=x`]);
    cache.setSettings({ limitBytes: 0 });
    expect(files.fetches.every(fetch => fetch.cancelled)).toBe(true);
    expect(index.tracks()).toEqual([1, 2]);
    cache.setOutlook(outlook('active', 3, 4));
    await settle();
    expect(index.tracks()).toEqual([]);
    expect(files.audio()).toEqual([]);
    expect(files.active()).toEqual([]);
  });

  it('stops fetches the queue moved away from and discards what they had', async () => {
    const { cache, index, files, source, settle, finish } = setup();
    cache.setOutlook(outlook('active', 1, 2, 3));
    await settle();
    const [second, third] = files.fetches;
    cache.setOutlook(outlook('active', 3, 6, 7));
    await settle();
    expect(second!.cancelled).toBe(true);
    // Track 3 is still near, now as the stream being played: its fetch carries on.
    expect(third!.cancelled).toBe(false);
    expect(source.describes).toEqual(['2:original', '3:original', '6:original']);
    await finish();
    expect(index.tracks()).toEqual([3, 6, 7]);
    expect(files.audio()).toHaveLength(3);
  });

  it('waits for the queue to settle before fetching', async () => {
    const files = new FakeFiles();
    const index = new MemoryIndex();
    const source = new FakeSource();
    const cache = new StreamingCache({
      index, files, network: new FakeNetwork(), source, downloaded: () => false,
      settings: { limitBytes: 1_000_000, wifiQuality: 'original', cellularQuality: 'high' },
    });
    cache.start();
    cache.setOnline(true);
    for (const current of [1, 2, 3, 4]) {
      cache.setOutlook(outlook('active', current, current + 1, current + 2));
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(source.describes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(source.describes).toEqual(['5:original', '6:original']);
    cache.dispose();
  });

  it('follows the network: the cellular quality on cellular, nothing with Data Saver there', async () => {
    const { cache, index, files, network, source, settle, finish } = setup();
    network.set('cellular');
    cache.setOutlook(outlook('active', 1, 2, 3));
    await settle();
    expect(source.describes).toEqual(['2:high']);
    expect(files.fetches[0]!.url).toContain('/aac_256');
    await finish();
    expect(index.tracks()).toEqual([2, 3]);
    expect(index.row(2, 'high')).toMatchObject({ file: 'file-1.aac', quality: 'high' });

    cache.setSettings({ cellularQuality: 'data_saver' });
    cache.setOutlook(outlook('active', 3, 4, 5));
    await settle();
    expect(files.active()).toEqual([]);

    // Back on Wi-Fi the lesser copies are replaced by the quality that streams there.
    network.set('wifi');
    await finish();
    expect(index.row(3)).toMatchObject({ quality: 'original' });
    expect(index.row(3, 'high')).toBeUndefined();
    expect(index.tracks()).toEqual([2, 3, 4, 5]);
  });

  it('keeps a replaced copy’s file until the player lets go of it', async () => {
    const { cache, index, files, changed, settle, finish } = setup({ seed: [row(2, { quality: 'high', playedAt: 50 })] });
    cache.setOutlook(outlook('active', 1, 2));
    await settle();
    await finish();
    expect(index.row(2)).toMatchObject({ quality: 'original', playedAt: 50 });
    expect(index.row(2, 'high')).toBeUndefined();
    expect(changed).toContain(2);
    // Track 2 follows the one playing: the player may have the old file preloaded.
    expect(files.disk.has('seed-2-high.flac')).toBe(true);
    cache.setOutlook(outlook('active', 5));
    await settle();
    expect(files.disk.has('seed-2-high.flac')).toBe(false);
  });

  it('does not fetch downloads, or anything while another device plays', async () => {
    const { cache, files, source, settle } = setup({ downloaded: trackId => trackId === id(2) });
    cache.setOutlook(outlook('active', 1, 2, 3));
    await settle();
    expect(source.describes).toEqual(['3:original', '1:original']);
    cache.setOutlook(outlook('remote', 1, 2, 3));
    await settle();
    expect(files.active()).toEqual([]);
  });

  it('fetches only while the server is reachable', async () => {
    const { cache, source, settle } = setup({ online: false });
    cache.setOutlook(outlook('active', 1, 2));
    await settle();
    expect(source.describes).toEqual([]);
    cache.setOnline(true);
    await settle();
    expect(source.describes).toEqual(['2:original', '1:original']);
  });

  it('reconciles with the folder at launch: purged files, strays and other accounts', () => {
    const files = new FakeFiles();
    new MemoryIndex('b').put([row(50)]);
    files.disk.set('seed-50-original.flac', 1000);
    files.disk.set('stray.flac', 77);
    files.disk.set('art-kept.webp', 10);
    files.disk.set('art-stray.webp', 10);
    const seed = [row(1, { art: 'art-kept.webp' }), row(2), row(3), row(4, { art: 'art-gone.webp' })];
    const { cache, index } = setup({ seed, files: Object.assign(files, {}) });
    // What `setup` put on disk for the seed is undone for two of them, as the system would.
    files.disk.delete('seed-2-original.flac');
    files.disk.set('seed-3-original.flac', 400);
    cache.dispose();
    const second = new StreamingCache({
      index, files, network: new FakeNetwork(), source: new FakeSource(), downloaded: () => false,
      settings: { limitBytes: 1_000_000, wifiQuality: 'original', cellularQuality: 'high' },
    });
    second.start();
    expect(index.tracks()).toEqual([1, 4]);
    expect(second.has(id(2))).toBe(false);
    expect(index.row(4)!.art).toBeNull();
    expect([...files.disk.keys()].sort()).toEqual(['art-kept.webp', 'seed-1-original.flac', 'seed-4-original.flac']);
    expect(MemoryIndex.accounts.has('b')).toBe(false);
    expect(second.summary()).toEqual({ usedBytes: 2000, count: 2 });
    expect(second.tracks().map(item => item.title)).toEqual(['Track 1', 'Track 4']);
  });

  it('forgets a file that vanished while the app ran, the moment it is asked for', async () => {
    const { cache, index, files, changed } = setup({ seed: [row(2)] });
    files.disk.delete('seed-2-original.flac');
    expect(cache.playback(id(2), 'original')).toBeNull();
    expect(cache.has(id(2))).toBe(false);
    expect(index.tracks()).toEqual([]);
    expect(changed).toEqual([2]);
  });

  it('asks about a cached file once a day, and fetches again one the server replaced', async () => {
    const { cache, index, files, source, changed, settle, finish } = setup({ seed: [row(2, { checkedAt: Date.now() - day - 1 }), row(3, { checkedAt: Date.now() - day - 1 })] });
    source.fileIds.set(id(3), id(999));
    cache.setOutlook(outlook('active', 1, 2, 3));
    await settle();
    // The same file: nothing is fetched for it, and it is good for another day.
    expect(index.row(2)).toMatchObject({ file: 'seed-2-original.flac', checkedAt: Date.now() });
    // A different file: the copy is forgotten and fetched like any other.
    expect(changed).toEqual([3]);
    await finish();
    expect(index.row(3)).toMatchObject({ fileId: id(999), file: expect.stringMatching(/^file-/) });
    expect(files.disk.has('seed-3-original.flac')).toBe(false);
    expect(source.describes.filter(item => item.startsWith('2:'))).toHaveLength(1);
  });

  it('tries a failed fetch again later, and leaves alone a track the server does not have', async () => {
    const { cache, index, files, source, settle, finish } = setup();
    source.missing.add(id(3));
    cache.setOutlook(outlook('active', 1, 2, 3));
    await settle();
    files.fetches[0]!.fail();
    await settle();
    expect(index.row(2)).toBeUndefined();
    const tries = () => source.describes.filter(item => item.startsWith('2:')).length;
    expect(tries()).toBe(1);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(tries()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tries()).toBe(2);
    await finish();
    expect(index.tracks()).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(source.describes.filter(item => item.startsWith('3:'))).toHaveLength(1);
  });

  it('gives up on a track after three failures, until it comes round again', async () => {
    const { cache, files, source, settle } = setup();
    cache.setOutlook(outlook('active', 1, 2));
    await settle();
    const tries = () => source.describes.filter(item => item.startsWith('2:')).length;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      files.active().find(fetch => fetch.url.includes(id(702)))!.fail();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(tries()).toBe(3);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(tries()).toBe(3);
    cache.setOutlook(outlook('active', 5, 6));
    await settle();
    cache.setOutlook(outlook('active', 1, 2));
    await settle();
    expect(tries()).toBe(4);
  });

  it('discards a file that arrived short', async () => {
    const { cache, index, files, settle } = setup();
    cache.setOutlook(outlook('active', 1, 2));
    await settle();
    files.fetches[0]!.complete(600, 1000);
    await settle();
    expect(index.row(2)).toBeUndefined();
    expect(files.disk.has('file-1.flac')).toBe(false);
  });

  it('does not fetch a file bigger than the room the limit leaves', async () => {
    const { cache, index, files, source, settle, finish } = setup({ settings: { limitBytes: 5000 } });
    source.bytes = 9000;
    cache.setOutlook(outlook('active', 1, 2, 3));
    await settle();
    // Each was asked about once, found too big, and not started.
    expect(source.describes).toEqual(['2:original', '3:original', '1:original']);
    expect(files.fetches).toEqual([]);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(source.describes).toHaveLength(3);
    await finish();
    expect(index.tracks()).toEqual([]);
  });

  it('lets go of a transcode that arrived bigger than its estimate and the room, and does not fetch it again', async () => {
    // A second at 256 kbps is guessed at 32,000 bytes. Once 2 holds 1000, the room left is 33,100.
    const { cache, index, files, source, settle } = setup({ settings: { limitBytes: 34_100, wifiQuality: 'high' } });
    const fetchOf = (n: number) => files.active().find(fetch => fetch.url.includes(id(700 + n)));
    cache.setOutlook(outlook('active', 1, 2, 3));
    await settle();
    fetchOf(2)!.complete(1000);
    await settle();
    const third = fetchOf(3)!;
    third.complete(34_000);
    await settle();
    expect(index.row(3, 'high')).toBeUndefined();
    expect(files.disk.has(third.name)).toBe(false);
    const asked = () => source.describes.filter(item => item.startsWith('3:')).length;
    const before = asked();
    const fetchesOfThird = () => files.fetches.filter(fetch => fetch.url.includes(id(703))).length;
    const fetched = fetchesOfThird();
    fetchOf(1)!.complete(1000);
    await settle();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(index.tracks()).toEqual([1, 2]);
    expect(asked()).toBe(before);
    expect(fetchesOfThird()).toBe(fetched);
  });

  it('keeps a cover that another track lets go of while its fetch is finishing', async () => {
    const cover = `art-${id(800)}.webp`;
    const { cache, index, files, source, settle } = setup({ seed: [row(5, { art: cover, bytes: 5000 })] });
    files.disk.set(cover, 10);
    cache.start();
    // Between finding the cover and writing the row (a few microtasks), the only other row using the cover goes.
    let dropped = false;
    source.track.mockImplementation(trackId => {
      const found = Promise.resolve(track(numberOf(trackId)));
      if (!dropped && trackId === id(2)) {
        dropped = true;
                void found.then(() => later(4, () => cache.setSettings({ limitBytes: 2000 })));
      }
      return found;
    });
    cache.setOutlook(outlook('active', 1, 2));
    await settle();
    files.active().find(fetch => fetch.url.includes(id(702)))!.complete();
    await settle();
    expect(index.row(5)).toBeUndefined();
    expect(index.row(2)).toMatchObject({ art: cover });
    expect(files.disk.has(cover)).toBe(true);
    expect(cache.artworkUri(id(800))).toBe(`file:///cache/${cover}`);
  });

  it('after Clear, stops its fetches and fetches nothing until the queue moves on', async () => {
    const { cache, index, files, source, settle, finish } = setup({ seed: [row(1)] });
    cache.setOutlook(outlook('active', 1, 2, 3));
    await settle();
    const running = files.active();
    expect(running).toHaveLength(2);
    cache.clear();
    expect(running.every(fetch => fetch.cancelled)).toBe(true);
    await finish();
    expect(index.tracks()).toEqual([]);
    const asked = source.describes.length;
    cache.setOutlook(outlook('active', 2, 3));
    await finish();
    expect(source.describes.length).toBeGreaterThan(asked);
    expect(index.tracks()).toEqual([2, 3]);
  });

  it('clears everything, sparing only the bytes the player holds until it lets go', async () => {
    const { cache, index, files, changed, settle } = setup({ seed: [row(1), row(2), row(7), row(8)], online: false });
    cache.setOutlook(outlook('active', 1, 2));
    await settle();
    changed.length = 0;
    cache.clear();
    expect(index.tracks()).toEqual([]);
    expect(cache.summary()).toEqual({ usedBytes: 0, count: 0 });
    expect(cache.has(id(1))).toBe(false);
    expect(changed.sort()).toEqual([1, 2, 7, 8]);
    expect(files.audio()).toEqual(['seed-1-original.flac', 'seed-2-original.flac']);
    cache.setOutlook(outlook('active', 9));
    await settle();
    expect(files.audio()).toEqual([]);
  });

  it('tells its readers when it changes, and what is in it', async () => {
    const { cache, finish } = setup();
    const listener = vi.fn();
    cache.subscribe(listener);
    const version = cache.getFilesVersion();
    const before = cache.summary();
    expect(cache.summary()).toBe(before);
    cache.setOutlook(outlook('idle', 1, 2));
    await finish();
    expect(listener).toHaveBeenCalled();
    expect(cache.getFilesVersion()).toBeGreaterThan(version);
    expect(cache.summary()).toEqual({ usedBytes: 2000, count: 2 });
  });
});
