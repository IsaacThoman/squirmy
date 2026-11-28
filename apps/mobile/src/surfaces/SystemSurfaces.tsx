import { ApiError } from '@squirmy/client-core';
import { queryKeys, type HomeResponse } from '@squirmy/contracts';
import { skipToken, useQuery } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { router, useRootNavigationState } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { scheduleOnUI } from 'react-native-worklets';
import AppIntents, { type IntentRequest } from '../../modules/app-intents';
import { useAccount, useServerUrl, useSignedInApi } from '../account/AccountProvider';
import { useTrackStore } from '../data/library';
import { useRealtime } from '../data/realtime';
import { useAvailability, useDownloadManager, useViewer } from '../downloads/DownloadsProvider';
import { pageHref } from '../library/links';
import { usePlaybackState, useSessionRuntime } from '../playback';
import { present, settle, usePlayerTransition } from '../player/transition';
import { useStreamingCache } from '../streamingCache/context';
import { nextDownloadActivity, type DownloadActivity } from './downloadActivity';
import { donationFor, IntentRefusal, intentText, runIntent, type IntentDeps } from './intents';
import { widgetLink, type WidgetLink } from './links';
import { snapshotKey, surfaceSnapshot } from './snapshot';

type Native = NonNullable<typeof AppIntents>;

/** How long a request waits for the account and the session client of an app launched for it. */
const startWaitMs = 10_000;
/** How long an answer waits for a command to reach the server, and for a play to sound. */
const commandWaitMs = 6000;
const playbackWaitMs = 12_000;
/** Widgets are written once the session has been still this long. */
const writeDelayMs = 400;

/**
 * Squirmy outside the app, on iOS: answers Siri, Shortcuts and the widgets' buttons, writes
 * what the widgets show, tells Siri what was played, keeps the downloads Live Activity, and
 * follows the widgets' links. Renders nothing.
 */
export function SystemSurfaces() {
  return AppIntents ? <Surfaces native={AppIntents} /> : null;
}

function Surfaces({ native }: { native: Native }) {
  const { state } = useAccount();
  const api = useSignedInApi();
  const serverUrl = useServerUrl();
  const { offline, holdOpen } = useRealtime();
  const viewer = useViewer();
  const { canPlay } = useAvailability();
  const tracks = useTrackStore();
  const runtime = useSessionRuntime();
  const playback = usePlaybackState();
  const downloads = useDownloadManager();
  const cache = useStreamingCache();
  const home = useQuery<HomeResponse>({ queryKey: queryKeys.home(), queryFn: skipToken }).data;
  const { motion, close } = usePlayerTransition();

  // Requests read the app as it is when they run, not as it was when they arrived.
  const live = useRef({ state, api, serverUrl, offline, viewer, canPlay, tracks, runtime, playback });
  live.current = { state, api, serverUrl, offline, viewer, canPlay, tracks, runtime, playback };
  const [waiters] = useState(() => new Waiters());
  useEffect(() => waiters.notify());

  useEffect(() => {
    const answer = async ({ id, action, payload }: IntentRequest) => {
      const release = holdOpen();
      try {
        // An app launched for this request is still restoring the account, then the session.
        await waiters.until(() => live.current.state.status !== 'restoring', startWaitMs);
        if (live.current.state.status !== 'signedIn') throw new IntentRefusal(intentText.signedOut);
        const lookup = action === 'search' || action === 'lookup';
        if (!lookup) await waiters.until(() => live.current.runtime !== null, startWaitMs);
        const deps = intentDeps(live.current);
        const session = live.current.runtime;
        if (!lookup && !session) throw new IntentRefusal(intentText.offline);
        const outcome = await runIntent(action, payload, deps);
        if (outcome.wait !== 'none' && session) {
          await session.settled(outcome.wait, outcome.wait === 'playback' ? playbackWaitMs : commandWaitMs);
          // iOS reloads a widget once its button's intent is answered: it should find the change.
          await writeWidgets.current();
        }
        native.respond(id, outcome.result, null);
      } catch (error) {
        native.respond(id, null, refusal(error));
      } finally {
        release();
      }
    };
    const subscription = native.addListener('onRequest', request => void answer(request));
    native.setListening(true);
    return () => {
      native.setListening(false);
      subscription.remove();
    };
  }, [holdOpen, native, waiters]);

  // The widgets: written when what they show changes, Home's Jump back in included.
  const { session, track, remote, output } = playback;
  const signedIn = state.status === 'signedIn';
  const written = useRef<string | null>(null);
  const writeWidgets = useRef(async () => undefined as void);
  writeWidgets.current = async () => {
    if (state.status === 'restoring' || !native.hasWidgets) return;
    const built = surfaceSnapshot({
      signedIn, serverUrl, now: Date.now(), home,
      playing: {
        current: session.current, track, playing: session.playing,
        positionMs: live.current.runtime?.positionMs() ?? session.positionMs,
        device: remote ? output.name : null,
      },
      keptArtwork: artworkId => downloads?.artworkUri(artworkId) ?? cache?.artworkUri(artworkId) ?? null,
    });
    const key = snapshotKey(built);
    if (key === written.current) return;
    written.current = key;
    await native.setSnapshot(built.snapshot, built.artwork).catch(() => {
      written.current = null;
    });
  };
  useEffect(() => {
    const timer = setTimeout(() => void writeWidgets.current(), writeDelayMs);
    return () => clearTimeout(timer);
  }, [cache, downloads, home, native, output.name, remote, serverUrl, session, signedIn, state.status, track]);

  // What the session plays from, for Siri's suggestions; not what a relaunch restored.
  const context = session.context;
  const donated = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!signedIn) return;
    const item = donationFor(context);
    const key = item?.id ?? null;
    const first = donated.current === undefined;
    if (key === donated.current) return;
    donated.current = key;
    if (item && !first) native.donate(item).catch(() => undefined);
  }, [context, native, signedIn]);

  // The downloads Live Activity, from the manager's counts.
  const activity = useRef<DownloadActivity>(null);
  useEffect(() => {
    const send = (next: DownloadActivity) => {
      if (JSON.stringify(next?.state ?? null) === JSON.stringify(activity.current?.state ?? null)) return;
      activity.current = next;
      native.setDownloadActivity(next?.state ?? null).catch(() => undefined);
    };
    if (!downloads || !native.hasWidgets) return send(null);
    const update = () => send(nextDownloadActivity(activity.current, downloads.summary().collections.map(row => ({
      id: row.id, title: row.title, download: downloads.collection(row.id),
    }))));
    update();
    return downloads.subscribe(update);
  }, [downloads, native]);

  // Links from the widgets and the Live Activity, followed once the app is signed in and its
  // screens are up: a tile's page in the Home tab, Downloads, or Now Playing.
  const navigationReady = Boolean(useRootNavigationState()?.key);
  const pendingLink = useRef<WidgetLink | null>(null);
  const followLink = useRef(() => undefined as void);
  followLink.current = () => {
    const link = pendingLink.current;
    if (!link || !navigationReady || state.status === 'restoring') return;
    pendingLink.current = null;
    if (state.status !== 'signedIn') return;
    if (link.kind === 'nowPlaying') {
      if (!playback.current) return;
      scheduleOnUI(() => {
        'worklet';
        if (!motion.active.value) present(motion, null);
        settle(motion, true);
      });
      return;
    }
    // Now Playing would cover the page.
    close();
    router.push(link.kind === 'downloads' ? '/downloads' : pageHref('home', link.page, link.id));
  };
  useEffect(() => followLink.current(), [navigationReady, state.status]);
  useEffect(() => {
    const take = (url: string | null) => {
      const link = url ? widgetLink(url) : null;
      if (!link) return;
      pendingLink.current = link;
      followLink.current();
    };
    void Linking.getInitialURL().then(take);
    const subscription = Linking.addEventListener('url', ({ url }) => take(url));
    return () => subscription.remove();
  }, []);

  return null;
}

type Live = {
  api: IntentDeps['api'];
  serverUrl: string;
  offline: boolean;
  viewer: IntentDeps['viewer'];
  canPlay: IntentDeps['canPlay'];
  tracks: ReturnType<typeof useTrackStore>;
  playback: ReturnType<typeof usePlaybackState>;
};

function intentDeps({ api, serverUrl, offline, viewer, canPlay, tracks, playback }: Live): IntentDeps {
  return {
    api, serverUrl, offline, viewer, canPlay,
    currentTrackId: () => playback.current?.trackId ?? null,
    prime: list => tracks.prime(list),
    actions: playback.actions,
  };
}

/** What Siri says when a request fails. */
function refusal(error: unknown): string {
  if (error instanceof IntentRefusal) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 0) return intentText.offline;
    if (error.status === 404 || error.status === 410) return intentText.notFound;
  }
  return intentText.unknown;
}

/** Promises that resolve once a condition read on each render holds, or after a timeout. */
class Waiters {
  private waiting = new Set<() => void>();

  until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    if (condition()) return Promise.resolve(true);
    return new Promise(resolve => {
      const check = () => {
        if (!condition()) return;
        clearTimeout(timer);
        this.waiting.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiting.delete(check);
        resolve(false);
      }, timeoutMs);
      this.waiting.add(check);
    });
  }

  notify(): void {
    for (const check of [...this.waiting]) check();
  }
}
