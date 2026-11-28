import type { EngineStatus, PlayerEngine } from '@squirmy/client-core';
import NowPlaying, { type NowPlayingItem } from '../../../modules/now-playing';
import { noFavorite, sameFavorite, type FavoriteState } from './favorite';

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
  queueFor?: (entryId: string) => { index: number; count: number } | null;
  /**
   * The star (Apple Music's favorite), which is the heart. `favoriteFor` says how it shows
   * for an entry; a tap asks `onFavorite` for the other way, saved or not.
   */
  favoriteFor?: (entryId: string) => FavoriteState;
  onFavorite?: (entryId: string, saved: boolean) => void;
};

/**
 * Mirrors `engine` on the lock screen: the loaded entry's metadata from `itemFor`, and its
 * elapsed time and play state from every status. Returns `refresh`, for when an entry's
 * metadata arrives later, `refreshFavorite`, for when its heart changes, `hold`, which shows
 * an entry that is not loaded yet (the server is fetching it) as buffering at its start, and
 * `disconnect`, which clears the lock screen. Does nothing where there is no native module
 * (Android, web).
 */
export function connectNowPlaying(
  engine: PlayerEngine,
  itemFor: (entryId: string) => NowPlayingItem | null,
  controls: RemoteControls,
): {
  refresh: () => void; refreshFavorite: () => void; refreshQueue: () => void;
  setCarPlayConnected: (connected: boolean) => void; hold: (entryId: string | null) => void; disconnect: () => void;
} {
  const native = NowPlaying;
  if (!native) return {
    refresh: () => undefined, refreshFavorite: () => undefined, refreshQueue: () => undefined,
    setCarPlayConnected: () => undefined, hold: () => undefined, disconnect: () => undefined,
  };
  let shown: string | null = null;
  let held: string | null = null;
  let carPlayConnected = false;
  let queuePosition: { index: number; count: number } | null = null;
  const refreshQueue = () => {
    const next = carPlayConnected && shown ? controls.queueFor?.(shown) ?? null : null;
    if (next?.index === queuePosition?.index && next?.count === queuePosition?.count) return;
    queuePosition = next;
    void native.setQueuePosition?.(next?.index ?? null, next?.count ?? null);
  };
  // What the star shows, so a heart change sends only what changed.
  let favorite = noFavorite;

  const showFavorite = () => {
    const next = shown && controls.favoriteFor ? controls.favoriteFor(shown) : noFavorite;
    if (sameFavorite(next, favorite)) return;
    favorite = next;
    void native.setFavorite(next.available, next.active, next.label);
  };
  const hide = () => {
    if (shown) void native.clear();
    shown = null;
    queuePosition = null;
    // Clearing hides the star too.
    favorite = noFavorite;
  };

  const show = (engineStatus: EngineStatus, force = false) => {
    const status: EngineStatus = !engineStatus.entryId && held ? { entryId: held, state: 'loading', positionMs: 0 } : engineStatus;
    if (!status.entryId) return hide();
    if (force || status.entryId !== shown) {
      const item = itemFor(status.entryId);
      if (!item) return;
      shown = status.entryId;
      void native.setItem(item);
      showFavorite();
      refreshQueue();
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
      case 'favorite': {
        // Read again rather than trusting the star: a heart may have changed since it was drawn.
        const now = shown && controls.favoriteFor?.(shown);
        if (shown && now && now.available) controls.onFavorite?.(shown, !now.active);
        return;
      }
    }
  });
  const unsubscribe = engine.subscribe(event => {
    if (event.type === 'status') show(event.status);
  });
  show(engine.getStatus());

  return {
    refresh: () => show(engine.getStatus(), true),
    refreshFavorite: showFavorite,
    refreshQueue,
    setCarPlayConnected: connected => {
      if (connected === carPlayConnected) return;
      carPlayConnected = connected;
      void native.setCarPlayConnected?.(connected);
      refreshQueue();
    },
    hold: entryId => {
      if (entryId === held) return;
      held = entryId;
      show(engine.getStatus());
    },
    disconnect: () => {
      void native.setCarPlayConnected?.(false);
      commands.remove();
      unsubscribe();
      hide();
      held = null;
    },
  };
}
