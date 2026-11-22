import type { PlaybackDescriptor, QueueEntry, StreamQuality } from '@squirmy/contracts';

/** The places an entry can play from. */
export type PlaybackSources = {
  /** The file of a download, which the user chose to keep. */
  downloaded: (trackId: string) => PlaybackDescriptor | null;
  /** A cached file at least as good as `quality`. With `any`, a lesser one rather than none. */
  cached: (trackId: string, quality: StreamQuality, any?: boolean) => PlaybackDescriptor | null;
  /** `GET /tracks/:id/playback`. */
  server: (entry: QueueEntry, quality: StreamQuality) => Promise<PlaybackDescriptor>;
};

/**
 * Where an entry plays from: a download first, then the streaming cache, then the server.
 * A cached copy below the quality asked for is passed over while the server answers, so
 * the quality setting holds, and plays when it does not. Offline, a lesser copy is taken
 * at once rather than after asking the server, since a request to a server that can't be
 * reached may only fail after a long wait. With nothing on the phone the server is still
 * asked: "offline" means the socket has been down a few seconds (a network change, say),
 * and the stream itself may well be reachable.
 */
export async function resolvePlayback(
  entry: QueueEntry,
  quality: StreamQuality,
  sources: PlaybackSources,
  offline = false,
): Promise<PlaybackDescriptor> {
  const local = sources.downloaded(entry.trackId) ?? sources.cached(entry.trackId, quality, offline);
  if (local) return local;
  try {
    return await sources.server(entry, quality);
  } catch (error) {
    const lesser = sources.cached(entry.trackId, quality, true);
    if (lesser) return lesser;
    throw error;
  }
}
