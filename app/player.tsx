import { useLocalSearchParams, useRouter } from 'expo-router';
import Player from '../src/Player';
import { usePlayerOrigin } from '../src/player/PlayerOrigin';

export default function PlayerRoute() {
  const router = useRouter();
  const { page, fromMini } = useLocalSearchParams<{ page?: string; fromMini?: string }>();
  const { origin } = usePlayerOrigin();
  return <Player
    origin={fromMini === '1' ? origin.current : null}
    initialPage={page === 'queue' || page === 'lyrics' ? page : 'player'}
    onClose={() => router.canGoBack() ? router.back() : router.replace('/')}
    onDevices={() => router.push('/devices')}
    onTrackMenu={(id) => router.push({ pathname: '/track-actions', params: { id } })}
  />;
}
