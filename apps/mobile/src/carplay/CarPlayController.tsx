import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useAccountKey, useSignedInApi } from '../account/AccountProvider';
import { useLibraryActions, useLikeChanges, useTrackStore } from '../data/library';
import { useRealtime } from '../data/realtime';
import { useAvailability, useViewer } from '../downloads/DownloadsProvider';
import { favoriteState } from '../player/engine/favorite';
import { usePlaybackState } from '../playback';
import { CarPlay, getCarPlayState, useCarPlayState, type CarPlaySelection, type MediaIntent } from './bridge';
import { useCarPlayBrowse, useCarPlayQueue } from './browse';
import { playMedia } from './siri';
import { loadingPage, signInMessage, type BrowseRoute } from './templates';

type Screen = { id: string; route: BrowseRoute | null };
const queueId = 'up-next';
const noScreens: Screen[] = [];

/** One controller for the car surface and Siri. The phone, CarPlay and Siri use the same playback runtime. */
export function CarPlayController() {
  return CarPlay ? <ConnectedController /> : null;
}

function ConnectedController() {
  const native = CarPlay!;
  const car = useCarPlayState();
  const { state } = useAccount();
  const account = useAccountKey();
  const api = useSignedInApi();
  const { offline, setMediaRequest } = useRealtime();
  const viewer = useViewer();
  const { canPlay } = useAvailability();
  const { setLiked } = useLibraryActions();
  const likes = useLikeChanges();
  const trackStore = useTrackStore();
  const { actions, connection, current, queue, session, track, thisDeviceId } = usePlaybackState();

  const [screens, setScreens] = useState<Screen[]>(noScreens);
  const screensRef = useRef(screens);
  const navigate = (next: Screen[]) => {
    screensRef.current = next;
    setScreens(next);
  };
  const top = screens.at(-1);
  const enabled = car.connected;
  const currentTrackId = session.activeDeviceId === thisDeviceId ? current?.trackId : undefined;
  const { tabs, page } = useCarPlayBrowse({ enabled, limits: car, route: top?.route ?? null, currentTrackId });
  const [queueOffset, setQueueOffset] = useState(0);
  const upcoming = useMemo(() => session.autoplay ? [...queue.queue, ...queue.autoplayQueue] : queue.queue,
    [queue.queue, queue.autoplayQueue, session.autoplay]);
  const upNext = useCarPlayQueue({
    enabled: enabled && top?.id === queueId, limits: car, current, entries: upcoming,
    offset: queueOffset, onPage: setQueueOffset,
  });
  const pages = [...tabs, ...(page ? [page] : []), ...(upNext ? [upNext] : [])];
  const favorite = favoriteState(track, likes);
  const albumId = current?.albumId ?? track?.album?.id;
  const artist = track?.artists[0];
  const nowPlaying = {
    shuffle: session.shuffle, repeat: session.repeat, liked: favorite.active, hasTrack: favorite.available,
    upNext: Boolean(current || upcoming.length), album: Boolean(albumId || artist),
  };

  const rootApplied = useRef<{ generation: number; account: string | null; json: string } | null>(null);
  useEffect(() => {
    if (!enabled) {
      rootApplied.current = null;
      navigate(noScreens);
      return;
    }
    const lists = tabs.map(tab => tab.list);
    const json = JSON.stringify(lists);
    const before = rootApplied.current;
    const reset = !before || before.generation !== car.generation || before.account !== account;
    if (!reset && before.json === json) return;
    if (reset) navigate(noScreens);
    const request = { generation: car.generation, account, json };
    rootApplied.current = request;
    void native.setRoot(lists, reset).then(ok => {
      if (!ok && rootApplied.current === request) rootApplied.current = null;
    }, () => {
      if (rootApplied.current === request) rootApplied.current = null;
    });
  }, [native, car.generation, enabled, account, tabs]);

  const visiblePage = top?.id === queueId ? upNext : page;
  const pageJson = visiblePage && JSON.stringify(visiblePage.list);
  useEffect(() => {
    if (enabled && pageJson) void native.update(JSON.parse(pageJson)).catch(() => undefined);
  }, [native, enabled, pageJson]);

  const { shuffle, repeat, liked, hasTrack, upNext: hasQueue, album } = nowPlaying;
  useEffect(() => {
    if (enabled) void native.setNowPlaying({ shuffle, repeat, liked, hasTrack, upNext: hasQueue, album }).catch(() => undefined);
  }, [native, enabled, car.generation, shuffle, repeat, liked, hasTrack, hasQueue, album]);

  const alerted = useRef<number | null>(null);
  useEffect(() => {
    if (!car.active || state.status === 'restoring' || state.status === 'signedIn' || alerted.current === car.generation) return;
    alerted.current = car.generation;
    void native.showAlert('Sign in on your iPhone', signInMessage).catch(() => undefined);
  }, [native, car.active, car.generation, state.status]);

  const live = useRef({ account, api, pages, actions, current, track, favorite, offline, viewer, canPlay, albumId, artist, connection });
  live.current = { account, api, pages, actions, current, track, favorite, offline, viewer, canPlay, albumId, artist, connection };
  useEffect(() => {
    let disposed = false;
    let selectionInFlight: CarPlaySelection | undefined;
    let visibleTemplate: string | undefined;
    const appear = native.addListener('onTemplateAppear', ({ templateId, stack, generation }) => {
      if (generation !== getCarPlayState().generation) return;
      visibleTemplate = templateId;
      const previous = screensRef.current;
      const next = previous.filter(screen => stack.includes(screen.id));
      if (next.length !== previous.length) navigate(next);
    });
    const open = async (route: BrowseRoute | null) => {
      const list = route ? loadingPage(route).list : { id: queueId, title: 'Up Next', sections: [], emptyTitle: 'Loading…' };
      const previous = screensRef.current;
      const existing = previous.findIndex(screen => screen.id === list.id);
      if (existing >= 0) {
        const rendered = live.current.pages.find(page => page.list.id === list.id);
        await native.push(rendered?.list ?? list);
        return;
      }
      if (!route) setQueueOffset(0);
      navigate([...previous, { id: list.id, route }]);
      try {
        if (!(await native.push(list))) {
          if (screensRef.current.at(-1)?.id === list.id) navigate(previous);
          return;
        }
        // The query can already have answered before the native push finished.
        const rendered = live.current.pages.find(page => page.list.id === list.id);
        if (rendered) await native.update(rendered.list);
      } catch (error) {
        if (screensRef.current.at(-1)?.id === list.id) navigate(previous);
        throw error;
      }
    };
    const select = async (event: CarPlaySelection) => {
      const { generation, requestId, templateId, itemId } = event;
      const { account, api, actions } = live.current;
      const valid = () => !disposed && getCarPlayState().connected && getCarPlayState().generation === generation && live.current.account === account;
      const stillVisible = () => valid() && (!visibleTemplate || visibleTemplate === templateId);
      const expires = Date.now() + 10_000;
      let releaseSelection: ReturnType<typeof setTimeout> | undefined;
      let playing = false;
      try {
        if (!valid() || selectionInFlight?.generation === generation) return;
        selectionInFlight = event;
        releaseSelection = setTimeout(() => {
          if (selectionInFlight === event) selectionInFlight = undefined;
        }, 10_000);
        if (templateId === 'now-playing') {
          const { albumId, artist, track, favorite } = live.current;
          switch (itemId) {
            case 'shuffle': return actions.toggleShuffle();
            case 'repeat': return actions.cycleRepeat();
            case 'like': if (track && favorite.available) setLiked('track', track.id, !favorite.active, track.title); return;
            case 'up-next': return await open(null);
            case 'album':
              if (albumId) return await open({ type: 'album', id: albumId, title: track?.album?.title ?? 'Album' });
              if (artist) return await open({ type: 'artist', id: artist.id, title: artist.name });
              return;
          }
        }

        const action = live.current.pages.find(page => page.list.id === templateId)?.actions[itemId];
        if (!action) return;
        const ready = () => stillVisible() && Date.now() < expires
          && (live.current.connection === 'online' || live.current.offline);
        if (action.type !== 'open' && action.type !== 'run' && !ready()) {
          if (stillVisible()) await native.showAlert('Connecting to playback', 'Try again in a moment.');
          return;
        }
        switch (action.type) {
          case 'open': return await open(action.route);
          case 'run': return await action.run();
          case 'play': {
            const tracks = action.loadTracks ? await action.loadTracks() : action.tracks;
            if (ready()) {
              trackStore.prime(tracks);
              playing = live.current.actions.playHere(tracks, action.options);
            }
            break;
          }
          case 'queue':
            playing = actions.playQueueEntryHere(action.entryId);
            break;
          case 'radio':
            if (api) {
              const radio = await api.radio.artist(action.artistId);
              if (ready() && !live.current.offline) playing = live.current.actions.playRadioHere(radio);
            }
            break;
        }
        if (!playing && stillVisible() && Date.now() < expires) await native.showAlert('Nothing to play', 'Choose a song that’s available on this iPhone.');
      } catch {
        if (stillVisible() && Date.now() < expires) await native.showAlert('Couldn’t complete that action', 'Check your server connection and try again.').catch(() => undefined);
      } finally {
        clearTimeout(releaseSelection);
        await native.finishSelection(requestId).catch(() => undefined);
        if (selectionInFlight === event) selectionInFlight = undefined;
      }
      if (playing && valid()) await native.showNowPlaying().catch(() => undefined);
    };
    const selection = native.addListener('onSelect', event => { void select(event); });
    return () => {
      disposed = true;
      selection.remove();
      appear.remove();
    };
  }, [native, setLiked, trackStore]);

  const [intents, setIntents] = useState<MediaIntent[]>([]);
  const intentOwners = useRef(new Map<string, string | null>());
  useEffect(() => {
    let mounted = true;
    const add = (intent: MediaIntent) => {
      if (intent.expiresAt <= Date.now() || intentOwners.current.has(intent.id)) return;
      intentOwners.current.set(intent.id, live.current.account);
      setIntents(current => [...current, intent]);
    };
    const subscription = native.addListener('onMediaIntent', add);
    void native.takeMediaIntents().then(pending => {
      if (mounted) pending.forEach(add);
    }).catch(() => undefined);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [native]);

  const intent = intents[0];
  const removeIntent = (id: string) => {
    intentOwners.current.delete(id);
    setIntents(current => current.filter(item => item.id !== id));
  };
  useEffect(() => {
    if (!intent) return;
    const timer = setTimeout(() => removeIntent(intent.id), Math.max(0, intent.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [intent]);
  useEffect(() => {
    setMediaRequest(Boolean(intent));
    return () => setMediaRequest(false);
  }, [intent, setMediaRequest]);
  const settled = state.status !== 'restoring' && (!api || Boolean(thisDeviceId && (connection === 'online' || offline)));
  useEffect(() => {
    if (!intent) return;
    const owner = intentOwners.current.get(intent.id);
    if (owner && owner !== account) {
      void native.completeMediaIntent(intent.id, false).catch(() => undefined);
      removeIntent(intent.id);
      return;
    }
    if (!settled) return;
    intentOwners.current.set(intent.id, account);
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && Date.now() < intent.expiresAt && live.current.account === account;
    if (!isCurrent()) return;
    const finish = (success: boolean) => {
      clearTimeout(timer);
      if (!isCurrent()) return;
      controller.abort();
      void native.completeMediaIntent(intent.id, success).catch(() => undefined);
      removeIntent(intent.id);
    };
    const timer = setTimeout(() => finish(false), Math.min(8_000, Math.max(0, intent.expiresAt - Date.now() - 250)));
    const { viewer, canPlay, actions, offline } = live.current;
    void (api ? playMedia(intent, {
      api, viewer, offline, actions, canPlay, isCurrent, signal: controller.signal, prime: tracks => trackStore.prime(tracks),
    })
      : Promise.resolve(false)).then(finish, () => finish(false));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [account, api, intent, native, settled, trackStore]);
  return null;
}
