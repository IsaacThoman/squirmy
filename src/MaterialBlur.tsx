import { BlurView } from 'expo-blur';
import type { StyleProp, ViewStyle } from 'react-native';

export type MaterialBlurProps = {
  style: StyleProp<ViewStyle>;
  fadeBottom?: boolean;
  fallbackColor?: string;
};

export function MaterialBlur({ style, fallbackColor }: MaterialBlurProps) {
  return (
    <BlurView pointerEvents="none" tint="systemUltraThinMaterialDark" intensity={70}
      style={[style, fallbackColor ? { backgroundColor: fallbackColor } : undefined]} />
  );
}
