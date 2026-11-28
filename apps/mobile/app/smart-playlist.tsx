import { useLocalSearchParams } from 'expo-router';
import { SmartPlaylistSheet } from '../src/library/SmartPlaylistSheet';

export default function SmartPlaylistRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <SmartPlaylistSheet id={id || undefined} />;
}
export { SheetError as ErrorBoundary } from '../src/ScreenError';
