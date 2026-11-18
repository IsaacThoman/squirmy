import Slider from '@react-native-community/slider';

export type TransportSliderProps = {
  label: string;
  value: number;
  maximum: number;
  onChange: (value: number) => void;
  onEdit?: (editing: boolean) => void;
};

export default function TransportSlider({ label, value, maximum, onChange, onEdit }: TransportSliderProps) {
  return (
    <Slider
      accessibilityLabel={label}
      value={value}
      minimumValue={0}
      maximumValue={maximum}
      minimumTrackTintColor="#CBC1FF"
      maximumTrackTintColor="#5d586b"
      thumbTintColor="#F2ECFF"
      onSlidingStart={() => onEdit?.(true)}
      onValueChange={onChange}
      onSlidingComplete={() => onEdit?.(false)}
      style={{ height: 28, width: '100%' }}
    />
  );
}
