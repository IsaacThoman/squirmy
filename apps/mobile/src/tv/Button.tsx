import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { nativeTVButton } from '../../modules/tv-menu';
import { Icon } from '../ui';
import { Focusable } from './Focusable';
import type { MenuAction } from './Menu';
import { colors, type } from './theme';

/** The native view, resolved once; null in a build without it. */
const NativeButton = nativeTVButton();

type Props = {
  label?: string;
  /** An SF Symbol. A button with an icon and no label is round. */
  icon?: string;
  /** What VoiceOver says, for a button without a label. */
  accessibilityLabel?: string;
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  hasTVPreferredFocus?: boolean;
  /** Filled while resting, such as Play beside Shuffle. */
  prominent?: boolean;
  /** Shown in the accent color while resting, such as a filled heart. */
  active?: boolean;
  style?: StyleProp<ViewStyle>;
  onFocus?: () => void;
};

/**
 * The TV's button: a frosted platter that turns white with dark ink when focused and grows a
 * little, as the system's buttons do.
 */
export function Button({ label, icon, accessibilityLabel, onPress, onLongPress, disabled, hasTVPreferredFocus, prominent, active, style, onFocus }: Props) {
  const round = !label;
  return <Focusable
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled }}
    onPress={disabled ? undefined : onPress}
    onLongPress={onLongPress}
    disabled={disabled}
    hasTVPreferredFocus={hasTVPreferredFocus}
    onFocusChange={focused => { if (focused) onFocus?.(); }}
    scale={round ? 1.12 : 1.07}
    style={style}
    liftStyle={({ focused }) => [
      styles.platter, round ? styles.round : styles.pill,
      { backgroundColor: focused ? colors.focused : prominent ? colors.platterStrong : colors.platter },
      disabled && styles.disabled,
    ]}
  >
    {({ focused }) => {
      const ink = focused ? colors.onFocused : active ? colors.accent : colors.text;
      return <View style={styles.content}>
        {icon && <Icon name={icon} size={round ? 34 : 30} color={ink} />}
        {label && <Text numberOfLines={1} style={[styles.label, { color: ink }]}>{label}</Text>}
      </View>;
    }}
  </Focusable>;
}

const styles = StyleSheet.create({
  platter: { alignItems: 'center', justifyContent: 'center' },
  pill: { height: 76, minWidth: 200, paddingHorizontal: 40, borderRadius: 38 },
  round: { width: 76, height: 76, borderRadius: 38 },
  content: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  label: { ...type.callout, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  nativePill: { height: 72, minWidth: 216 },
  nativeRound: { width: 66, height: 66 },
});

/**
 * A pill's width for its label, as React Native cannot measure a native button: the system's
 * padding, a symbol, and about 19 pt a character of its 29 pt type.
 */
function pillWidth(label: string, icon: boolean): number {
  return Math.max(216, 96 + label.length * 19 + (icon ? 44 : 0));
}

type SystemProps = {
  label?: string;
  icon?: string;
  accessibilityLabel?: string;
  prominent?: boolean;
  /** Ink while resting, such as a filled heart's accent. */
  tint?: string;
  disabled?: boolean;
  onPress?: () => void;
  /** A click opens this menu instead of pressing. */
  menu?: { actions: MenuAction[]; onAction: (id: string) => void };
  width?: number;
};

/**
 * The system's own button, with tvOS's focus motion; a round icon button without a label.
 * Builds without the native view fall back to `Button`.
 */
export function SystemButton({ label, icon, accessibilityLabel, prominent, tint, disabled, onPress, menu, width }: SystemProps) {
  const round = !label;
  if (!NativeButton) {
    return <Button label={label} icon={icon} accessibilityLabel={accessibilityLabel} prominent={prominent} disabled={disabled}
      onPress={onPress ?? (() => undefined)} />;
  }
  return <NativeButton
    accessibilityLabel={accessibilityLabel ?? label}
    title={label}
    systemImage={icon}
    prominent={prominent}
    tint={tint}
    enabled={!disabled}
    actions={menu?.actions}
    onPress={onPress}
    onAction={event => menu?.onAction(event.nativeEvent.id)}
    style={round ? styles.nativeRound : [styles.nativePill, { width: width ?? pillWidth(label, Boolean(icon)) }]}
  />;
}
