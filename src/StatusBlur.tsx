import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet } from 'react-native';
import { statusFade, useColors } from './theme';

/** Without the system material, fade the page background in behind the status bar along the same curve. */
export function StatusBlur() {
  const { background } = useColors();
  return <LinearGradient pointerEvents="none" colors={statusFade.map(alpha => `${background}${alpha}`) as [string, string, ...string[]]}
    style={StyleSheet.absoluteFill} />;
}
