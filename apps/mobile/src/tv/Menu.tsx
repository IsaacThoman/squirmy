import type { ReactNode } from 'react';
import { nativeTVMenu, type MenuAction } from '../../modules/tv-menu';

/** The native view, resolved once; null in a build without it. */
const NativeMenu = nativeTVMenu();

export type { MenuAction };

type Props = {
  actions: MenuAction[];
  onAction: (id: string) => void;
  title?: string;
  children: ReactNode;
};

/**
 * The system's context menu for the focusable thing inside: hold the click on it and the glass
 * menu opens beside it, as across tvOS. Without the native view (an older build) the children
 * show alone.
 */
export function Menu({ actions, onAction, title, children }: Props) {
  if (!NativeMenu) return <>{children}</>;
  return <NativeMenu actions={actions} title={title} onAction={event => onAction(event.nativeEvent.id)}>{children}</NativeMenu>;
}
