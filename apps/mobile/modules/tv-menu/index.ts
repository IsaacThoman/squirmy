import { requireNativeView } from 'expo';
import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

export type MenuAction = {
  id: string;
  title: string;
  subtitle?: string;
  /** An SF Symbol. */
  image?: string;
  destructive?: boolean;
  disabled?: boolean;
  checked?: boolean;
  children?: MenuAction[];
  /** Children shown in place, between separators, rather than as a submenu. */
  inline?: boolean;
};

export type TVMenuProps = ViewProps & {
  title?: string;
  actions: MenuAction[];
  onAction?: (event: NativeSyntheticEvent<{ id: string }>) => void;
};

let view: ComponentType<TVMenuProps> | null | undefined;

/** The native view, or null in a build without it. */
export function nativeTVMenu(): ComponentType<TVMenuProps> | null {
  if (view === undefined) {
    try {
      view = requireNativeView<TVMenuProps>('SquirmyTVMenu', 'TVMenuView');
    } catch {
      view = null;
    }
  }
  return view;
}

export type TVButtonProps = ViewProps & {
  title?: string;
  /** An SF Symbol, before the title, or alone in a round button. */
  systemImage?: string;
  /** Filled, for the main action beside quieter ones. */
  prominent?: boolean;
  /** The ink of the title and symbol while resting. */
  tint?: string;
  enabled?: boolean;
  /** Opened by a click instead of `onPress`. */
  actions?: MenuAction[];
  onPress?: () => void;
  onAction?: (event: NativeSyntheticEvent<{ id: string }>) => void;
};

let button: ComponentType<TVButtonProps> | null | undefined;

/** The system's own button, or null in a build without it. */
export function nativeTVButton(): ComponentType<TVButtonProps> | null {
  if (button === undefined) {
    try {
      button = requireNativeView<TVButtonProps>('SquirmyTVMenu', 'TVButtonView');
    } catch {
      button = null;
    }
  }
  return button;
}
