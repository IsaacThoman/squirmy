import { ApiError } from '@squirmy/client-core';
import type { TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import {
  acquireOutcome, afterAcquire, canPlay, collectionDownload, downloadStatus, downloadSymbol, extensionFor, fetchRecheckDelay,
  maxFetchAsks, retryDelay, savedLimit, sizeMatches, songPage, unavailableReason, waitReason, withTrack, type CollectionRow, type DownloadRow,
  type DownloadState,
} from './model';

function track(id: string, availability: TrackSummary['availability'] = 'server'): TrackSummary {
  return {
    id, mbid: null, title: id, artistCredit: 'Artist', artists: [], durationMs: 1000, album: null, disc: 1, position: 1, availability,
    liked: false, explicit: null, hasLyrics: false,
  };
}

function row(id: string, state: DownloadState, availability: TrackSummary['availability'] = 'server', file: string | null = null): DownloadRow {
  return {
    trackId: id, albumId: null, state, quality: 'original', file, art: null, bytes: file ? 1000 : null, descriptor: null, track: track(id, availability),
    attempts: 0, retryAt: null, error: null, gone: false, addedAt: 0, doneAt: null, checkedAt: null,
  };
}

describe('songs the server does not have yet', () => {
  const collection = (trackIds: string[]): CollectionRow => ({
    id: 'playlist:p', kind: 'playlist', title: 'Mix', subtitle: '', artworks: [], album: null, playlist: null, trackIds, art: [], gone: false,
    addedAt: 0, syncedAt: 0,
  });
  const summed = (rows: DownloadRow[], trackIds = rows.map(item => item.trackId), wait: Parameters<typeof collectionDownload>[3] = null) =>
    collectionDownload(collection(trackIds), new Map(rows.map(item => [item.trackId, item])), new Map(), wait);

  it('reads the server’s answer to an acquire request', () => {
    expect(acquireOutcome({ jobs: [{ status: 'queued' }] })).toBe('requested');
    expect(acquireOutcome({ jobs: [{ status: 'failed' }, { status: 'downloading' }] })).toBe('requested');
    expect(acquireOutcome({ jobs: [{ status: 'completed' }] })).toBe('ready');
    expect(acquireOutcome({ jobs: [{ status: 'failed' }, { status: 'rejected' }] })).toBe('unavailable');
    expect(acquireOutcome({ error: new ApiError(409, 'already_available', '') })).toBe('ready');
    expect(acquireOutcome({ error: new ApiError(404, 'not_available', '') })).toBe('unavailable');
    expect(acquireOutcome({ error: new ApiError(403, 'acquire_not_allowed', '') })).toBe('unavailable');
    expect(acquireOutcome({ error: new ApiError(429, 'acquire_limit_reached', '') })).toBe('busy');
    expect(acquireOutcome({ error: new ApiError(500, 'internal', '') })).toBe('error');
    expect(acquireOutcome({ error: new Error('offline') })).toBe('error');
  });

  it('asks again later, and gives up after a while', () => {
    expect([1, 2, 3, 4, 5, 8].map(fetchRecheckDelay)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    const fetching = row('a', 'fetching', 'on_demand');
    expect(afterAcquire(fetching, 'requested', 10)).toMatchObject({ state: 'fetching', attempts: 1, retryAt: 60_010 });
    expect(afterAcquire(fetching, 'error', 10)).toMatchObject({ state: 'fetching', attempts: 1, retryAt: 15_010 });
    expect(afterAcquire(fetching, 'ready', 10)).toMatchObject({ state: 'queued', attempts: 0, retryAt: null });
    expect(afterAcquire(fetching, 'unavailable', 10)).toMatchObject({ state: 'unavailable', error: 'Not available' });
    expect(afterAcquire({ ...fetching, attempts: maxFetchAsks - 1 }, 'requested', 10)).toMatchObject({ state: 'unavailable' });
  });

  it('moves a row on by what the server now says of its song', () => {
    expect(withTrack(row('a', 'fetching', 'on_demand'), track('a', 'server'), true).state).toBe('queued');
    expect(withTrack(row('a', 'fetching', 'on_demand'), track('a', 'none'), true).state).toBe('unavailable');
    expect(withTrack(row('a', 'fetching', 'on_demand'), track('a', 'on_demand'), false).state).toBe('unavailable');
    expect(withTrack(row('a', 'unavailable', 'on_demand'), track('a', 'server'), true).state).toBe('queued');
    // Given up on, it stays so until a retry: the server may still be failing to get it.
    expect(withTrack(row('a', 'unavailable', 'on_demand'), track('a', 'on_demand'), true).state).toBe('unavailable');
    expect(withTrack(row('a', 'queued'), track('a', 'on_demand'), true).state).toBe('fetching');
    expect(withTrack(row('a', 'queued'), track('a', 'on_demand'), false).state).toBe('queued');
    expect(withTrack(row('a', 'done', 'server', 'a.flac'), track('a', 'on_demand'), true).state).toBe('done');
    const same = row('a', 'fetching', 'on_demand');
    expect(withTrack(same, track('a', 'on_demand'), true)).toBe(same);
  });

  it('says "Downloaded" only when every song of the collection is on the device', () => {
    const done = (id: string) => row(id, 'done', 'server', `${id}.flac`);
    expect(downloadStatus(summed([done('a'), row('b', 'downloading'), row('c', 'fetching', 'on_demand')])).text).toBe('Downloading 2 of 3');
    expect(downloadStatus(summed([done('a'), done('b'), row('c', 'fetching', 'on_demand')])).text).toBe('Downloading 3 of 3');
    expect(downloadStatus(summed([done('a'), done('b'), row('c', 'fetching', 'on_demand')], undefined, 'offline')).text)
      .toBe('Waiting for the server');
    expect(downloadStatus(summed([done('a'), done('b'), row('c', 'unavailable', 'on_demand')]))).toEqual({
      icon: 'exclamationmark.circle', text: '2 of 3 downloaded · 1 not available', retry: true,
    });
    // A song with no row is one the server has no file of and would not get for this user.
    expect(downloadStatus(summed([done('a'), done('b')], ['a', 'b', 'c'])).text).toBe('2 of 3 downloaded · 1 not available');
    expect(downloadStatus(summed([done('a'), row('b', 'failed')], ['a', 'b', 'c'])))
      .toMatchObject({ text: '1 song couldn’t be downloaded · 1 not available', retry: true });
    expect(downloadStatus(summed([done('a'), done('b')])).text).toBe('Downloaded · 2.0 KB');
  });
});

describe('download rules', () => {
  it('waits longer after each failure, up to 15 minutes', () => {
    expect([1, 2, 3, 4, 10].map(retryDelay)).toEqual([15_000, 30_000, 60_000, 120_000, 15 * 60_000]);
  });

  it('explains why nothing downloads', () => {
    const base = { online: true, network: 'wifi' as const, wifiOnly: true, usedBytes: 0, capBytes: null };
    expect(waitReason(base)).toBeNull();
    expect(waitReason({ ...base, online: false })).toBe('offline');
    expect(waitReason({ ...base, network: 'none' })).toBe('offline');
    expect(waitReason({ ...base, network: 'cellular' })).toBe('wifi');
    expect(waitReason({ ...base, network: 'cellular', wifiOnly: false })).toBeNull();
    expect(waitReason({ ...base, network: 'other' })).toBeNull();
    expect(waitReason({ ...base, usedBytes: 10, capBytes: 10 })).toBe('storage');
  });

  it('accepts a file only at the size the server announced', () => {
    expect(sizeMatches(1000, [1000, 1000])).toBe(true);
    expect(sizeMatches(1000, [-1, null])).toBe(true);
    expect(sizeMatches(999, [1000, null])).toBe(false);
    expect(sizeMatches(0, [-1])).toBe(false);
    expect(sizeMatches(null, [])).toBe(false);
  });

  it('names files so AVPlayer recognises them', () => {
    expect(extensionFor({ mime: 'audio/flac', codec: 'flac', transcoded: false })).toBe('flac');
    expect(extensionFor({ mime: 'audio/mp4', codec: 'alac', transcoded: false })).toBe('m4a');
    expect(extensionFor({ mime: 'audio/aac', codec: 'aac', transcoded: true })).toBe('aac');
    expect(extensionFor({ mime: 'audio/mpeg', codec: 'mp3', transcoded: true })).toBe('mp3');
    expect(extensionFor({ mime: 'application/octet-stream', codec: 'wav', transcoded: false })).toBe('wav');
  });

  const admin = { role: 'admin', canAcquire: false } as const;
  const requester = { role: 'member', canAcquire: true } as const;
  const listener = { role: 'member', canAcquire: false } as const;

  it('plays only what is on the phone offline, and what the server has or fetches online', () => {
    const onDevice = (id: string) => id === 'here';
    const online = { offline: false, onDevice, viewer: requester };
    expect(canPlay({ id: 'here', availability: 'none' }, { ...online, offline: true })).toBe(true);
    expect(canPlay({ id: 'there', availability: 'server' }, { ...online, offline: true })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'server' }, online)).toBe(true);
    expect(canPlay({ id: 'there', availability: 'on_demand' }, online)).toBe(true);
    expect(canPlay({ id: 'there', availability: 'on_demand' }, { ...online, viewer: admin })).toBe(true);
    expect(canPlay({ id: 'there', availability: 'none' }, online)).toBe(false);
  });

  it('plays on-demand tracks only for those who may have them fetched', () => {
    const onDevice = () => false;
    expect(canPlay({ id: 'there', availability: 'on_demand' }, { offline: false, onDevice, viewer: listener })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'on_demand' }, { offline: false, onDevice, viewer: null })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'server' }, { offline: false, onDevice, viewer: listener })).toBe(true);
  });

  it('never plays an explicit song for a viewer who has explicit content off, not even a download', () => {
    const onDevice = (id: string) => id === 'here';
    const off = { ...listener, allowsExplicit: false };
    expect(canPlay({ id: 'here', availability: 'server', explicit: true }, { offline: true, onDevice, viewer: off })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'server', explicit: true }, { offline: false, onDevice, viewer: off })).toBe(false);
    expect(canPlay({ id: 'there', availability: 'server', explicit: false }, { offline: false, onDevice, viewer: off })).toBe(true);
    expect(canPlay({ id: 'there', availability: 'server', explicit: true }, { offline: false, onDevice, viewer: listener })).toBe(true);
    expect(unavailableReason({ availability: 'server', explicit: true }, false, off)).toBe('Explicit content is off');
    expect(unavailableReason({ availability: 'server', explicit: true }, true, off)).toBe('Explicit content is off');
  });

  it('says only "Not available" or, offline, "Not downloaded"', () => {
    expect(unavailableReason({ availability: 'on_demand' }, false, listener)).toBe('Not available');
    expect(unavailableReason({ availability: 'none' }, false, requester)).toBe('Not available');
    expect(unavailableReason({ availability: 'server' }, true, listener)).toBe('Not downloaded');
    expect(unavailableReason({ availability: 'on_demand' }, true, requester)).toBe('Not downloaded');
    // Offline or not, what would not play with a connection either is simply not available.
    expect(unavailableReason({ availability: 'on_demand' }, true, listener)).toBe('Not available');
    expect(unavailableReason({ availability: 'none' }, true, requester)).toBe('Not available');
  });

  it('marks downloads only, never where a streamed file comes from', () => {
    expect(downloadSymbol(undefined)).toBeNull();
    expect(downloadSymbol({ state: 'done', bytes: 1, gone: false })).toBe('arrow.down.circle.fill');
    expect(downloadSymbol({ state: 'queued', wait: null })).toBe('arrow.down.circle.dotted');
  });

  it('reads a limit saved in 1000s as the same choice in 1024s', () => {
    expect(savedLimit(5 * 1000 ** 3)).toBe(5 * 1024 ** 3);
    expect(savedLimit(5 * 1024 ** 3)).toBe(5 * 1024 ** 3);
    expect(savedLimit(null)).toBeNull();
    expect(savedLimit(undefined)).toBeUndefined();
    expect(savedLimit(0)).toBe(0);
    expect(savedLimit(123_456)).toBe(123_456);
  });
});

describe('songPage', () => {
  const artist = { id: 'artist-1', name: 'Artist' };
  it('opens the album, or the first artist when the song has none', () => {
    expect(songPage({ album: { id: 'album-1', title: 'Album', artwork: null }, artists: [artist] })).toEqual({ page: 'album', id: 'album-1' });
    expect(songPage({ album: null, artists: [artist] })).toEqual({ page: 'artist', id: 'artist-1' });
    expect(songPage({ album: null, artists: [] })).toBeNull();
  });
});
