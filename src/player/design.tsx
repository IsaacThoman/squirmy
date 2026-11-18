import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Icon } from '../ui';

export const playerColors = {
  text: '#F6F3FC',
  muted: '#B8B1C7',
  quiet: '#ADA5BC',
  lilac: '#CBC1FF',
  ink: '#19142B',
  stroke: '#FFFFFF1A',
  surface: '#FFFFFF0D',
};

export function selectionFeedback() {
  void Haptics.selectionAsync().catch(() => {});
}

export function PlayerButton({ icon, label, size = 20, color = playerColors.text, onPress, style, selected }: {
  icon: string;
  label: string;
  size?: number;
  color?: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.button, style, pressed && styles.pressed]}
    >
      <Icon name={icon} size={size} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.65 },
});
