import type { PlaylistDetail, PlaylistSummary } from '@squirmy/contracts';
import { SheetFrame, SheetNote } from '../SheetUI';

/**
 * The rule editor is the iOS form (`SmartPlaylistScreen.ios.tsx`); elsewhere the sheet says
 * where smart playlists are made and edited.
 */
export function SmartPlaylistForm({ playlist, onClose }: {
  playlist?: PlaylistDetail; onClose: () => void; onSaved: (playlist: PlaylistSummary) => void;
}) {
  return <SheetFrame title={playlist ? 'Edit Smart Playlist' : 'New Smart Playlist'} onClose={onClose}>
    <SheetNote>Make and edit smart playlists in the web app. They play here like any other playlist.</SheetNote>
  </SheetFrame>;
}
