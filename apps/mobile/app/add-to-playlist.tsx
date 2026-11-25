import { useLocalSearchParams } from 'expo-router';
import { AddToPlaylistSheet } from '../src/SessionSheets';

export default function AddToPlaylistRoute() {
  const { trackId, albumId } = useLocalSearchParams<{ trackId: string; albumId?: string }>();
  return <AddToPlaylistSheet trackId={trackId} albumId={albumId} />;
}
export { SheetError as ErrorBoundary } from '../src/ScreenError';
