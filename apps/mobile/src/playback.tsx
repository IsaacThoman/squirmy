import {
  artworkUrl, createInitialSession, randomSeed, SessionClient, splitSession, type SessionClientSnapshot,
} from '@squirmy/client-core';
import { createSocketTransport } from '@squirmy/client-core/socket';
import type {
  ClientDevice, DeviceInfo, PlaybackContext, QueueEntry, RadioResponse, SessionCommand, TrackSummary, UserSettings,
} from '@squirmy/contracts';
import * as Network from 'expo-network';
import {
  createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren,
} from 'react';
import { AppState, Platform } from 'react-native';
import { useAccountKey, useServerUrl, useSignedInApi } from './account/AccountProvider';
import { clientDevice } from './account/storage';
import { useTrack, useTrackStore } from './data/library';
import { useUserSettings } from './data/queries';
import { useRealtime } from './data/realtime';
import { useAvailability, useDownloadManager } from './downloads/DownloadsProvider';
import { useNotice } from './Notice';
import { connectNowPlaying, createPlayerEngine } from './player/engine';
import { loadSession, sessionSaver } from './player/savedSession';
import {
  codecsFor, deviceRows, findEntry, isRemote, newlyFailed, nextRepeat, outputDevice, playableSeeds, qualityFor, seedOf,
} from './player/session';

export type { QueueEntry };

type Runtime = { client: SessionClient; device: ClientDevice };
type PlayOptions = { start?: number; shuffle?: boolean; context?: PlaybackContext };

const defaultQuality: Pick<UserSettings, 'qualityWifi' | 'qualityCellular'> = { qualityWifi: 'original', qualityCellular: 'high' };
/** Two failures this close together mean the server, not the file, is the problem. */
const errorSkipWindowMs = 8000;
const lockScreenArtSize = 600;
/** The session is saved this long after it last changed, and when the app leaves the screen. */
const saveDelayMs = 5000;

const idle: SessionClientSnapshot = (() => {
  const { state, queue } = splitSession(createInitialSession());
  return { session: state, queue, devices: [], connection: 'offline', isActiveDevice: false };
})();
const idleSnapshot = () => idle;
const noSubscription = () => () => undefined;

const RuntimeContext = createContext<Runtime | null>(null);

/**
 * The user's playback session, shared with their other devices through the server. A
 * `SessionClient` on the realtime socket applies commands optimistically and drives the
 * phone's audio engine while this phone is the active device; otherwise the phone is a
 * remote and stays silent. Lock screen and Control Center buttons become session
 * commands too.
 *
 * Downloaded tracks play from their files. The session is saved as it changes, so a
 * relaunch with no connection shows it (and the commands made offline still reach the
 * server). Offline, an entry that is not downloaded is skipped.
 */
export function PlaybackProvider({ children }: PropsWithChildren) {
  const api = useSignedInApi();
  const account = useAccountKey();
  const serverUrl = useServerUrl();
  const { socket, offline } = useRealtime();
  const tracks = useTrackStore();
  const downloads = useDownloadManager();
  const notify = useNotice();
  const settings = useUserSettings().data;
  const network = Network.useNetworkState();
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  // Read when a track is resolved, so a change applies from the next track on.
  const stream = useRef({ settings, network: network.type });
  stream.current = { settings, network: network.type };
  const live = useRef({ downloads, offline });
  live.current = { downloads, offline };

  useEffect(() => {
    if (!socket || !api || !account) return;
    let cancelled = false;
    let teardown: (() => void) | undefined;
    void clientDevice().then(device => {
      if (cancelled) return;
      const send = (command: SessionCommand) => client.dispatch(command);
      const engine = createPlayerEngine({ onInterrupted: () => send({ type: 'pause' }) });
      const saved = loadSession(account);
      if (saved) tracks.prime(saved.tracks);
      const client: SessionClient = new SessionClient({
        transport: createSocketTransport(socket),
        device,
        restore: saved?.session,
        player: {
          engine,
          baseUrl: serverUrl,
          canBoost: false,
          normalization: stream.current.settings?.normalization,
          resolvePlayback: async entry => {
            const local = live.current.downloads?.playback(entry.trackId);
            if (local) return local;
            const { settings: current, network: type } = stream.current;
            const kind = type === Network.NetworkStateType.CELLULAR ? 'cellular' : type === Network.NetworkStateType.WIFI ? 'wifi' : 'other';
            return api.streaming.playback(entry.trackId, {
              albumId: entry.albumId ?? undefined,
              quality: qualityFor(current ?? defaultQuality, kind),
              codecs: codecsFor(Platform.OS),
            });
          },
        },
      });

      // The lock screen shows the loaded entry; its summary may arrive after it starts.
      let waitingForItem = false;
      const nowPlaying = connectNowPlaying(engine, entryId => {
        const { session, queue } = client.getSnapshot();
        const entry = findEntry({ ...session, ...queue }, entryId);
        const track = entry && tracks.get(entry.trackId, entry.albumId);
        waitingForItem = !track;
        if (!track) return null;
        return {
          title: track.title,
          artist: track.artistCredit,
          album: track.album?.title,
          artworkUrl: (track.album?.artwork && live.current.downloads?.artworkUri(track.album.artwork.id))
            || (artworkUrl(serverUrl, track.album?.artwork, lockScreenArtSize) ?? undefined),
          durationMs: entry.durationMs || track.durationMs,
        };
      }, {
        onPlay: () => send({ type: 'play' }),
        onPause: () => send({ type: 'pause' }),
        onNext: () => send({ type: 'next' }),
        onPrevious: () => send({ type: 'previous' }),
        onSeek: positionMs => send({ type: 'seek', positionMs }),
      });
      const stopWaiting = tracks.subscribe(() => {
        if (waitingForItem) nowPlaying.refresh();
      });

      // On-demand tracks the server could not fetch are skipped by the session; say so.
      let previous = client.getSnapshot();
      const stopWatching = client.subscribe(() => {
        const next = client.getSnapshot();
        for (const entry of newlyFailed({ ...previous.session, ...previous.queue }, { ...next.session, ...next.queue })) {
          const title = tracks.get(entry.trackId, entry.albumId)?.title;
          notify(title ? `Couldn’t get “${title}”. Skipped it.` : 'Couldn’t get a track. Skipped it.');
        }
        previous = next;
      });

      // A file that will not play is skipped. When the next one fails as well, the
      // connection is the likelier cause, so playback pauses instead.
      let lastSkip = -Infinity;
      // Offline, only downloads can play: an entry that is not one is passed over, with one notice per spell offline.
      let skipped: string | null = null;
      const skipUndownloaded = () => {
        const { session, isActiveDevice } = client.getSnapshot();
        const current = session.current;
        if (!live.current.offline) skipped = null;
        if (!live.current.offline || !isActiveDevice || !current || current.state !== 'ready') return false;
        if (live.current.downloads?.isDownloaded(current.trackId) || skipped === current.id) return false;
        if (skipped === null) notify('Skipped songs that aren’t downloaded.');
        skipped = current.id;
        send({ type: 'next' });
        return true;
      };
      const stopSkipping = client.subscribe(() => {
        const { session } = client.getSnapshot();
        const status = engine.getStatus();
        // A stream that is still playing from its buffer is left to finish.
        if (!session.playing || (status.entryId === session.current?.id && (status.state === 'playing' || status.state === 'buffering'))) return;
        skipUndownloaded();
      });

      const stopErrors = engine.subscribe(event => {
        if (event.type !== 'error') return;
        const { session, connection } = client.getSnapshot();
        if (session.current?.id !== event.entryId || skipUndownloaded()) return;
        const title = tracks.get(session.current.trackId, session.current.albumId)?.title;
        if (connection === 'online' && Date.now() - lastSkip > errorSkipWindowMs) {
          lastSkip = Date.now();
          notify(title ? `Couldn’t play “${title}”. ${event.message}` : event.message);
          send({ type: 'next' });
        } else {
          notify(event.message);
          send({ type: 'pause' });
        }
      });

      let saveTimer: ReturnType<typeof setTimeout> | undefined;
      const saveSession = sessionSaver(account, client, tracks);
      const save = () => {
        clearTimeout(saveTimer);
        saveSession();
      };
      const stopSaving = client.subscribe(() => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, saveDelayMs);
      });
      const appState = AppState.addEventListener('change', status => {
        if (status !== 'active') save();
      });

      client.start();
      setRuntime({ client, device });
      teardown = () => {
        // Not saved here: this runs on sign-out too, after the account's data was removed.
        clearTimeout(saveTimer);
        appState.remove();
        stopSaving();
        stopSkipping();
        stopErrors();
        stopWatching();
        stopWaiting();
        nowPlaying.disconnect();
        client.dispose();
      };
    });
    return () => {
      cancelled = true;
      teardown?.();
      setRuntime(null);
    };
  }, [account, api, notify, serverUrl, socket, tracks]);

  // Where a track plays from changed: resolve entries again.
  useEffect(() => {
    if (runtime && downloads) return downloads.onFilesChanged(() => runtime.client.forgetPlayback());
  }, [downloads, runtime]);

  const normalization = settings?.normalization;
  useEffect(() => {
    if (runtime && normalization) runtime.client.setNormalization(normalization);
  }, [normalization, runtime]);

  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

function useSnapshot(): SessionClientSnapshot {
  const runtime = useContext(RuntimeContext);
  return useSyncExternalStore(runtime?.client.subscribe ?? noSubscription, runtime?.client.getSnapshot ?? idleSnapshot);
}

function createActions(runtime: Runtime | null, canPlay: (track: TrackSummary) => boolean) {
  const send = (command: SessionCommand) => runtime?.client.dispatch(command);
  const session = () => (runtime?.client.getSnapshot() ?? idle).session;
  const enqueue = (tracks: readonly TrackSummary[], placement: 'next' | 'last') => {
    const { seeds } = playableSeeds(tracks, 0, canPlay);
    if (seeds.length) send({ type: 'enqueue', tracks: seeds, placement });
  };
  return {
    playPause: () => send({ type: session().playing ? 'pause' : 'play' }),
    play: () => send({ type: 'play' }),
    seek: (positionMs: number) => send({ type: 'seek', positionMs: Math.max(0, positionMs) }),
    next: () => send({ type: 'next' }),
    previous: () => send({ type: 'previous' }),
    setVolume: (deviceId: string, value: number) => send({ type: 'setVolume', deviceId, value: Math.min(1, Math.max(0, value)) }),
    /** Moves playback to `deviceId`, which carries on from the current position. */
    transfer: (deviceId: string) => send({ type: 'transfer', deviceId }),
    toggleShuffle: () => send({ type: 'setShuffle', value: !session().shuffle, seed: randomSeed() }),
    cycleRepeat: () => send({ type: 'setRepeat', value: nextRepeat(session().repeat) }),
    toggleAutoplay: () => send({ type: 'setAutoplay', value: !session().autoplay }),
    /**
     * Replaces the queue with the playable tracks of a list, starting at `start` (an
     * index into `tracks`). `shuffle` left out keeps the session's shuffle setting.
     */
    playTracks: (tracks: readonly TrackSummary[], { start, shuffle, context }: PlayOptions = {}) => {
      const { seeds, startIndex } = playableSeeds(tracks, start, canPlay);
      if (!seeds.length) return;
      send({
        type: 'playTracks', tracks: seeds, seed: randomSeed(), shuffle, context: context ?? null,
        startIndex: shuffle && start === undefined ? undefined : startIndex,
      });
    },
    playRadio: ({ tracks, context }: RadioResponse) => send({ type: 'playTracks', tracks, context, startIndex: 0, seed: randomSeed() }),
    /** Plays one track now and keeps the queue: it goes to the front, then playback moves to it. */
    playNow: (track: TrackSummary) => {
      enqueue([track], 'next');
      send({ type: 'next' });
    },
    enqueue,
    playQueueEntry: (entryId: string) => send({ type: 'playQueueEntry', entryId }),
    removeFromQueue: (entryId: string) => send({ type: 'removeFromQueue', entryId }),
    moveInQueue: (entryId: string, toIndex: number) => send({ type: 'moveInQueue', entryId, toIndex: Math.max(0, toIndex) }),
    /** Up next for a queued entry; an autoplay suggestion is copied into the queue first. */
    promote: (entry: QueueEntry, track: TrackSummary | undefined, autoplay: boolean) => {
      if (!autoplay) return send({ type: 'moveInQueue', entryId: entry.id, toIndex: 0 });
      send({ type: 'enqueue', tracks: [track ? seedOf(track) : { trackId: entry.trackId, albumId: entry.albumId, durationMs: entry.durationMs }], placement: 'next' });
      send({ type: 'removeFromQueue', entryId: entry.id });
    },
    clearHistory: () => send({ type: 'clearHistory' }),
  };
}

export type PlaybackActions = ReturnType<typeof createActions>;

/**
 * The session as the screens show it: the current entry and its track, the queue, the
 * devices, and the commands. Position is not included; `usePosition` reads it.
 */
export function usePlaybackState() {
  const runtime = useContext(RuntimeContext);
  const snapshot = useSnapshot();
  const { session, queue, devices } = snapshot;
  const current = session.current;
  const track = useTrack(current?.trackId, current?.albumId);
  const { canPlay } = useAvailability();
  const actions = useMemo(() => createActions(runtime, canPlay), [canPlay, runtime]);
  const device = runtime?.device;
  const rows = useMemo(() => {
    const self: DeviceInfo = { id: device?.id ?? '', name: device?.name ?? 'iPhone', kind: device?.kind ?? 'ios', canPlay: true, isActive: false };
    return deviceRows(devices, self, session.activeDeviceId);
  }, [device, devices, session.activeDeviceId]);
  const output = outputDevice(rows);
  return {
    session,
    queue,
    current,
    track,
    /** The current entry's length, from the session or, while it is unknown there, the track. */
    durationMs: current?.durationMs || track?.durationMs || 0,
    preparing: current?.state === 'preparing',
    connection: snapshot.connection,
    devices: rows,
    output,
    volume: session.volumes[output.id] ?? 1,
    /** Another device plays; this phone only controls it. */
    remote: isRemote(session, device?.id ?? ''),
    actions,
  };
}

/**
 * Whether `trackId` is the current entry and waits for the server to fetch it; re-renders
 * only when that changes. Queued entries say so in the queue.
 */
export function useTrackPreparing(trackId: string | undefined): boolean {
  const runtime = useContext(RuntimeContext);
  return useSyncExternalStore(runtime?.client.subscribe ?? noSubscription, () => {
    const current = runtime?.client.getSnapshot().session.current;
    return Boolean(trackId) && current?.trackId === trackId && current?.state === 'preparing';
  });
}

function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', status => setActive(status === 'active'));
    return () => subscription.remove();
  }, []);
  return active;
}

/**
 * The current entry's position in milliseconds, read from the session client four times
 * a second while it moves, the app is on screen and `enabled`. Only the component calling
 * this re-renders as it ticks.
 */
export function usePosition(enabled = true): number {
  const runtime = useContext(RuntimeContext);
  const { session } = useSnapshot();
  const active = useAppActive();
  const [position, setPosition] = useState(() => runtime?.client.getPositionMs() ?? 0);
  useEffect(() => {
    const read = () => setPosition(runtime?.client.getPositionMs() ?? 0);
    read();
    if (!runtime || !enabled || !active || !session.playing || session.stalled) return;
    const timer = setInterval(read, 250);
    return () => clearInterval(timer);
  }, [active, enabled, runtime, session]);
  return position;
}
