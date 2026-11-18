import { useRouter } from 'expo-router';
import { useRef, type ComponentRef } from 'react';
import type { View } from 'react-native';
import { MiniPlayerContent, type MiniPlayerContentProps } from './player/MiniPlayerContent';
import { miniCoverSize, usePlayerOrigin } from './player/PlayerOrigin';

export { MiniPlayerContent };

type BubbleView = ComponentRef<typeof View>;

export function MiniPlayer({ compact = false, native = false }: Pick<MiniPlayerContentProps, 'compact' | 'native'>) {
  const router = useRouter();
  const { origin } = usePlayerOrigin();
  const bubble = useRef<BubbleView>(null);
  const opening = useRef(false);

  const open = () => {
    if (opening.current || !bubble.current) return;
    opening.current = true;
    bubble.current.measureInWindow((x, y, width, height) => {
      opening.current = false;
      origin.current = width > 0 && height > 0
        ? { x, y, width, height, compact, native, artworkSize: miniCoverSize(compact, native) }
        : null;
      router.push({ pathname: '/player', params: { fromMini: '1' } });
    });
  };

  return <MiniPlayerContent compact={compact} native={native} containerRef={bubble}
    onOpen={open} onDevices={() => router.push('/devices')} />;
}
