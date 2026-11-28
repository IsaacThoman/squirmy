import type { PlaylistSummary } from '@squirmy/contracts';
import { useRouter } from 'expo-router';
import { ActivityIndicator } from 'react-native';
import { closeSheet } from '../closeSheet';
import { usePlaylist } from '../data/queries';
import { loadFailure } from '../data/errors';
import { SheetFrame, SheetNote } from '../SheetUI';
import { pageHref, useCurrentTab } from './links';
import { SmartPlaylistForm } from './SmartPlaylistScreen';

/**
 * The sheet that makes a smart playlist (no `id`), then opens it, or edits the one `id` names,
 * once it has loaded.
 */
export function SmartPlaylistSheet({ id }: { id?: string }) {
  const router = useRouter();
  const tab = useCurrentTab();
  const close = () => closeSheet(router);
  const opened = (playlist: PlaylistSummary) => {
    close();
    if (!id) router.navigate(pageHref(tab, 'playlist', playlist.id));
  };
  return id ? <EditSmartPlaylist id={id} onClose={close} onSaved={opened} /> : <SmartPlaylistForm onClose={close} onSaved={opened} />;
}

function EditSmartPlaylist({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: (playlist: PlaylistSummary) => void }) {
  const playlist = usePlaylist(id);
  if (playlist.data?.rules) return <SmartPlaylistForm playlist={playlist.data} onClose={onClose} onSaved={onSaved} />;
  return <SheetFrame title="Edit Smart Playlist" onClose={onClose}>
    {playlist.isError ? <SheetNote error>{`Couldn’t load this playlist. ${loadFailure(playlist.error).description}`}</SheetNote> : <ActivityIndicator />}
  </SheetFrame>;
}
