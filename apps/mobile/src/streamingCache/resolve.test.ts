import type { PlaybackDescriptor, QueueEntry } from '@squirmy/contracts';
import { describe, expect, it, vi } from 'vitest';
import { resolvePlayback, type PlaybackSources } from './resolve';

const entry: QueueEntry = { id: 'c1.0', trackId: '00000000-0000-4000-8000-000000000001', albumId: null, durationMs: 1000, state: 'ready' };

function descriptor(url: string): PlaybackDescriptor {
  return {
    trackId: entry.trackId, albumId: null, fileId: '00000000-0000-4000-8000-000000000701', url, expiresAt: '2100-01-01T00:00:00.000Z',
    profile: 'original', transcoded: false, mime: 'audio/flac', codec: 'flac', lossless: true, bitrate: null, sampleRate: 44100,
    bitDepth: 16, durationMs: 1000, bytes: 1000, normalization: null,
  };
}

function sources(has: { download?: boolean; cache?: boolean; lesser?: boolean; server?: boolean }) {
  return {
    downloaded: vi.fn(() => has.download ? descriptor('file:///downloads/a.flac') : null),
    cached: vi.fn((_trackId: string, _quality: string, any?: boolean) => has.cache || (any && has.lesser) ? descriptor('file:///cache/a.flac') : null),
    server: vi.fn(async () => {
      if (!has.server) throw new Error('unreachable');
      return descriptor('/api/v1/stream/a?sig=x');
    }),
  } satisfies PlaybackSources;
}

describe('where an entry plays from', () => {
  it('is a download before the cache, and the cache before the server', async () => {
    const all = sources({ download: true, cache: true, server: true });
    expect((await resolvePlayback(entry, 'original', all)).url).toBe('file:///downloads/a.flac');
    expect(all.cached).not.toHaveBeenCalled();
    expect(all.server).not.toHaveBeenCalled();

    const cached = sources({ cache: true, server: true });
    expect((await resolvePlayback(entry, 'high', cached)).url).toBe('file:///cache/a.flac');
    expect(cached.cached).toHaveBeenCalledWith(entry.trackId, 'high', false);
    expect(cached.server).not.toHaveBeenCalled();

    const neither = sources({ server: true });
    expect((await resolvePlayback(entry, 'high', neither)).url).toBe('/api/v1/stream/a?sig=x');
    expect(neither.server).toHaveBeenCalledWith(entry, 'high');
  });

  it('streams rather than play a cached copy below the quality asked for', async () => {
    const lesser = sources({ lesser: true, server: true });
    expect((await resolvePlayback(entry, 'original', lesser)).url).toBe('/api/v1/stream/a?sig=x');
  });

  it('plays a lesser cached copy when the server cannot be asked, and fails when there is none', async () => {
    expect((await resolvePlayback(entry, 'original', sources({ lesser: true }))).url).toBe('file:///cache/a.flac');
    await expect(resolvePlayback(entry, 'original', sources({}))).rejects.toThrow('unreachable');
  });

  it('offline, plays a lesser cached copy without asking the server', async () => {
    const offline = sources({ lesser: true, server: true });
    expect((await resolvePlayback(entry, 'original', offline, true)).url).toBe('file:///cache/a.flac');
    expect(offline.server).not.toHaveBeenCalled();
  });

  it('offline, still asks the server when nothing is on the phone', async () => {
    const nothing = sources({ server: true });
    expect((await resolvePlayback(entry, 'original', nothing, true)).url).toBe('/api/v1/stream/a?sig=x');
    expect(nothing.cached).toHaveBeenCalledWith(entry.trackId, 'original', true);
  });
});
