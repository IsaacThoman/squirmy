import { useEffect, useRef } from 'react';
import { BackHandler, TVEventControl } from 'react-native';
import { useSidebarChrome } from '../Sidebar';

/** One press, however many times it is reported. */
const pressGapMs = 300;

/**
 * While `active`, the remote's Menu button calls `onMenu` instead of what Menu does on a tab's
 * first page (open the sidebar), as Menu closes an open panel before it leaves a screen in the
 * system's apps. Hold it only while there is something to close: the rest of the time Menu is
 * the sidebar's. In the tabs the sidebar keeps the Menu key for the app meanwhile and this only
 * takes the press; outside them (the devices panel over the tabs) this takes the key too.
 */
export function useMenuKey(active: boolean, onMenu: () => void) {
  const sidebar = useSidebarChrome();
  const latest = useRef(onMenu);
  latest.current = onMenu;
  useEffect(() => {
    if (!active) return;
    sidebar?.setMenuOwner(true);
    // Outside the tabs no sidebar holds the key: take it while here.
    if (!sidebar) TVEventControl.enableTVMenuKey();
    let last = 0;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const now = Date.now();
      if (now - last >= pressGapMs) latest.current();
      last = now;
      return true;
    });
    return () => {
      subscription.remove();
      sidebar?.setMenuOwner(false);
      if (!sidebar) TVEventControl.disableTVMenuKey();
    };
  }, [active, sidebar]);
}
