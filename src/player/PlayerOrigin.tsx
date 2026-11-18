import { createContext, useContext, useMemo, useRef, type PropsWithChildren, type RefObject } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

export type PlayerOrigin = {
  x: number;
  y: number;
  width: number;
  height: number;
  artworkSize: number;
  native: boolean;
  compact: boolean;
};

const OriginContext = createContext<{
  origin: RefObject<PlayerOrigin | null>;
  coverInPlayer: SharedValue<boolean>;
} | null>(null);

export function PlayerOriginProvider({ children }: PropsWithChildren) {
  const origin = useRef<PlayerOrigin | null>(null);
  const coverInPlayer = useSharedValue(false);
  const value = useMemo(() => ({ origin, coverInPlayer }), [coverInPlayer]);
  return <OriginContext.Provider value={value}>{children}</OriginContext.Provider>;
}

export function usePlayerOrigin() {
  const value = useContext(OriginContext);
  if (!value) throw new Error('PlayerOriginProvider is missing');
  return value;
}
