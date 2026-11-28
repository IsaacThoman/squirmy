import { useLocalSearchParams } from 'expo-router';
import { TrackCreditsSheet } from '../src/SessionSheets';

export default function TrackCreditsRoute() {
  const { id, albumId } = useLocalSearchParams<{ id: string; albumId?: string }>();
  return <TrackCreditsSheet id={id} albumId={albumId} />;
}
export { SheetError as ErrorBoundary } from '../src/ScreenError';
