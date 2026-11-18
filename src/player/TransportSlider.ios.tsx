import { Host, Slider } from '@expo/ui/swift-ui';
import { accessibilityLabel, tint } from '@expo/ui/swift-ui/modifiers';
import type { TransportSliderProps } from './TransportSlider';

export default function TransportSlider({ label, value, maximum, onChange, onEdit }: TransportSliderProps) {
  return (
    <Host colorScheme="dark" style={{ height: 28, width: '100%' }}>
      <Slider
        value={value}
        min={0}
        max={maximum}
        onValueChange={onChange}
        onEditingChanged={onEdit}
        modifiers={[tint('#CBC1FF'), accessibilityLabel(label)]}
      />
    </Host>
  );
}
