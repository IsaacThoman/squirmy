import { useLocalSearchParams } from 'expo-router';
import { NamePlaylistSheet } from '../src/SessionSheets';

export default function NamePlaylistRoute() {
  const { mode, id, name, trackId, albumId } = useLocalSearchParams<{ mode: 'create' | 'rename'; id?: string; name?: string; trackId?: string; albumId?: string }>();
  return <NamePlaylistSheet mode={mode} id={id} name={name} trackId={trackId} albumId={albumId} />;
}
export { SheetError as ErrorBoundary } from '../src/ScreenError';
