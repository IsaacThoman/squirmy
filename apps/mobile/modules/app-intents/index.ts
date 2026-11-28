import { requireOptionalNativeModule, type EventSubscription } from 'expo';

/** What the widgets show and Siri suggests from, written whole into the App Group (`SurfaceSnapshot` in Swift). */
export type SurfaceSnapshot = {
  version: 1;
  signedIn: boolean;
  nowPlaying: SurfaceNowPlaying | null;
  recent: SurfaceItem[];
  updatedAt: number;
};

export type SurfaceNowPlaying = {
  title: string;
  artist?: string;
  album?: string;
  /** A cover's file name: a key of the `artwork` map passed with the snapshot. */
  artwork?: string;
  color?: string;
  playing: boolean;
  /** Where the song was at `anchorAt` (epoch milliseconds). */
  positionMs: number;
  anchorAt: number;
  durationMs: number;
  /** The other device playing, while this phone is a remote. */
  device?: string;
};

export type SurfaceItem = {
  /** `album:<id>`, `artist:<id>`, `playlist:<id>`, `liked`, `mix:<id>`, `radio:track:<id>` or `radio:artist:<id>`. */
  id: string;
  kind: 'album' | 'artist' | 'playlist' | 'liked' | 'mix' | 'radio';
  title: string;
  subtitle?: string;
  artwork?: string;
  color?: string;
  link: string;
};

/** Something Siri or Shortcuts can play, as `MusicEntity` in Swift. */
export type IntentItem = { id: string; kind: SurfaceItem['kind'] | 'track'; title: string; subtitle?: string; artworkUrl?: string };

export type IntentRequest = {
  id: string;
  action: string;
  payload: Record<string, unknown>;
};

export type DownloadActivityState = { title: string; detail: string; done: number; total: number; finished: boolean };

type AppIntentsModule = {
  /** The build has the widget extension and its App Group. */
  hasWidgets: boolean;
  setListening(listening: boolean): void;
  respond(id: string, result: Record<string, unknown> | null, error: string | null): void;
  /** `artwork` maps each cover's file name to the URL (or downloaded file) it comes from. */
  setSnapshot(snapshot: SurfaceSnapshot, artwork: Record<string, string>): Promise<void>;
  donate(item: IntentItem): Promise<void>;
  setDownloadActivity(state: DownloadActivityState | null): Promise<void>;
  addListener(event: 'onRequest', listener: (request: IntentRequest) => void): EventSubscription;
};

/** iOS only; `null` on the TV, other platforms, and in an app built before it was added. */
export default requireOptionalNativeModule<AppIntentsModule>('SquirmyAppIntents');
