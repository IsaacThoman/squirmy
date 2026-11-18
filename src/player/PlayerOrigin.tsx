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
  fromPull: boolean;
};

type MiniPull =
  | { phase: 'dragging' | 'cancel'; distance: number }
  | { phase: 'open'; distance: number; velocity: number };

export function miniCoverSize(compact: boolean, native: boolean) {
  return compact ? 28 : native ? 36 : 42;
}

const OriginContext = createContext<{
  origin: RefObject<PlayerOrigin | null>;
  accessoryInPlayer: SharedValue<boolean>;
  miniPull: SharedValue<MiniPull | null>;
} | null>(null);

export function PlayerOriginProvider({ children }: PropsWithChildren) {
  const origin = useRef<PlayerOrigin | null>(null);
  const accessoryInPlayer = useSharedValue(false);
  const miniPull = useSharedValue<MiniPull | null>(null);
  const value = useMemo(() => ({ origin, accessoryInPlayer, miniPull }), [accessoryInPlayer, miniPull]);
  return <OriginContext.Provider value={value}>{children}</OriginContext.Provider>;
}

export function usePlayerOrigin() {
  const value = useContext(OriginContext);
  if (!value) throw new Error('PlayerOriginProvider is missing');
  return value;
}
