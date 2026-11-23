import { createInitialSession, reduceSession, type Session } from '@squirmy/client-core';
import type { QueueSeed, SessionCommand, StreamQuality } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import {
  clearCacheMessage, estimateBytes, evictions, inUse, limitOptions, defaultLimitBytes, minFreeBytes, outlookOf, pick, plan, policyFor, reconcile,
  sameOutlook, type CacheRow, type Near, type Outlook, type PlanInput,
} from './model';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const numberOf = (trackId: string) => Number(trackId.slice(-12));
const day = 24 * 3600_000;
const now = 10 * day;

function row(n: number, values: Partial<CacheRow> = {}): CacheRow {
  return {
    trackId: id(n), albumId: null, quality: 'original', file: `file-${n}.flac`, fileId: id(700 + n), bytes: 1000, art: null,
    descriptor: {
      trackId: id(n), albumId: null, fileId: id(700 + n), profile: 'original', transcoded: false, mime: 'audio/flac', codec: 'flac',
      lossless: true, bitrate: null, sampleRate: 44100, bitDepth: 16, durationMs: 1000, bytes: 1000, normalization: null,
    },
    track: null, addedAt: now, playedAt: null, checkedAt: now, ...values,
  };
}

const entry = (n: number, state: Near['state'] = 'ready'): Near => ({ trackId: id(n), albumId: null, durationMs: 1000, state });

function outlook(role: Outlook['role'], current: number | Near | null, ...upcoming: (number | Near)[]): Outlook {
  const near = (value: number | Near) => typeof value === 'number' ? entry(value) : value;
  return { role, current: current === null ? null : near(current), upcoming: upcoming.map(near) };
}

function input(values: Partial<PlanInput> & { rows?: CacheRow[] } = {}): PlanInput {
  const { rows = [], ...rest } = values;
  return {
    outlook: outlook('active', 1, 2, 3, 4), network: 'wifi', online: true, quality: 'original', cellularQuality: 'high',
    limitBytes: 1_000_000, freeBytes: 10 * minFreeBytes, now,
    copies: trackId => rows.filter(item => item.trackId === trackId),
    downloaded: () => false, running: new Map(), size: () => undefined, retryAt: () => undefined, ...rest,
  };
}

const started = (result: ReturnType<typeof plan>) => result.start.map(target => numberOf(target.trackId));
const kept = (result: ReturnType<typeof plan>) => [...result.keep].map(numberOf).sort((a, b) => a - b);

describe('streaming cache rules', () => {
  it('offers Off and four sizes, 2 GB unless chosen otherwise', () => {
    expect(limitOptions.map(option => option.label)).toEqual(['Off', '1 GB', '2 GB', '5 GB', '10 GB']);
    expect(limitOptions.find(option => option.value === defaultLimitBytes)?.label).toBe('2 GB');
  });

  it('plays the asked quality or a better copy, and a lesser one only when told to', () => {
    const high = row(1, { quality: 'high' });
    const original = row(1, { quality: 'original' });
    expect(pick([high, original], 'high')).toBe(high);
    expect(pick([original], 'data_saver')).toBe(original);
    expect(pick([high], 'original')).toBeUndefined();
    expect(pick([high, row(1, { quality: 'data_saver' })], 'original', true)).toBe(high);
    expect(pick([], 'high', true)).toBeUndefined();
  });

  it('guesses a size from the quality until the server says it', () => {
    expect(estimateBytes('high', 240_000)).toBe(7_680_000);
    expect(estimateBytes('original', 240_000)).toBeGreaterThan(estimateBytes('high', 240_000));
    expect(estimateBytes('data_saver', 0)).toBe(0);
  });

  it('evicts the least recently played first, and only as much as it must', () => {
    const rows = [row(1, { playedAt: 300 }), row(2, { playedAt: 100 }), row(3, { playedAt: 200 }), row(4, { addedAt: 50 })];
    expect(evictions(rows, 4000, new Set()).map(item => numberOf(item.trackId))).toEqual([]);
    // Track 4 was fetched ahead and never played: it ages from when it arrived.
    expect(evictions(rows, 2500, new Set()).map(item => numberOf(item.trackId))).toEqual([4, 2]);
    expect(evictions(rows, 0, new Set()).map(item => numberOf(item.trackId))).toEqual([4, 2, 3, 1]);
  });

  it('never evicts a track that is kept, even when that leaves it over the limit', () => {
    const rows = [row(1, { playedAt: 100 }), row(2, { playedAt: 200 }), row(3, { playedAt: 300 })];
    expect(evictions(rows, 1000, new Set([id(1), id(2)])).map(item => numberOf(item.trackId))).toEqual([3]);
  });

  it('forgets rows whose file the system removed or cut short, and files no row names', () => {
    const rows = [row(1), row(2), row(3), row(4, { art: 'art-a.webp' }), row(5, { art: 'art-b.webp' })];
    const files = new Map([['file-1.flac', 1000], ['file-3.flac', 400], ['file-4.flac', 1000], ['file-5.flac', 1000], ['art-b.webp', 10], ['stray.flac', 5]]);
    const referenced = new Set(['file-1.flac', 'file-2.flac', 'file-3.flac', 'file-4.flac', 'file-5.flac', 'art-a.webp', 'art-b.webp']);
    const result = reconcile(rows, files, referenced);
    expect(result.orphans).toEqual(['stray.flac']);
    expect(result.lost.map(item => numberOf(item.trackId))).toEqual([2, 3]);
    expect(result.updates).toEqual([{ ...rows[3], art: null }]);
  });

  it('knows which files the player may hold', () => {
    expect([...inUse(outlook('active', 1, 2, 3))].map(numberOf)).toEqual([1, 2]);
    expect([...inUse(outlook('idle', 1, 2))].map(numberOf)).toEqual([1, 2]);
    expect([...inUse(outlook('remote', 1, 2))]).toEqual([]);
  });

  it('fills on Wi-Fi, more carefully on cellular, and not at all there with Data Saver', () => {
    expect(policyFor('wifi', 'high')).toEqual({ ahead: 2, current: true, concurrency: 2 });
    expect(policyFor('other', 'data_saver')).toEqual({ ahead: 2, current: true, concurrency: 2 });
    expect(policyFor('cellular', 'high')).toEqual({ ahead: 2, current: false, concurrency: 1 });
    expect(policyFor('cellular', 'data_saver').ahead).toBe(0);
    expect(policyFor('none', 'original').concurrency).toBe(0);
  });
});

describe('outlook', () => {
  const seeds = (...ns: number[]): QueueSeed[] => ns.map(n => ({ trackId: id(n), albumId: null, durationMs: 1000 }));
  const run = (session: Session, command: SessionCommand, commandId: string) => reduceSession(session, { command, now: 1000, commandId, deviceId: 'phone' });
  const playing = (...ns: number[]) => run(createInitialSession(), { type: 'playTracks', tracks: seeds(...ns), seed: 1 }, 'c1');
  const numbers = (value: Outlook) => ({ current: value.current && numberOf(value.current.trackId), upcoming: value.upcoming.map(item => numberOf(item.trackId)) });

  it('reads the entries that follow, in play order', () => {
    expect(numbers(outlookOf(playing(1, 2, 3, 4, 5, 6, 7, 8), 'active'))).toEqual({ current: 1, upcoming: [2, 3, 4, 5, 6] });
    expect(numbers(outlookOf(playing(1, 2), 'active'))).toEqual({ current: 1, upcoming: [2] });
    expect(numbers(outlookOf(createInitialSession(), 'idle'))).toEqual({ current: null, upcoming: [] });
  });

  it('follows repeat, autoplay and entries still being prepared as playback will', () => {
    const one = run(playing(1, 2), { type: 'setRepeat', value: 'one' }, 'c2');
    expect(new Set(numbers(outlookOf(one, 'active')).upcoming)).toEqual(new Set([1]));
    const all = run(playing(1, 2), { type: 'setRepeat', value: 'all' }, 'c3');
    expect(numbers(outlookOf(all, 'active')).upcoming.slice(0, 3)).toEqual([2, 1, 2]);
    const suggested = reduceSession(playing(1), { command: { type: 'setAutoplayQueue', tracks: seeds(8, 9) }, now: 1000, commandId: 's1' });
    expect(numbers(outlookOf(suggested, 'active')).upcoming).toEqual([8, 9]);
    expect(numbers(outlookOf(run(suggested, { type: 'setAutoplay', value: false }, 'c4'), 'active')).upcoming).toEqual([]);
    const preparing = run(createInitialSession(), { type: 'playTracks', tracks: [seeds(1)[0]!, { ...seeds(2)[0]!, state: 'preparing' }, seeds(3)[0]!], seed: 1 }, 'c5');
    expect(outlookOf(preparing, 'active').upcoming.map(item => item.state)).toEqual(['preparing', 'ready']);
  });

  it('is the same while the same tracks are near in the same states', () => {
    const base = outlook('active', 1, 2, 3);
    expect(sameOutlook(base, outlook('active', 1, 2, 3))).toBe(true);
    expect(sameOutlook(base, outlook('idle', 1, 2, 3))).toBe(false);
    expect(sameOutlook(base, outlook('active', 1, 3, 2))).toBe(false);
    expect(sameOutlook(base, outlook('active', 1, 2))).toBe(false);
    expect(sameOutlook(base, outlook('active', 1, entry(2, 'preparing'), 3))).toBe(false);
  });
});

describe('prefetch plan', () => {
  it('fetches the next two entries first, two at a time, then the stream being played', () => {
    const first = plan(input());
    expect(started(first)).toEqual([2, 3]);
    expect(first.start.every(target => target.quality === 'original' && !target.check)).toBe(true);
    expect(first.cancel).toEqual([]);
    const second = plan(input({ rows: [row(2)], running: new Map([[id(3), 'original' as StreamQuality]]) }));
    expect(started(second)).toEqual([1]);
    expect(started(plan(input({ rows: [row(1), row(2), row(3)] })))).toEqual([]);
  });

  it('waits for entries the server is still preparing, and looks past them', () => {
    expect(started(plan(input({ outlook: outlook('active', 1, entry(2, 'preparing'), 3, entry(4, 'failed'), 5) })))).toEqual([3, 5]);
    expect(started(plan(input({ outlook: outlook('active', entry(1, 'preparing'), 2) })))).toEqual([2]);
  });

  it('leaves downloads and tracks already cached well enough alone', () => {
    expect(started(plan(input({ downloaded: trackId => trackId === id(2) })))).toEqual([3, 1]);
    expect(started(plan(input({ rows: [row(2), row(3, { quality: 'high' })] })))).toEqual([3, 1]);
    // On cellular a better copy from Wi-Fi is good enough.
    expect(started(plan(input({ network: 'cellular', quality: 'high', rows: [row(2)] })))).toEqual([3]);
  });

  it('fetches ahead on cellular at the cellular quality, one at a time, and never the stream being played', () => {
    const first = plan(input({ network: 'cellular', quality: 'high' }));
    expect(first.start).toEqual([{ trackId: id(2), albumId: null, quality: 'high', check: false }]);
    const later = plan(input({ network: 'cellular', quality: 'high', rows: [row(2, { quality: 'high' }), row(3, { quality: 'high' })] }));
    expect(started(later)).toEqual([]);
  });

  it('fetches nothing on cellular with Data Saver, with no network, offline, or with the device nearly full', () => {
    expect(started(plan(input({ network: 'cellular', quality: 'data_saver', cellularQuality: 'data_saver' })))).toEqual([]);
    expect(started(plan(input({ network: 'none' })))).toEqual([]);
    expect(started(plan(input({ online: false })))).toEqual([]);
    expect(started(plan(input({ freeBytes: minFreeBytes - 1 })))).toEqual([]);
  });

  it('with nothing playing, starts with the entry that play would start', () => {
    expect(started(plan(input({ outlook: outlook('idle', 1, 2, 3) })))).toEqual([1, 2]);
    expect(started(plan(input({ outlook: outlook('idle', 1, 2, 3), network: 'cellular', quality: 'high' })))).toEqual([1]);
  });

  it('fetches nothing while another device plays, and stops what it was fetching', () => {
    const running = new Map([[id(2), 'original' as StreamQuality]]);
    expect(plan(input({ outlook: outlook('remote', 1, 2, 3), running, rows: [row(1)] }))).toEqual({ start: [], cancel: [id(2)], keep: new Set() });
  });

  it('cancels fetches the queue moved away from, or whose quality the network no longer wants', () => {
    const running = new Map<string, StreamQuality>([[id(2), 'original'], [id(9), 'original']]);
    const moved = plan(input({ running }));
    expect(moved.cancel).toEqual([id(9)]);
    expect(started(moved)).toEqual([3]);
    const cellular = plan(input({ network: 'cellular', quality: 'high', running: new Map([[id(2), 'original' as StreamQuality]]) }));
    expect(cellular.cancel).toEqual([id(2)]);
    expect(cellular.start).toEqual([{ trackId: id(2), albumId: null, quality: 'high', check: false }]);
    // Losing the connection is not a reason to stop: the fetch fails or finishes by itself.
    expect(plan(input({ online: false, running: new Map([[id(2), 'original' as StreamQuality]]) })).cancel).toEqual([]);
  });

  it('keeps what plays, what follows and what it fetched for later, and nothing else', () => {
    const rows = [row(1), row(2), row(3), row(5), row(9)];
    expect(kept(plan(input({ rows, outlook: outlook('active', 1, 2, 3, 4, 5) })))).toEqual([1, 2, 3, 5]);
    // Off: the player may still hold the two files it has.
    expect(kept(plan(input({ rows, limitBytes: 0 })))).toEqual([1, 2]);
    expect(started(plan(input({ rows: [], limitBytes: 0 })))).toEqual([]);
  });

  it('fetches a track only when it fits the limit beside what is nearer', () => {
    // 1000 bytes each at this length and quality.
    const tight = { limitBytes: 2500, size: () => 1000 };
    expect(started(plan(input(tight)))).toEqual([2, 3]);
    expect(started(plan(input({ ...tight, rows: [row(2), row(3)] })))).toEqual([]);
    expect(kept(plan(input({ ...tight, rows: [row(2), row(3)] })))).toEqual([1, 2, 3]);
    // A file known to be too big is skipped; a smaller one further on still fits.
    expect(started(plan(input({ limitBytes: 2500, size: trackId => trackId === id(2) ? 5000 : 1000 })))).toEqual([3, 1]);
    // A fetch in flight is stopped once its real size turns out not to fit.
    const running = new Map([[id(2), 'original' as StreamQuality]]);
    expect(plan(input({ limitBytes: 2500, running, size: trackId => trackId === id(2) ? 5000 : 1000 })).cancel).toEqual([id(2)]);
  });

  it('asks the server once a day whether a cached file near the front is still the one it serves', () => {
    const rows = [row(2, { quality: 'original', checkedAt: now - day - 1 }), row(3, { checkedAt: now - day + 1000 })];
    const result = plan(input({ rows, network: 'cellular', quality: 'high' }));
    expect(result.start).toEqual([{ trackId: id(2), albumId: null, quality: 'original', check: true }]);
    expect(kept(result)).toEqual([1, 2, 3]);
  });

  it('asks about a cached file for the album it was fetched for, not the album the entry is on now', () => {
    const rows = [row(2, { albumId: id(900), checkedAt: now - day - 1 })];
    const result = plan(input({ rows, outlook: outlook('active', 1, { ...entry(2), albumId: id(901) }) }));
    expect(result.start.find(target => target.check)).toEqual({ trackId: id(2), albumId: id(900), quality: 'original', check: true });
  });

  it('holds back a track whose last fetch failed until it may be tried again', () => {
    expect(started(plan(input({ retryAt: trackId => trackId === id(2) ? now + 1 : undefined })))).toEqual([3, 1]);
    expect(started(plan(input({ retryAt: trackId => trackId === id(2) ? now : undefined })))).toEqual([2, 3]);
  });
});

describe('clearCacheMessage', () => {
  it('says how much goes and that it stops playing offline', () => {
    expect(clearCacheMessage({ count: 21, usedBytes: 233 * 1024 * 1024 }, 'iPhone')).toMatch(/^The 21 songs \(.+\) kept from streaming will be removed from this iPhone and won’t play without a connection/);
    expect(clearCacheMessage({ count: 1, usedBytes: 1 }, 'phone')).toMatch(/^The 1 song \(/);
  });
});
