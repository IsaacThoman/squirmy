import { StyleSheet } from 'react-native';
import { MaterialBlur } from '../MaterialBlur';

export function AlbumStatusBlur({ height }: { height: number }) {
  return <MaterialBlur fadeBottom style={[styles.blur, { height }]} />;
}

const styles = StyleSheet.create({
  blur: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 },
});
