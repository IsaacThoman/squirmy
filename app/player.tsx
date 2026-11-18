import { useLocalSearchParams, useRouter } from 'expo-router';
import Player from '../src/Player';

export default function PlayerRoute() {
  const router = useRouter();
  const { page } = useLocalSearchParams<{ page?: string }>();
  return <Player
    initialPage={page === 'queue' || page === 'lyrics' ? page : 'player'}
    onClose={() => router.canGoBack() ? router.back() : router.replace('/')}
    onDevices={() => router.push('/devices')}
    onTrackMenu={(id) => router.push({ pathname: '/track-actions', params: { id } })}
  />;
}
