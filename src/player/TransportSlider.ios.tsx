import { Host, Slider } from '@expo/ui/swift-ui';
import { accessibilityLabel, tint } from '@expo/ui/swift-ui/modifiers';
import type { TransportSliderProps } from './TransportSlider';
import { useColors } from '../theme';

export default function TransportSlider({ label, value, maximum, onChange, onEdit }: TransportSliderProps) {
  const colors = useColors();
  return (
    <Host style={{ height: 28, width: '100%' }}>
      <Slider
        value={value}
        min={0}
        max={maximum}
        onValueChange={onChange}
        onEditingChanged={onEdit}
        modifiers={[tint(colors.accent), accessibilityLabel(label)]}
      />
    </Host>
  );
}
