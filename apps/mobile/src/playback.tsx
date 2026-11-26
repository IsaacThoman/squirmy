import {
  ApiError, artworkUrl, createInitialSession, randomSeed, refreshFetchedTracks, SessionClient, splitSession,
  type PlaybackNotice, type SessionClientSnapshot, type SessionMoveResult, type SessionPlayer,
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
import { getCarPlayState, subscribeCarPlay } from './carplay/bridge';
import { carPlayResume, carPlayStart, type CarPlayStartCommand } from './carplay/playback';
import { useLibraryActions, useLikeChanges, useTrack, useTrackStore } from './data/library';
import { useUserSettings } from './data/queries';
import { useRealtime } from './data/realtime';
import { useAvailability, useDownloadManager } from './downloads/DownloadsProvider';
import { connectAudioSession, connectNowPlaying, createPlayerEngine } from './player/engine';
import { favoriteState } from './player/engine/favorite';
import { loadSession, sessionSaver } from './player/savedSession';
import {
  codecsFor, deviceRows, findEntry, isRemote, nextDownloaded, nextRepeat, outputDevice, playableSeeds,
  qualityFor, seedOf,
} from './player/session';
import { watchLoading, type LoadingPhase, type LoadingWatch } from './player/loading';
import { createNoticeReporter } from './player/playbackNotices';
import { PendingSeek } from './player/pendingSeek';
import { playbackStatus } from './player/usePlaybackStatus';
import { syncSystemVolume } from './player/systemVolume';
import { SystemVolume } from '../modules/now-playing';
import { useStreamingCache } from './streamingCache/context';
import { resolvePlayback } from './streamingCache/resolve';
import { followSession } from './streamingCache/session';

export type { QueueEntry };

type Runtime = { client: SessionClient; device: ClientDevice; loading: LoadingWatch; seeks: PendingSeek };
export type PlayOptions = { start?: number; shuffle?: boolean; context?: PlaybackContext };

const defaultQuality: Pick<UserSettings, 'qualityWifi' | 'qualityCellular'> = { qualityWifi: 'original', qualityCellular: 'high' };
/** Two failures this close together mean the server, not the file, is the problem. */
const errorSkipWindowMs = 8000;
const lockScreenArtSize = 600;
/** The session is saved this long after it last changed, and when the app leaves the screen. */
const saveDelayMs = 5000;

const idle: SessionClientSnapshot = (() => {
  const { state, queue } = splitSession(createInitialSession());
  return { session: state, queue, devices: [], connection: 'offline', isActiveDevice: false, detached: false, canDetach: false, outage: null, away: null };
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
 * Downloaded tracks play from their files, and so do tracks in the streaming cache, which
 * follows the session to fetch what plays next. The session is saved as it changes, so a
 * relaunch with no connection shows it (and the commands made offline still reach the
 * server). Offline, an entry that is neither downloaded nor cached is skipped.
 */
export function PlaybackProvider({ children }: PropsWithChildren) {
  const api = useSignedInApi();
  const account = useAccountKey();
  const serverUrl = useServerUrl();
  const { socket, offline, setPlayingHere } = useRealtime();
  const tracks = useTrackStore();
  const downloads = useDownloadManager();
  const cache = useStreamingCache();
  const likes = useLikeChanges();
  const { setLiked } = useLibraryActions();
  const settings = useUserSettings().data;
  const network = Network.useNetworkState();
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  // Read when a track is resolved, so a change applies from the next track on.
  const stream = useRef({ settings, network: network.type });
  stream.current = { settings, network: network.type };
  // Read through refs so the runtime outlives a new API client or store:
  // rebuilding it stops the music.
  const live = useRef({ downloads, cache, offline, api, tracks, likes, setLiked });
  live.current = { downloads, cache, offline, api, tracks, likes, setLiked };
  const onOffline = useRef<((offline: boolean) => void) | null>(null);
  useEffect(() => onOffline.current?.(offline), [offline]);
  // A heart changed, here or on another device: the lock screen's star follows.
  const onLikes = useRef<(() => void) | null>(null);
  useEffect(() => onLikes.current?.(), [likes]);

  useEffect(() => {
    if (!socket || !live.current.api || !account) return;
    const { tracks } = live.current;
    // What playback has to say shows in the player, in place of the artist (`playbackStatus`).
    const report = (notice: PlaybackNotice, lasting = false) => playbackStatus.report(notice, { lasting });
    let cancelled = false;
    let teardown: (() => void) | undefined;
    void clientDevice().then(device => {
      if (cancelled) return;
      const send = (command: SessionCommand) => client.dispatch(command);
      const engine = createPlayerEngine({
        onInterrupted: () => send({ type: 'pause' }),
        // Only the entry the call paused, and only if nothing has moved playback since.
        onResumed: entryId => {
          const { session, isActiveDevice } = client.getSnapshot();
          if (isActiveDevice && !session.playing && session.current?.id === entryId) send({ type: 'play' });
        },
      });
      const stopAudioSession = connectAudioSession(engine);
      const saved = loadSession(account);
      if (saved) tracks.prime(saved.tracks);
      const client: SessionClient = new SessionClient({
        transport: createSocketTransport(socket),
        device,
        restore: saved?.session,
        onDetachedEnded: reason => report({ message: reason === 'expired'
          ? 'This phone was away for over a week, so it’s playing with your other devices again.'
          : 'This phone is playing with your other devices again.' }),
        player: {
          engine,
          baseUrl: serverUrl,
          canBoost: false,
          // On iOS this phone's volume is the system's; the player stays at full volume.
          systemVolume: SystemVolume !== null,
          normalization: stream.current.settings?.normalization,
          onLoadError: (entry, error, willRetry) => loadFailed(entry, error, willRetry),
          resolvePlayback: entry => {
            const { settings: current, network: type } = stream.current;
            const kind = type === Network.NetworkStateType.CELLULAR ? 'cellular' : type === Network.NetworkStateType.WIFI ? 'wifi' : 'other';
            return resolvePlayback(entry, qualityFor(current ?? defaultQuality, kind), {
              downloaded: trackId => live.current.downloads?.playback(trackId) ?? null,
              cached: (trackId, quality, any) => live.current.cache?.playback(trackId, quality, any) ?? null,
              server: (item, quality) => {
                const { api } = live.current;
                if (!api) return Promise.reject(new Error('Signed out'));
                return api.streaming.playback(item.trackId, { albumId: item.albumId ?? undefined, quality, codecs: codecsFor(Platform.OS) });
              },
            }, live.current.offline);
          },
        },
      });
      // Seeks from the app and the lock screen alike: one made while the server fetches the song waits for it.
      const seeks = new PendingSeek(client);

      // The lock screen shows the loaded entry; its summary may arrive after it starts.
      let waitingForItem = false;
      // The entry and summary on the lock screen, to notice when that summary is replaced.
      let shown: { entryId: string; track: TrackSummary } | null = null;
      const trackOf = (entryId: string) => {
        const { session, queue } = client.getSnapshot();
        const entry = findEntry({ ...session, ...queue }, entryId);
        return (entry && tracks.peek(entry.trackId, entry.albumId)) ?? (shown?.entryId === entryId ? shown.track : undefined);
      };
      // CarPlay and the phone's player share metadata and remote commands. A car can ask
      // for Play on connection even when this phone has yet to load an entry.
      const ownsTransport = () => {
        const { session } = client.getSnapshot();
        return !getCarPlayState().connected || !session.activeDeviceId || session.activeDeviceId === device.id;
      };
      const nowPlaying = connectNowPlaying(engine, entryId => {
        const { session, queue } = client.getSnapshot();
        const entry = findEntry({ ...session, ...queue }, entryId);
        const track = entry && tracks.get(entry.trackId, entry.albumId);
        waitingForItem = !track;
        shown = track ? { entryId, track } : null;
        if (!track) return null;
        return {
          title: track.title,
          artist: track.artistCredit,
          album: track.album?.title,
          artworkUrl: (track.album?.artwork
            && (live.current.downloads?.artworkUri(track.album.artwork.id) ?? live.current.cache?.artworkUri(track.album.artwork.id)))
            || (artworkUrl(serverUrl, track.album?.artwork, lockScreenArtSize) ?? undefined),
          durationMs: entry.durationMs || track.durationMs,
        };
      }, {
        onPlay: () => {
          const { session } = client.getSnapshot();
          if (!getCarPlayState().connected) return send({ type: 'play' });
          if (client.getSnapshot().connection === 'online' || live.current.offline) {
            carPlayResume(session, device.id, client.supportsPlayHere()).forEach(send);
          }
        },
        onPause: () => { if (ownsTransport()) send({ type: 'pause' }); },
        onNext: () => { if (ownsTransport()) send({ type: 'next' }); },
        onPrevious: () => { if (ownsTransport()) send({ type: 'previous' }); },
        onSeek: positionMs => { if (ownsTransport()) seeks.seek(positionMs); },
        queueFor: entryId => {
          const { session, queue } = client.getSnapshot();
          if (session.current?.id !== entryId) return null;
          return { index: queue.playedInCycle.length, count: queue.playedInCycle.length + queue.queue.length + 1 };
        },
        favoriteFor: entryId => favoriteState(trackOf(entryId), live.current.likes),
        // The in-app heart's path: shown at once, sent (or queued offline), set back with a
        // failure on the heart if the server refuses. The app may be in the background; it still runs.
        onFavorite: (entryId, saved) => {
          const track = trackOf(entryId);
          if (track) live.current.setLiked('track', track.id, saved, track.title);
        },
      });
      const followCarPlay = () => nowPlaying.setCarPlayConnected(getCarPlayState().connected);
      const stopCarPlay = subscribeCarPlay(followCarPlay);
      followCarPlay();
      const stopQueueMetadata = client.subscribe(nowPlaying.refreshQueue);
      onLikes.current = nowPlaying.refreshFavorite;
      const stopWaiting = tracks.subscribe(() => {
        if (waitingForItem) return nowPlaying.refresh();
        if (!shown) return;
        // A summary fetched again (a song the server just fetched gained its cover) replaces it.
        const { session, queue } = client.getSnapshot();
        const entry = findEntry({ ...session, ...queue }, shown.entryId);
        const latest = entry && tracks.peek(entry.trackId, entry.albumId);
        if (latest && latest !== shown.track) nowPlaying.refresh();
        else nowPlaying.refreshFavorite();
      });

      // While the server fetches the current song, the phone keeps its audio session (and
      // so keeps running when locked) and the lock screen shows the song as buffering.
      const holdWhilePreparing = () => {
        const { session, isActiveDevice } = client.getSnapshot();
        const preparing = isActiveDevice && session.playing && session.current?.state === 'preparing' ? session.current.id : null;
        engine.holdAudioSession(preparing !== null);
        nowPlaying.hold(preparing);
      };
      const stopHolding = client.subscribe(holdWhilePreparing);

      // A song the server just fetched has its album and cover now; the summary shown since
      // it was queued has neither, so the player and the lock screen would keep a blank cover.
      const stopRefreshing = refreshFetchedTracks(client, tracks);

      // What to say when the server could not fetch songs, worded as on the web (`createNoticeReporter`).
      const notices = createNoticeReporter({
        failureOf: trackId => client.failureOf(trackId),
        titleOf: (trackId, albumId) => tracks.get(trackId, albumId)?.title,
        status: playbackStatus,
      });
      notices(client.getSnapshot());
      const stopWatching = client.subscribe(() => notices(client.getSnapshot()));
      const stopSeeking = client.subscribe(() => seeks.update());
      const loading = watchLoading(client);
      const systemVolume = SystemVolume;
      const stopVolume = systemVolume ? syncSystemVolume({
        system: {
          get: () => systemVolume.getVolume(),
          set: volume => void systemVolume.setVolume(volume).catch(() => undefined),
          subscribe: listener => {
            const subscription = systemVolume.addListener('onVolumeChange', ({ volume }) => listener(volume));
            return () => subscription.remove();
          },
        },
        session: client,
        deviceId: device.id,
        send,
      }) : () => undefined;

      // A file that will not play is skipped. When the next one fails as well, the
      // connection is the likelier cause, so playback pauses instead.
      let lastSkip = -Infinity;
      // Offline, only downloads and cached tracks can play. Said once per spell offline.
      let toldOffline = false;
      /**
       * Moves past an entry that can't be streamed offline, straight to the next download
       * in one command (walking there with `next` replays every step), or pauses when
       * there is none. False when the current entry is a download, which plays anyway.
       */
      const skipToDownload = (pauseIfNone: boolean) => {
        const { session, queue, isActiveDevice } = client.getSnapshot();
        const current = session.current;
        const { downloads, cache } = live.current;
        const onPhone = (trackId: string) => Boolean(downloads?.isDownloaded(trackId) || cache?.has(trackId));
        if (!isActiveDevice || !current || onPhone(current.trackId)) return false;
        const target = nextDownloaded({ ...queue, autoplay: session.autoplay }, onPhone);
        if (!target && !pauseIfNone) return false;
        if (!toldOffline) report({ message: target ? 'Skipped songs that aren’t downloaded or cached.' : 'Only downloaded or cached songs play offline.' }, !target);
        toldOffline = true;
        send(target ? { type: 'playQueueEntry', entryId: target.id } : { type: 'pause' });
        return true;
      };
      onOffline.current = offline => {
        if (!offline) {
          toldOffline = false;
          return;
        }
        // The server can't finish fetching a song for a phone it can't reach.
        const { session } = client.getSnapshot();
        if (session.playing && session.current?.state === 'preparing') skipToDownload(true);
      };
      const stopPreparing = client.subscribe(() => {
        const { session } = client.getSnapshot();
        if (live.current.offline && session.playing && session.current?.state === 'preparing') skipToDownload(true);
      });

      const failed = (entryId: string, message: string) => {
        const { session, connection } = client.getSnapshot();
        if (session.current?.id !== entryId || (live.current.offline && skipToDownload(true))) return;
        const title = tracks.get(session.current.trackId, session.current.albumId)?.title;
        const notice = title ? { message: `Couldn’t play “${title}”`, detail: message } : { message };
        if (connection === 'online' && Date.now() - lastSkip > errorSkipWindowMs) {
          lastSkip = Date.now();
          report(notice);
          send({ type: 'next' });
        } else {
          report(notice, true);
          send({ type: 'pause' });
        }
      };
      const stopErrors = engine.subscribe(event => {
        if (event.type === 'error') failed(event.entryId, event.message);
      });
      const loadFailed: NonNullable<SessionPlayer['onLoadError']> = (entry, error, willRetry) => {
        if (!willRetry) return failed(entry.id, refusalMessage(error));
        // A stream the phone can't reach: offline, a download plays instead. Otherwise
        // the client keeps trying, so a short drop resumes where it was.
        if (error instanceof ApiError && error.status === 0 && client.getSnapshot().session.current?.id === entry.id) {
          skipToDownload(live.current.offline);
        }
      };

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
      // In the background the socket stays open only while this phone plays (`BackgroundPresence`).
      // A phone still loading a song it was told to play, or stuck on one, counts as playing:
      // closed, its socket would let the server give up on it and pause everyone's session
      // while it could still start the song.
      const followPlaying = () => {
        const { isActiveDevice, session } = client.getSnapshot();
        setPlayingHere(isActiveDevice && (session.playing || engine.isTryingToPlay()));
      };
      const stopFollowing = client.subscribe(followPlaying);
      const stopFollowingEngine = engine.subscribe(followPlaying);

      client.start();
      followPlaying();
      holdWhilePreparing();
      setRuntime({ client, device, loading, seeks });
      teardown = () => {
        // Not saved here: this runs on sign-out too, after the account's data was removed.
        clearTimeout(saveTimer);
        appState.remove();
        stopFollowing();
        stopFollowingEngine();
        setPlayingHere(false);
        stopSaving();
        stopPreparing();
        stopHolding();
        stopRefreshing();
        engine.holdAudioSession(false);
        stopAudioSession();
        stopErrors();
        onOffline.current = null;
        onLikes.current = null;
        stopWatching();
        stopSeeking();
        playbackStatus.clear();
        loading.dispose();
        stopVolume();
        stopWaiting();
        stopCarPlay();
        stopQueueMetadata();
        nowPlaying.disconnect();
        client.dispose();
      };
    });
    return () => {
      cancelled = true;
      teardown?.();
      setRuntime(null);
    };
  }, [account, serverUrl, setPlayingHere, socket]);

  // Where a track plays from changed: resolve entries again.
  useEffect(() => {
    if (runtime && downloads) return downloads.onFilesChanged(() => runtime.client.forgetPlayback());
  }, [downloads, runtime]);

  // The streaming cache fetches what the session plays next, and has the client forget a track whose file came or went.
  useEffect(() => {
    if (runtime && cache) return followSession(cache, runtime.client);
  }, [cache, runtime]);

  const normalization = settings?.normalization;
  useEffect(() => {
    if (runtime && normalization) runtime.client.setNormalization(normalization);
  }, [normalization, runtime]);

  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

/** What the server said when it refused to serve a track. */
function refusalMessage(error: unknown): string {
  if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return 'The server couldn’t find this track.';
  return 'The server wouldn’t play this track.';
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
  const startHere = (command: CarPlayStartCommand) => {
    if (!runtime) return false;
    carPlayStart(session(), runtime.device.id, command, runtime.client.supportsPlayHere()).forEach(send);
    return true;
  };
  const tracksCommand = (tracks: readonly TrackSummary[], { start, shuffle, context }: PlayOptions) => {
    const { seeds, startIndex } = playableSeeds(tracks, start, canPlay);
    if (!seeds.length) return null;
    return {
      type: 'playTracks', tracks: seeds, seed: randomSeed(), shuffle, context: context ?? null,
      startIndex: shuffle && start === undefined ? undefined : startIndex,
      // A row names its song; a header's Play or Shuffle can skip an unavailable first song.
      startedFrom: start === undefined || shuffle ? 'collection' : 'song',
    } satisfies SessionCommand;
  };
  const radioCommand = ({ tracks, context }: RadioResponse, shuffle?: boolean): CarPlayStartCommand => ({
    type: 'playTracks', tracks, context, startIndex: shuffle ? undefined : 0, shuffle, seed: randomSeed(), startedFrom: 'collection',
  });
  return {
    playPause: () => send({ type: session().playing ? 'pause' : 'play' }),
    play: () => send({ type: 'play' }),
    /** Seeks now, or once the server has fetched the current song (`PendingSeek`). */
    seek: (positionMs: number) => runtime?.seeks.seek(Math.max(0, positionMs)),
    next: () => send({ type: 'next' }),
    previous: () => send({ type: 'previous' }),
    /** Back to the song before, however far into this one; nothing when there is none. */
    previousTrack: () => send({ type: 'previous', restart: false }),
    setVolume: (deviceId: string, value: number) => send({ type: 'setVolume', deviceId, value: Math.min(1, Math.max(0, value)) }),
    /** Moves playback to `deviceId`, which carries on from the current position. */
    transfer: (deviceId: string) => send({ type: 'transfer', deviceId }),
    /** Takes this phone out of the shared session into one of its own. Resolves once the server has answered. */
    detach: (): Promise<SessionMoveResult> => runtime?.client.detach() ?? Promise.resolve({ ok: false, error: 'offline' }),
    /** Puts this phone back in the shared session; `bringQueue` makes the shared session what it was playing. */
    attach: (options?: { bringQueue?: boolean }): Promise<SessionMoveResult> =>
      runtime?.client.attach(options) ?? Promise.resolve({ ok: false, error: 'offline' }),
    toggleShuffle: () => send({ type: 'setShuffle', value: !session().shuffle, seed: randomSeed() }),
    cycleRepeat: () => send({ type: 'setRepeat', value: nextRepeat(session().repeat) }),
    toggleAutoplay: () => send({ type: 'setAutoplay', value: !session().autoplay }),
    /**
     * Replaces the queue with the playable tracks of a list, starting at `start` (an
     * index into `tracks`). `shuffle` left out keeps the session's shuffle setting.
     */
    playTracks: (tracks: readonly TrackSummary[], options: PlayOptions = {}) => {
      const command = tracksCommand(tracks, options);
      if (command) send(command);
    },
    playRadio: (radio: RadioResponse) => send(radioCommand(radio)),
    /** Explicit selections in the car or through Siri belong on this phone. */
    playHere: (tracks: readonly TrackSummary[], options: PlayOptions = {}) => {
      const command = tracksCommand(tracks, options);
      return Boolean(command && startHere(command));
    },
    playRadioHere: (radio: RadioResponse, shuffle?: boolean) => startHere(radioCommand(radio, shuffle)),
    playQueueEntryHere: (entryId: string) => {
      if (!runtime) return false;
      const { queue, session: current } = runtime.client.getSnapshot();
      const entry = [...queue.queue, ...queue.autoplayQueue].find(entry => entry.id === entryId);
      return Boolean(entry && entry.state !== 'failed' && (current.autoplay || queue.queue.includes(entry))
        && startHere({ type: 'playQueueEntry', entryId }));
    },
    resumeHere: () => {
      if (!runtime) return false;
      const { session: current, queue } = runtime.client.getSnapshot();
      if (!current.current && !queue.queue.length && !(current.autoplay && queue.autoplayQueue.length)) return false;
      if (current.playing && current.activeDeviceId !== runtime.device.id) return false;
      const commands = carPlayResume(current, runtime.device.id, runtime.client.supportsPlayHere());
      commands.forEach(send);
      return commands.length > 0;
    },
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
    clearQueue: () => send({ type: 'clearQueue' }),
    /**
     * Pauses or resumes `trackId` when it is the current song, as tapping it again in a list
     * does on the web; false when it is not (or it failed), so the tap plays it instead.
     */
    toggleIfCurrent: (trackId: string) => {
      const current = session().current;
      if (current?.trackId !== trackId || current.state === 'failed') return false;
      send({ type: session().playing ? 'pause' : 'play' });
      return true;
    },
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
  const { session, queue, devices, away } = snapshot;
  const current = session.current;
  const track = useTrack(current?.trackId, current?.albumId);
  const { canPlay } = useAvailability();
  const actions = useMemo(() => createActions(runtime, canPlay), [canPlay, runtime]);
  const device = runtime?.device;
  const rows = useMemo(() => {
    const self: DeviceInfo = { id: device?.id ?? '', name: device?.name ?? 'iPhone', kind: device?.kind ?? 'ios', canPlay: true, isActive: false };
    return deviceRows(devices, self, { activeDeviceId: session.activeDeviceId, playing: session.playing, away });
  }, [away, device, devices, session.activeDeviceId, session.playing]);
  const output = outputDevice(rows);
  return {
    session,
    queue,
    current,
    track,
    /** The current entry's length, from the session or, while it is unknown there, the track. */
    durationMs: current?.durationMs || track?.durationMs || 0,
    connection: snapshot.connection,
    devices: rows,
    output,
    volume: session.volumes[output.id] ?? 1,
    /** Another device plays; this phone only controls it. */
    remote: isRemote(session, device?.id ?? ''),
    /** This phone plays its own session, apart from the user's other devices. */
    detached: snapshot.detached,
    /** This phone can play separately: hide the control otherwise. */
    canDetach: snapshot.canDetach,
    /** Every device the user has connected, the detached ones included, for the "Playing separately" group. */
    allDevices: devices,
    thisDeviceId: device?.id ?? '',
    actions,
  };
}

// One object, not a new one per read: `useSyncExternalStore` compares snapshots by identity.
const notLoading = { trackId: null, phase: 'none' as const };
const noLoading = () => notLoading;

/**
 * Whether the current entry waits for audio while it should play, fetched or buffering
 * alike: `loading` shows the buffering spinner, `slow` (after 8 seconds) also the subtitle
 * "Still loading…". Re-renders only when that changes.
 */
export function useLoading(): LoadingPhase {
  const runtime = useContext(RuntimeContext);
  return useSyncExternalStore(runtime?.loading.subscribe ?? noSubscription, runtime?.loading.getSnapshot ?? noLoading).phase;
}

/** `useLoading` for a row: its phase while `trackId` is the current entry's track, otherwise `none`. */
export function useTrackLoading(trackId: string | undefined): LoadingPhase {
  const runtime = useContext(RuntimeContext);
  return useSyncExternalStore(runtime?.loading.subscribe ?? noSubscription, () => {
    const loading = runtime?.loading.getSnapshot();
    return loading && trackId && loading.trackId === trackId ? loading.phase : 'none';
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
  const [position, setPosition] = useState(() => runtime?.seeks.position() ?? 0);
  useEffect(() => {
    const read = () => setPosition(runtime?.seeks.position() ?? 0);
    read();
    if (!runtime) return;
    // A seek kept for a song still being fetched moves the position without a session change.
    const stopSeeks = runtime.seeks.subscribe(read);
    if (!enabled || !active || !session.playing || session.stalled) return stopSeeks;
    const timer = setInterval(read, 250);
    return () => {
      stopSeeks();
      clearInterval(timer);
    };
  }, [active, enabled, runtime, session]);
  return position;
}

// Narrow subscriptions. A component that shows one fact about the session reads it here
// and re-renders only when that fact changes, not on every session broadcast.

/** Reads one value from the session client; re-renders only when it changes (compared with `Object.is`). */
function useSessionValue<T>(select: (snapshot: SessionClientSnapshot) => T): T {
  const runtime = useContext(RuntimeContext);
  return useSyncExternalStore(runtime?.client.subscribe ?? noSubscription, () => select(runtime?.client.getSnapshot() ?? idle));
}

/** Whether the session is playing (on whichever device plays it). */
export function useIsPlaying(): boolean {
  return useSessionValue(snapshot => snapshot.session.playing);
}

/** Whether `trackId` is the current entry's track. */
export function useIsCurrentTrack(trackId: string | undefined): boolean {
  return useSessionValue(snapshot => Boolean(trackId) && snapshot.session.current?.trackId === trackId);
}

/** `playing` or `paused` while `trackId` is the current entry's track, otherwise null. */
export function useCurrentTrackState(trackId: string | undefined): 'playing' | 'paused' | null {
  return useSessionValue(({ session }) => !trackId || session.current?.trackId !== trackId ? null : session.playing ? 'playing' : 'paused');
}

/**
 * The session's commands. The object changes only with the session runtime, so passing it
 * down does not re-render anything; which tracks are playable is read when a command runs.
 */
export function usePlaybackActions(): PlaybackActions {
  const runtime = useContext(RuntimeContext);
  const { canPlay } = useAvailability();
  const playable = useRef(canPlay);
  playable.current = canPlay;
  return useMemo(() => createActions(runtime, track => playable.current(track)), [runtime]);
}

/**
 * The current entry's position, read every `intervalMs` while it moves, the app is on
 * screen and `enabled`. Unlike `usePosition`, it re-renders for the clock only, not for
 * other session changes.
 */
export function usePositionEvery(intervalMs: number, enabled = true): number {
  const runtime = useContext(RuntimeContext);
  const moving = useSessionValue(({ session }) => session.playing && !session.stalled);
  // Seeks and track changes move the clock without a tick.
  const anchor = useSessionValue(({ session }) => `${session.current?.id ?? ''}:${session.positionMs}:${session.anchorAt}`);
  const active = useAppActive();
  const [position, setPosition] = useState(() => runtime?.seeks.position() ?? 0);
  useEffect(() => {
    const read = () => setPosition(runtime?.seeks.position() ?? 0);
    read();
    if (!runtime) return;
    const stopSeeks = runtime.seeks.subscribe(read);
    if (!enabled || !active || !moving) return stopSeeks;
    const timer = setInterval(read, intervalMs);
    return () => {
      stopSeeks();
      clearInterval(timer);
    };
  }, [active, anchor, enabled, intervalMs, moving, runtime]);
  return position;
}

/** The current entry's length, from the session or, while it is unknown there, the track. */
export function useCurrentDurationMs(): number {
  const durationMs = useSessionValue(({ session }) => session.current?.durationMs ?? 0);
  const trackId = useSessionValue(({ session }) => session.current?.trackId);
  const albumId = useSessionValue(({ session }) => session.current?.albumId);
  const track = useTrack(trackId, albumId);
  return durationMs || track?.durationMs || 0;
}
