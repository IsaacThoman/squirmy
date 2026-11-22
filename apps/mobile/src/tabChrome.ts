import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform } from 'react-native';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

/** Whether the tabs are the system's floating glass bar, with the mini-player as its accessory. */
export function usesNativeTabs(): boolean {
  return Platform.OS === 'ios' && isLiquidGlassAvailable();
}

/**
 * The glass tab bar and the mini-player above it, measured from the top of the home
 * indicator's inset to the top of the mini-player. Neither grows with Dynamic Type: the tab
 * bar shows large labels in a popover instead, and the accessory has a fixed height.
 */
const nativeChromeHeight = 105;
/** Room left between a page's last row and the top of the mini-player. */
const clearance = 16;
/** How far above the mini-player the soft edge under the bars begins. */
const edgeLead = 20;
/** The floating mini-player and the opaque tab bar of older systems and Android. */
const fallbackInset = 155;

/**
 * What the tab bar and mini-player cover at the bottom of a page: `contentInset` is the
 * padding a scrolling page needs for its last row to clear them, `edgeHeight` the height of
 * the soft edge drawn under them.
 */
export function useTabChrome(): { contentInset: number; edgeHeight: number } {
  const insets = useSafeAreaInsets();
  if (!usesNativeTabs()) return { contentInset: fallbackInset, edgeHeight: 0 };
  // Inside a native tab the safe area already takes in the tab bar, so measure from the
  // screen's own inset, the home indicator's. The app is portrait only, so it holds.
  const bottom = initialWindowMetrics?.insets.bottom ?? insets.bottom;
  return { contentInset: bottom + nativeChromeHeight + clearance, edgeHeight: bottom + nativeChromeHeight + edgeLead };
}
