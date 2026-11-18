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

export function miniCoverSize(compact: boolean, native: boolean) {
  return compact ? 28 : native ? 36 : 42;
}

const OriginContext = createContext<{
  origin: RefObject<PlayerOrigin | null>;
  accessoryInPlayer: SharedValue<boolean>;
} | null>(null);

export function PlayerOriginProvider({ children }: PropsWithChildren) {
  const origin = useRef<PlayerOrigin | null>(null);
  const accessoryInPlayer = useSharedValue(false);
  const value = useMemo(() => ({ origin, accessoryInPlayer }), [accessoryInPlayer]);
  return <OriginContext.Provider value={value}>{children}</OriginContext.Provider>;
}

export function usePlayerOrigin() {
  const value = useContext(OriginContext);
  if (!value) throw new Error('PlayerOriginProvider is missing');
  return value;
}
