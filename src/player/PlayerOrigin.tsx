import { createContext, useContext, useRef, type PropsWithChildren, type RefObject } from 'react';

export type PlayerOrigin = {
  x: number;
  y: number;
  width: number;
  height: number;
  artworkSize: number;
  native: boolean;
  compact: boolean;
};

const OriginContext = createContext<RefObject<PlayerOrigin | null> | null>(null);

export function PlayerOriginProvider({ children }: PropsWithChildren) {
  const origin = useRef<PlayerOrigin | null>(null);
  return <OriginContext.Provider value={origin}>{children}</OriginContext.Provider>;
}

export function usePlayerOrigin() {
  const origin = useContext(OriginContext);
  if (!origin) throw new Error('PlayerOriginProvider is missing');
  return origin;
}
