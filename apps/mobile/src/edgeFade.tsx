import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet } from 'react-native';
import { useColors } from './theme';

export { edgeStops, scrollEdgeFade } from './edgeStops';

/**
 * The plain version of a scroll edge: the page colour, mostly opaque, fading out. For Reduce
 * Transparency, and platforms without the blur.
 */
export function EdgeFade({ solid, fade }: { solid: number; fade: number }) {
  const colors = useColors();
  const height = solid + fade;
  return <LinearGradient pointerEvents="none" colors={[`${colors.background}E6`, `${colors.background}E6`, `${colors.background}00`]}
    locations={[0, height > 0 ? solid / height : 0, 1]} style={StyleSheet.absoluteFill} />;
}
