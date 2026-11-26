import { requireNativeView } from 'expo';
import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

export type TVSearchProps = ViewProps & {
  placeholder?: string;
  onChangeText?: (event: NativeSyntheticEvent<{ text: string }>) => void;
  onSubmit?: (event: NativeSyntheticEvent<{ text: string }>) => void;
};

let view: ComponentType<TVSearchProps> | null | undefined;

/** The native view, or null in a build without it. */
export function nativeTVSearch(): ComponentType<TVSearchProps> | null {
  if (view === undefined) {
    try {
      view = requireNativeView<TVSearchProps>('SquirmyTVSearch');
    } catch {
      view = null;
    }
  }
  return view;
}
