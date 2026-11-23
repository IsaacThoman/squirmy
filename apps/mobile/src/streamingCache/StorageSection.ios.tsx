import { Button, LabeledContent, Section, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, disabled, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { SheetPickerRow } from '../SheetUI';
import { useColors } from '../theme';
import { cacheNote, limitOptions, useStorageSection } from './settings';

/**
 * The Storage section of Settings. Its limit is picked like Settings' other values, by tapping anywhere on the row.
 * The value and note take `muted`, which reads at 4.5:1 on the form; its own secondary gray does not in Light.
 */
export function StorageSection() {
  const colors = useColors();
  const storage = useStorageSection();
  const muted = foregroundStyle(colors.muted);
  return <Section title="Storage" footer={<Text modifiers={[muted]}>{cacheNote}</Text>}>
    <SheetPickerRow label="Streaming Cache" value={storage.limitBytes} options={limitOptions} onChange={storage.setLimit} />
    <LabeledContent label="Used"><Text modifiers={[muted]}>{storage.used}</Text></LabeledContent>
    <Button label="Clear" role="destructive" onPress={storage.clear}
      modifiers={[disabled(storage.empty), accessibilityLabel('Clear streaming cache')]} />
  </Section>;
}
