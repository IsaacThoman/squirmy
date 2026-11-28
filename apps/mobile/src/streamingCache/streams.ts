import NativeAudio from '../../modules/audio-engine';
import type { EngineStreams, StreamReport } from './manager';

/**
 * The native engine's streams for the cache (`EngineStreams`), or null when this build has no
 * native engine. Only for when it is the engine that plays.
 */
export function engineStreams(): EngineStreams | null {
  const native = NativeAudio;
  if (!native) return null;
  return {
    prefetch: (key, url) => native.prefetch(key, url),
    cancelPrefetch: key => native.cancelPrefetch(key),
    subscribe: (listener: (report: StreamReport) => void) => {
      const complete = native.addListener('cacheComplete', ({ cacheKey, uri, bytes }) => listener({ key: cacheKey, uri, bytes }));
      const dropped = native.addListener('cacheDropped', ({ cacheKey, message }) => listener({ key: cacheKey, uri: null, message }));
      return () => {
        complete.remove();
        dropped.remove();
      };
    },
  };
}
