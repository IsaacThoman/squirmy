import Slider from '@react-native-community/slider';
import { useColors } from '../theme';

export type TransportSliderProps = {
  label: string;
  value: number;
  maximum: number;
  onChange: (value: number) => void;
  onEdit?: (editing: boolean) => void;
};

export default function TransportSlider({ label, value, maximum, onChange, onEdit }: TransportSliderProps) {
  const colors = useColors();
  return (
    <Slider
      accessibilityLabel={label}
      value={value}
      minimumValue={0}
      maximumValue={maximum}
      minimumTrackTintColor={colors.accent}
      maximumTrackTintColor={colors.stroke}
      thumbTintColor={colors.text}
      onSlidingStart={() => onEdit?.(true)}
      onValueChange={onChange}
      onSlidingComplete={() => onEdit?.(false)}
      style={{ height: 28, width: '100%' }}
    />
  );
}
