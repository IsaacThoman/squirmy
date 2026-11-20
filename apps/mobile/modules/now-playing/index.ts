import { requireOptionalNativeModule, type EventSubscription } from 'expo';

export type RemoteCommand =
  | { command: 'play' | 'pause' | 'togglePlayPause' | 'next' | 'previous' }
  | { command: 'seek'; positionMs: number };

export type NowPlayingItem = {
  title: string;
  artist?: string;
  album?: string;
  /** Loaded by the system without headers. */
  artworkUrl?: string;
  durationMs: number;
};

type NowPlayingModule = {
  setItem(item: NowPlayingItem): Promise<void>;
  setPlayback(playing: boolean, positionMs: number): Promise<void>;
  clear(): Promise<void>;
  addListener(event: 'onRemoteCommand', listener: (command: RemoteCommand) => void): EventSubscription;
};

/** iOS only; `null` where there is no lock screen integration. */
export default requireOptionalNativeModule<NowPlayingModule>('SquirmyNowPlaying');
