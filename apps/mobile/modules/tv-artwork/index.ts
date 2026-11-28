import { requireNativeView } from 'expo';
import type { ComponentType } from 'react';
import type { ColorValue, ViewProps } from 'react-native';

export type TVArtworkProps = ViewProps & {
  uri?: string | null;
  cornerRadius?: number;
  circle?: boolean;
  /** Shown until the image loads, and behind images with transparency. */
  placeholderColor?: ColorValue;
  /** Lift, tilt and shine with the focus of the nearest focusable parent. On by default. */
  focusEffect?: boolean;
};

let view: ComponentType<TVArtworkProps> | null | undefined;

/** The native view, or null in a build without it. */
export function nativeTVArtwork(): ComponentType<TVArtworkProps> | null {
  if (view === undefined) {
    try {
      view = requireNativeView<TVArtworkProps>('SquirmyTVArtwork');
    } catch {
      view = null;
    }
  }
  return view;
}
