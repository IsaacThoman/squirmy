import type { SessionClient } from '@squirmy/client-core';
import type { StreamingCache } from './manager';
import { nothingNear, outlookOf } from './model';

/**
 * Ties the cache to the playback session until the returned function is called: the cache
 * learns what plays next from every session change, and the client forgets where a track
 * plays from when its file arrives or goes, so the next load (and the preload, when it is
 * that track) uses the file.
 */
export function followSession(cache: StreamingCache, client: SessionClient): () => void {
  const look = () => {
    const { session, queue, isActiveDevice } = client.getSnapshot();
    cache.setOutlook(outlookOf({ ...session, ...queue }, isActiveDevice ? 'active' : session.activeDeviceId === null ? 'idle' : 'remote'));
  };
  look();
  const stopLooking = client.subscribe(look);
  const stopForgetting = cache.onFilesChanged(trackId => client.forgetPlayback(trackId));
  return () => {
    stopLooking();
    stopForgetting();
    cache.setOutlook(nothingNear);
  };
}
