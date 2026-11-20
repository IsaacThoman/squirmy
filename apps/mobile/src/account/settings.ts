import { queryKeys, type NormalizationMode, type ScrobbleService, type ScrobblingStatus, type StreamQuality } from '@squirmy/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useScrobbling, useUpdateSettings, useUserSettings } from '../data/queries';
import { useNotice } from '../Notice';
import { useSignedInApi } from './AccountProvider';

export const normalizationOptions: readonly { value: NormalizationMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'track', label: 'Track' },
  { value: 'album', label: 'Album' },
  { value: 'off', label: 'Off' },
];

export const qualityOptions: readonly { value: StreamQuality; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'high', label: 'High' },
  { value: 'data_saver', label: 'Data Saver' },
];

export const normalizationNote = 'Plays every song at a similar volume. Automatic keeps an album’s own dynamics when you play it in order. Squirmy only turns songs down, never up.';
export const qualityNote = 'Original streams the file as it is when this device can play it. High is AAC at 256 kbps. Data Saver uses the least data.';

/** A line about a scrobbling service: who it is connected as, or what is wrong. */
export function scrobbleDetail(service: ScrobbleService): string {
  if (!service.connected) return service.available ? 'Not connected' : 'Not set up on this server';
  if (service.needsAttention) return `${service.account ?? 'Your account'} needs to be connected again`;
  if (service.lastError) return service.lastError;
  const queued = service.pending ? ` · ${service.pending} waiting` : '';
  return `Connected as ${service.account ?? 'you'}${queued}`;
}

/** The signed-in user's settings and scrobbling connections, with the changes the settings screen makes. */
export function useSettingsScreen() {
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  const notify = useNotice();
  const settings = useUserSettings();
  const scrobbling = useScrobbling();
  const update = useUpdateSettings();
  const setStatus = (status: ScrobblingStatus) => queryClient.setQueryData(queryKeys.scrobbling(), status);
  const service = (target: ScrobbleService['target']) => scrobbling.data?.services.find(item => item.target === target);

  const connectListenBrainz = useMutation({
    mutationFn: (token: string) => api!.scrobble.connectListenBrainz({ token }),
    onSuccess: setStatus,
    onError: () => notify('ListenBrainz didn’t accept that token.'),
  });
  const disconnect = useMutation({
    mutationFn: (target: ScrobbleService['target']) => target === 'listenbrainz' ? api!.scrobble.disconnectListenBrainz() : api!.scrobble.disconnectLastFm(),
    onSuccess: setStatus,
    onError: () => notify('Couldn’t disconnect. Try again.'),
  });
  const connectLastFm = useMutation({
    mutationFn: async () => {
      const { url } = await api!.scrobble.startLastFm();
      // The server finishes the connection; the browser returns here when it is closed.
      await WebBrowser.openBrowserAsync(url);
      await queryClient.invalidateQueries({ queryKey: queryKeys.scrobbling() });
    },
    onError: () => notify('Couldn’t reach Last.fm. Try again.'),
  });

  return {
    settings: settings.data,
    update: update.mutate,
    listenBrainz: service('listenbrainz'),
    lastFm: service('lastfm'),
    connectListenBrainz: connectListenBrainz.mutate,
    connectingListenBrainz: connectListenBrainz.isPending,
    connectLastFm: () => connectLastFm.mutate(),
    disconnect: disconnect.mutate,
  };
}
