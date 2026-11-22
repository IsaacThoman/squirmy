import type { EngineStatus, PlayerEngine } from '@squirmy/client-core';
import NowPlaying, { type NowPlayingItem } from '../../../modules/now-playing';

export type { NowPlayingItem };

/**
 * What the lock screen and Control Center buttons ask for. The caller maps each one to a
 * session command; nothing here touches the engine.
 */
export type RemoteControls = {
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (positionMs: number) => void;
};

/**
 * Mirrors `engine` on the lock screen: the loaded entry's metadata from `itemFor`, and its
 * elapsed time and play state from every status. Returns `refresh`, for when an entry's
 * metadata arrives later, `hold`, which shows an entry that is not loaded yet (the server
 * is fetching it) as buffering at its start, and `disconnect`, which clears the lock
 * screen. Does nothing where there is no native module (Android, web).
 */
export function connectNowPlaying(
  engine: PlayerEngine,
  itemFor: (entryId: string) => NowPlayingItem | null,
  controls: RemoteControls,
): { refresh: () => void; hold: (entryId: string | null) => void; disconnect: () => void } {
  const native = NowPlaying;
  if (!native) return { refresh: () => undefined, hold: () => undefined, disconnect: () => undefined };
  let shown: string | null = null;
  let held: string | null = null;

  const show = (engineStatus: EngineStatus, force = false) => {
    const status: EngineStatus = !engineStatus.entryId && held ? { entryId: held, state: 'loading', positionMs: 0 } : engineStatus;
    if (!status.entryId) {
      if (shown) void native.clear();
      shown = null;
      return;
    }
    if (force || status.entryId !== shown) {
      const item = itemFor(status.entryId);
      if (!item) return;
      shown = status.entryId;
      void native.setItem(item);
    }
    // While buffering the clock stands still, so the lock screen should not run ahead.
    void native.setPlayback(status.state === 'playing', status.positionMs);
  };

  const commands = native.addListener('onRemoteCommand', remote => {
    switch (remote.command) {
      case 'play': return controls.onPlay();
      case 'pause': return controls.onPause();
      case 'togglePlayPause': {
        const { state } = engine.getStatus();
        return held || state === 'playing' || state === 'buffering' || state === 'loading' ? controls.onPause() : controls.onPlay();
      }
      case 'next': return controls.onNext();
      case 'previous': return controls.onPrevious();
      case 'seek': return controls.onSeek(remote.positionMs);
    }
  });
  const unsubscribe = engine.subscribe(event => {
    if (event.type === 'status') show(event.status);
  });
  show(engine.getStatus());

  return {
    refresh: () => show(engine.getStatus(), true),
    hold: entryId => {
      if (entryId === held) return;
      held = entryId;
      show(engine.getStatus());
    },
    disconnect: () => {
      commands.remove();
      unsubscribe();
      if (shown) void native.clear();
      shown = null;
      held = null;
    },
  };
}
