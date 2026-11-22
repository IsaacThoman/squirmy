import { Button, LabeledContent, Section, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, disabled } from '@expo/ui/swift-ui/modifiers';
import { SheetPickerRow } from '../SheetUI';
import { cacheNote, limitOptions, useStorageSection } from './settings';

/** The Storage section of Settings. Its limit is picked like Settings' other values, by tapping anywhere on the row. */
export function StorageSection() {
  const storage = useStorageSection();
  return <Section title="Storage" footer={<Text>{cacheNote}</Text>}>
    <SheetPickerRow label="Streaming Cache" value={storage.limitBytes} options={limitOptions} onChange={storage.setLimit} />
    <LabeledContent label="Used"><Text>{storage.used}</Text></LabeledContent>
    <Button label="Clear" role="destructive" onPress={storage.clear}
      modifiers={[disabled(storage.empty), accessibilityLabel('Clear streaming cache')]} />
  </Section>;
}
