import { Link, type Href } from 'expo-router';
import type { ReactElement, ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Pushes `href` with the iOS zoom transition. The page grows out of the `ZoomSource` inside
 * `children` and shrinks back into it when it is dismissed. `children` is one button element,
 * and the link hands it `onPress`. Elsewhere this is an ordinary push.
 */
export function ZoomLink({ href, children }: { href: Href; children: ReactElement }) {
  return <Link href={href} push asChild>{children}</Link>;
}

/** The view a `ZoomLink`'s page grows out of. It must sit inside that `ZoomLink`. */
export function ZoomSource({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  // The zoom source hands its child to a Slot, which drops style arrays.
  return <Link.AppleZoom><View collapsable={false} style={StyleSheet.flatten(style)}>{children}</View></Link.AppleZoom>;
}

/**
 * Where the zoom source lands on the opened page. The transition lines the source up with this
 * view, so the artwork carries straight from the tile into the header and back.
 */
export function ZoomTarget({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return <Link.AppleZoomTarget><View collapsable={false} style={style}>{children}</View></Link.AppleZoomTarget>;
}
