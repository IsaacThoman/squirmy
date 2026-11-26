import { useState, type PropsWithChildren, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

export const tvColors = {
  background: '#12101C',
  surface: '#24212E',
  surfaceRaised: '#342D43',
  border: '#FFFFFF24',
  text: '#F7F3FF',
  muted: '#B9B0C7',
  accent: '#CBC1FF',
  ink: '#1E1730',
  danger: '#FF9E98',
} as const;

export function TvScreen({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

type ControlProps = {
  children: (focused: boolean) => ReactNode;
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  selected?: boolean;
  hasTVPreferredFocus?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  style?: StyleProp<ViewStyle>;
  focusedStyle?: StyleProp<ViewStyle>;
};

export function TvControl({ children, onFocus, onBlur, selected, disabled, style, focusedStyle, ...props }: ControlProps) {
  const [focused, setFocused] = useState(false);
  return <Pressable
    {...props}
    accessibilityRole="button"
    accessibilityState={{ selected, disabled }}
    disabled={disabled}
    tvParallaxProperties={{ enabled: false }}
    onFocus={() => { setFocused(true); onFocus?.(); }}
    onBlur={() => { setFocused(false); onBlur?.(); }}
    style={({ pressed }) => [style, focused && focusedStyle, pressed && styles.pressed, disabled && styles.disabled]}
  >{children(focused)}</Pressable>;
}

type ButtonProps = Omit<ControlProps, 'children' | 'focusedStyle'> & {
  label: string;
  tone?: 'primary' | 'surface' | 'quiet';
};

export function TvButton({ label, tone = 'surface', selected, style, ...props }: ButtonProps) {
  return <TvControl {...props} selected={selected}
    style={[styles.button, tone === 'quiet' && styles.quiet, tone === 'primary' && styles.primary, selected && styles.selected, style]}
    focusedStyle={styles.focused}>
    {focused => <Text numberOfLines={1} style={[styles.label, (focused || tone === 'primary') && styles.darkLabel]}>{label}</Text>}
  </TvControl>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 74 },
  button: {
    minHeight: 56, paddingHorizontal: 26, paddingVertical: 10, borderRadius: 25,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent', backgroundColor: tvColors.surface,
  },
  primary: { backgroundColor: tvColors.accent },
  quiet: { backgroundColor: 'transparent' },
  selected: { borderColor: tvColors.border },
  focused: { backgroundColor: tvColors.text, borderColor: tvColors.text, transform: [{ scale: 1.06 }], zIndex: 2, boxShadow: '0 7px 24px #0008' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.82 },
  label: { color: tvColors.text, fontSize: 25, fontWeight: '600' },
  darkLabel: { color: tvColors.ink },
});
