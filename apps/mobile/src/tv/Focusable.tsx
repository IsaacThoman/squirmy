import { useEffect, useRef, useState, type ComponentRef, type ReactNode, type Ref } from 'react';
import {
  Animated, Easing, Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle,
} from 'react-native';
import { liftShadow, tv } from './theme';

export type FocusState = { focused: boolean; pressed: boolean };

/** When the last two focus moves happened, for something that reacts to how focus reached it. */
export const focusClock = { last: 0, previous: 0 };

type Props = Omit<PressableProps, 'children' | 'style' | 'ref'> & {
  ref?: Ref<ComponentRef<typeof Pressable>>;
  children: ReactNode | ((state: FocusState) => ReactNode);
  /** The outer box, laid out as usual; it does not scale. */
  style?: StyleProp<ViewStyle>;
  /** The part that lifts when focused: scaled and shadowed. */
  liftStyle?: StyleProp<ViewStyle> | ((state: FocusState) => StyleProp<ViewStyle>);
  /** How far focus grows the lifted part; 1 for none (a cover lifts natively instead). */
  scale?: number;
  /** A shadow under the lifted part while focused. */
  shadow?: boolean;
  onFocusChange?: (focused: boolean) => void;
};

/**
 * Something the remote can focus and select. Focus grows it a little with a spring and lifts it
 * on a shadow, and a click pushes it back down, as the system's controls do. Children may take
 * a function of the focus state, to swap colors.
 */
export function Focusable(
  { ref, children, style, liftStyle, scale = tv.focusScale, shadow = true, onFocus, onBlur, onFocusChange, onPressIn, onPressOut, hasTVPreferredFocus, ...props }: Props,
) {
  const [focused, setFocused] = useState(false);
  // Preferred focus places the first focus on a screen; held on after that, it pulls focus back
  // from whatever opens later, such as the sidebar or a menu.
  const [placed, setPlaced] = useState(false);
  const [pressed, setPressed] = useState(false);
  const growth = useRef(new Animated.Value(1)).current;
  const target = pressed ? (focused ? 1 + (scale - 1) * 0.35 : 0.97) : focused ? scale : 1;

  useEffect(() => {
    if (pressed) {
      Animated.timing(growth, { toValue: target, duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    } else {
      Animated.spring(growth, { toValue: target, speed: 18, bounciness: 4, useNativeDriver: true }).start();
    }
  }, [growth, pressed, target]);

  const state = { focused, pressed };
  const lift = typeof liftStyle === 'function' ? liftStyle(state) : liftStyle;
  return <Pressable
    ref={ref}
    {...props}
    // A long press is the context menu's (see `Menu`); without a handler of its own, its release would also press.
    onLongPress={props.onLongPress ?? noop}
    style={style}
    hasTVPreferredFocus={hasTVPreferredFocus && !placed}
    onFocus={event => {
      focusClock.previous = focusClock.last;
      focusClock.last = Date.now();
      setFocused(true);
      setPlaced(true);
      onFocusChange?.(true);
      onFocus?.(event);
    }}
    onBlur={event => {
      setFocused(false);
      onFocusChange?.(false);
      onBlur?.(event);
    }}
    onPressIn={event => {
      setPressed(true);
      onPressIn?.(event);
    }}
    onPressOut={event => {
      setPressed(false);
      onPressOut?.(event);
    }}
    // The system's parallax would scale the whole box; the lift here scales only `liftStyle`.
    tvParallaxProperties={{ enabled: false }}
  >
    <Animated.View style={[lift, { transform: [{ scale: growth }] }, shadow && focused && styles.shadow]}>
      {typeof children === 'function' ? children(state) : children}
    </Animated.View>
  </Pressable>;
}

const noop = () => undefined;

const styles = StyleSheet.create({ shadow: liftShadow });
