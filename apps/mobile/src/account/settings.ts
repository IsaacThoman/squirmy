import {
  isLastFmReturn, queryKeys, type NormalizationMode, type ScrobbleService, type ScrobblingStatus, type StreamQuality, type UpdateUserSettings,
} from '@squirmy/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import { useState } from 'react';
import { Alert } from 'react-native';
import { loadFailure } from '../data/errors';
import { useScrobbling, useUpdateSettings, useUserSettings } from '../data/queries';
import { announce } from '../inlineFeedback';
import { useAccount, useSignedInApi } from './AccountProvider';
import { disconnectConfirmation, lastFmReturnFailure } from './scrobbling';

export { lastFmNote, scrobbleDetail, scrobbleFooter } from './scrobbling';

export const normalizationOptions: readonly { value: NormalizationMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'track', label: 'Per Song' },
  { value: 'album', label: 'Per Album' },
  { value: 'off', label: 'Off' },
];

export const qualityOptions: readonly { value: StreamQuality; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'high', label: 'High' },
  { value: 'data_saver', label: 'Data Saver' },
];

export const normalizationNote = 'Plays every song at a similar volume. Automatic keeps an album’s own dynamics when you play it in order. Squirmy only turns songs down, never up.';
export const lastFmAdminNote = 'Last.fm scrobbling isn’t set up on this server. As an admin, you can add a Last.fm API key in the web app’s server settings.';

/** Where a ListenBrainz user finds the token to paste. */
export const listenBrainzSettingsUrl = 'https://listenbrainz.org/settings/';

/**
 * Loaded when it is used: the Apple TV build has no web browser module, and its settings screen
 * uses the rest of this file.
 */
const webBrowser = () => import('expo-web-browser');

export function openListenBrainzSettings() {
  void webBrowser().then(browser => browser.openBrowserAsync(listenBrainzSettingsUrl));
}

/** The library's switch (`libraryIncludesServerMusic`), worded as on web. */
export const serverMusicLabel = 'Show all of this server’s music in your library';
export const serverMusicNote = 'Your library is what you heart, with the music you upload. This adds every album on this server too. Everything on this server is on Home either way, and plays for everyone.';

/** Explicit content (`allowExplicit`), worded as on web. An admin can turn it off for the user and keep it off. */
export const explicitLabel = 'Allow explicit content';
export const explicitNote = 'Turn it off to gray out songs marked explicit and keep them out of search, radio and your queue. A clean version plays instead when there is one.';
export const explicitRestrictedNote = 'An admin turned explicit content off for your account. Ask them to turn it back on.';

export const shareNowPlayingLabel = 'Share what I’m listening to with other users on this server';
export const shareNowPlayingNote = 'Lets other users see your current song in Subsonic apps.';

export const qualityNote = 'Original streams the file as it is when this device can play it. High is AAC at 256 kbps. Data Saver uses the least data.';
/** With the native engine, which gets Opus where the device decodes it. */
export const nativeQualityNote = 'Original streams the file as it is when this device can play it. High is Opus at 192 kbps, or AAC at 256 kbps where Opus can’t play. Data Saver uses the least data.';

/** What the settings screen says under a section's controls when the server or the service refused. */
export const scrobbleFailures = {
  token: 'ListenBrainz didn’t accept that token.',
  disconnect: 'Couldn’t disconnect. Try again.',
  lastFm: 'Couldn’t reach Last.fm. Try again.',
} as const;

/** A refused settings change, said under the controls that made it. */
export function saveFailure(error: unknown): string {
  return `Couldn’t save that change. ${loadFailure(error).description}`;
}

/** Where a settings change's refusal appears. */
export type SettingsSection = 'playback' | 'library' | 'privacy' | ScrobbleService['target'];

/** The scrobbling switch in `UserSettings` for each service. */
const switchFor = { listenbrainz: 'scrobbleListenBrainz', lastfm: 'scrobbleLastFm' } as const satisfies Record<ScrobbleService['target'], keyof UpdateUserSettings>;

/**
 * A query's failure to load, for the screen to show with a way to try again. A request waiting
 * for the connection (paused) has failed for now, too. Null while it has data or is loading.
 */
function failureOf(query: { data?: unknown; isError: boolean; isPending: boolean; fetchStatus: string; error: unknown; refetch: () => unknown }) {
  if (query.data !== undefined || !(query.isError || (query.isPending && query.fetchStatus === 'paused'))) return null;
  const failure = loadFailure(query.error);
  return { connection: failure.connection, description: failure.description, retry: failure.retry ? () => void query.refetch() : null };
}

/**
 * The signed-in user's settings and scrobbling connections, with the changes the settings
 * screen makes. A refused change is kept per section (`errors`), for the screen to show under
 * that section's controls until the next try there.
 */
export function useSettingsScreen() {
  const api = useSignedInApi();
  const { state } = useAccount();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<Partial<Record<SettingsSection, string>>>({});
  const setError = (section: SettingsSection, message: string | null) => {
    setErrors(current => ({ ...current, [section]: message ?? undefined }));
    if (message) announce(message);
  };
  const settings = useUserSettings();
  const scrobbling = useScrobbling();
  const update = useUpdateSettings();
  const setStatus = (status: ScrobblingStatus) => queryClient.setQueryData(queryKeys.scrobbling(), status);
  const refreshStatus = () => queryClient.invalidateQueries({ queryKey: queryKeys.scrobbling() });
  const service = (target: ScrobbleService['target']) => scrobbling.data?.services.find(item => item.target === target);

  const connectListenBrainz = useMutation({
    mutationFn: (token: string) => api!.scrobble.connectListenBrainz({ token }),
    onMutate: () => setError('listenbrainz', null),
    onSuccess: setStatus,
    onError: () => setError('listenbrainz', scrobbleFailures.token),
  });
  const disconnect = useMutation({
    mutationFn: (target: ScrobbleService['target']) => target === 'listenbrainz' ? api!.scrobble.disconnectListenBrainz() : api!.scrobble.disconnectLastFm(),
    onMutate: target => setError(target, null),
    onSuccess: setStatus,
    onError: (_error, target) => setError(target, scrobbleFailures.disconnect),
  });
  const connectLastFm = useMutation({
    mutationFn: async () => {
      const WebBrowser = await webBrowser();
      const returnTo = Linking.createURL('settings');
      // The server finishes the connection, then sends the browser back to the app, which closes
      // it and says how it went. A build whose scheme the server doesn't know (Expo Go) can only
      // open the approval and look again when the browser is closed.
      if (!isLastFmReturn(returnTo)) {
        await WebBrowser.openBrowserAsync((await api!.scrobble.startLastFm()).url);
        return null;
      }
      const { url } = await api!.scrobble.startLastFm({ returnTo });
      const result = await WebBrowser.openAuthSessionAsync(url, returnTo);
      return result.type === 'success' ? lastFmReturnFailure(result.url) : null;
    },
    onMutate: () => setError('lastfm', null),
    onSuccess: failure => { if (failure) setError('lastfm', failure); },
    onError: () => setError('lastfm', scrobbleFailures.lastFm),
    onSettled: refreshStatus,
  });

  /** Saves a change, shown at once; a refusal puts it back and says so under `section`'s controls. */
  const save = (section: SettingsSection, change: UpdateUserSettings, onSettled?: () => unknown) => {
    setError(section, null);
    update.mutate(change, { onError: error => setError(section, saveFailure(error)), onSettled });
  };

  return {
    isAdmin: state.status === 'signedIn' && state.user.role === 'admin',
    settings: settings.data,
    /** Why the settings didn't load, with a way to try again. */
    settingsFailure: failureOf(settings),
    /** Why the scrobbling connections didn't load, with a way to try again. */
    scrobblingFailure: failureOf(scrobbling),
    update: (change: UpdateUserSettings) => save('playback', change),
    /** Whether the library holds all of the server's music, not only what the user saved. */
    setLibraryIncludesServerMusic: (libraryIncludesServerMusic: boolean) => save('library', { libraryIncludesServerMusic }),
    setShareNowPlaying: (shareNowPlaying: boolean) => save('privacy', { shareNowPlaying }),
    /** An admin turned explicit content off for this account; the switch is shown off and cannot be changed. */
    explicitRestricted: state.status === 'signedIn' && (state.user.explicitRestricted ?? false),
    /** Whether explicit songs play: the user's own switch, under an admin's restriction. */
    allowExplicit: state.status === 'signedIn' ? (state.user.explicitRestricted ? false : settings.data?.allowExplicit ?? true) : true,
    setAllowExplicit: (allowExplicit: boolean) => save('library', { allowExplicit }),
    listenBrainz: service('listenbrainz'),
    lastFm: service('lastfm'),
    /** The user's switch for a service; the settings change at once, the status when the server answers. */
    scrobbleEnabled: (service: ScrobbleService) => settings.data?.[switchFor[service.target]] ?? service.enabled,
    setScrobbling: (target: ScrobbleService['target'], enabled: boolean) => save(target, { [switchFor[target]]: enabled }, refreshStatus),
    connectListenBrainz: connectListenBrainz.mutate,
    connectingListenBrainz: connectListenBrainz.isPending,
    connectLastFm: () => connectLastFm.mutate(),
    /** Asks first, as plays still waiting to be sent are dropped with the connection. */
    disconnect: (target: ScrobbleService['target']) => {
      const { title, message } = disconnectConfirmation(target);
      void Haptics.selectionAsync();
      Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: () => disconnect.mutate(target) },
      ]);
    },
    /** What the last try in each section was refused with, shown under its controls. */
    errors,
  };
}
