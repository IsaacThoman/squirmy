import { useLocalSearchParams } from 'expo-router';
import { TrackActionSheet } from '../src/SessionSheets';

export default function TrackActionsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TrackActionSheet id={id} />;
}
