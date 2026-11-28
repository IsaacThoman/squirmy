import { ApiError, streamUrl } from '@squirmy/client-core';
import type { ShareExpiry, ShareKind } from '@squirmy/contracts';
import { Alert, Platform, Share } from 'react-native';
import { useServerUrl, useSharingEnabled, useSignedInApi, type Api } from '../account/AccountProvider';
import { useRealtime } from '../data/realtime';

/** What a public link is made for: an album, a playlist, or a song with the album it is shown from. */
export type ShareLinkTarget = { kind: ShareKind; id: string; albumId?: string | null; title: string };

/** The web dialog's choices, in its words. */
export const shareExpiryChoices: { label: string; expiresIn: ShareExpiry }[] = [
  { label: '1 day', expiresIn: '1d' },
  { label: '7 days', expiresIn: '7d' },
  { label: '30 days', expiresIn: '30d' },
  { label: 'Until I revoke it', expiresIn: 'never' },
];

/**
 * Share from a menu, as web's Share…: asks how long the link should work, makes it on the
 * server, then opens the share sheet with it. The link is shown only there; the server keeps
 * only its hash, and the web app's settings list and revoke it.
 */
export function shareLink(api: Api, serverUrl: string, target: ShareLinkTarget) {
  const make = async (expiresIn: ShareExpiry) => {
    try {
      const link = await api.share.create({ kind: target.kind, id: target.id, albumId: target.albumId ?? null, expiresIn });
      const url = streamUrl(serverUrl, { url: link.url ?? '' });
      // iOS shares the title beside the link; Android has only the message.
      await Share.share(Platform.OS === 'ios' ? { url, message: target.title } : { message: url });
    } catch (error) {
      Alert.alert('Couldn’t make a share link', error instanceof ApiError && error.status !== 0 ? error.message : 'Check your connection and try again.');
    }
  };
  Alert.alert(
    `Share “${target.title}”`,
    'Anyone with the link can see it and listen, as this server allows, without an account. How long should it work?',
    [...shareExpiryChoices.map(choice => ({ text: choice.label, onPress: () => void make(choice.expiresIn) })), { text: 'Cancel', style: 'cancel' as const }],
  );
}

/**
 * Share on a page: a public link while the server allows them and the app is online, else
 * the item's name, as before links existed. `text` is that name.
 */
export function useShareItem() {
  const api = useSignedInApi();
  const serverUrl = useServerUrl();
  const sharing = useSharingEnabled();
  const { offline } = useRealtime();
  return (target: ShareLinkTarget, text: string) => {
    if (api && sharing && !offline) return shareLink(api, serverUrl, target);
    void Share.share({ message: text }).catch(() => Alert.alert('Sharing unavailable'));
  };
}
