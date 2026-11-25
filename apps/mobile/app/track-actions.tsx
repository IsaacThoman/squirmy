import { useLocalSearchParams } from 'expo-router';
import { TrackActionSheet } from '../src/SessionSheets';

export default function TrackActionsRoute() {
  const { id, albumId, playlistId, itemId } = useLocalSearchParams<{ id: string; albumId?: string; playlistId?: string; itemId?: string }>();
  return <TrackActionSheet id={id} albumId={albumId} playlistId={playlistId} itemId={itemId} />;
}
export { SheetError as ErrorBoundary } from '../src/ScreenError';
