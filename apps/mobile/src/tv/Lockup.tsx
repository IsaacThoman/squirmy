import type { Artwork as ArtworkInfo } from '@squirmy/contracts';
import { memo, useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Artwork } from './Artwork';
import { Focusable } from './Focusable';
import { colors, tv, type } from './theme';

export type LockupProps = {
  artwork: ArtworkInfo | null | undefined;
  title: string;
  subtitle?: string;
  /** Artists are round, and their names centred under them. */
  circle?: boolean;
  size?: number;
  /** For a cover without artwork: its icon and the color behind it. */
  icon?: string;
  color?: string;
  /** Music that does not play: faded, still selectable. */
  dim?: boolean;
  /** A small badge after the title, such as the explicit mark. */
  badge?: string;
  onPress: () => void;
  onLongPress?: () => void;
  hasTVPreferredFocus?: boolean;
  onFocus?: () => void;
};

/**
 * A cover with its title and subtitle under it, the TV's tile. Focus lifts the cover with the
 * system's focus effect and moves the words down out of its way, as the system's lockups do.
 */
export const Lockup = memo(function Lockup({
  artwork, title, subtitle, circle, size = tv.tile, icon, color, dim, badge, onPress, onLongPress, hasTVPreferredFocus, onFocus,
}: LockupProps) {
  const shift = useRef(new Animated.Value(0)).current;
  const focusShift = Math.round(size * 0.075);
  const move = (focused: boolean) => Animated.spring(shift, { toValue: focused ? focusShift : 0, speed: 18, bounciness: 2, useNativeDriver: true }).start();
  useEffect(() => () => shift.stopAnimation(), [shift]);
  return <Focusable
    accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
    onPress={onPress}
    onLongPress={onLongPress}
    hasTVPreferredFocus={hasTVPreferredFocus}
    scale={1}
    shadow={false}
    onFocusChange={focused => {
      move(focused);
      if (focused) onFocus?.();
    }}
    style={{ width: size }}
  >
    {({ focused }) => <>
      <Artwork artwork={artwork} size={size} circle={circle} icon={icon} color={color} dim={dim} />
      <Animated.View style={[styles.words, circle && styles.centred, { transform: [{ translateY: shift }] }]}>
        <View style={[styles.titleLine, circle && styles.centredRow]}>
          <Text numberOfLines={1} style={[styles.title, !focused && styles.resting, dim && styles.dimText, circle && styles.centredText]}>{title}</Text>
          {badge && <Text style={styles.badge}>{badge}</Text>}
        </View>
        {subtitle ? <Text numberOfLines={1} style={[styles.subtitle, circle && styles.centredText]}>{subtitle}</Text> : null}
      </Animated.View>
    </>}
  </Focusable>;
});

const styles = StyleSheet.create({
  words: { marginTop: 14, gap: 1 },
  centred: { alignItems: 'center' },
  centredRow: { justifyContent: 'center' },
  centredText: { textAlign: 'center' },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { ...type.body, fontSize: 26, flexShrink: 1 },
  resting: { color: 'rgba(255,255,255,0.86)' },
  dimText: { color: colors.tertiary },
  subtitle: { ...type.body, fontSize: 26, color: colors.secondary },
  badge: { fontSize: 17, fontWeight: '800', color: colors.background, backgroundColor: colors.secondary, borderRadius: 4, paddingHorizontal: 5, overflow: 'hidden' },
});
