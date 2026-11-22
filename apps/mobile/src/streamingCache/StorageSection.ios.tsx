import { Button, LabeledContent, Picker, Section, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, disabled, pickerStyle, tag, tint } from '@expo/ui/swift-ui/modifiers';
import { useColors } from '../theme';
import { cacheNote, limitOptions, useStorageSection } from './settings';

/** The Storage section of Settings. */
export function StorageSection() {
  const colors = useColors();
  const storage = useStorageSection();
  return <Section title="Storage" footer={<Text>{cacheNote}</Text>}>
    <Picker label="Streaming Cache" selection={storage.limitBytes} onSelectionChange={(value: number) => storage.setLimit(value)}
      modifiers={[pickerStyle('menu'), tint(colors.accent)]}>
      {limitOptions.map(option => <Text key={option.label} modifiers={[tag(option.value)]}>{option.label}</Text>)}
    </Picker>
    <LabeledContent label="Used"><Text>{storage.used}</Text></LabeledContent>
    <Button label="Clear" role="destructive" onPress={storage.clear}
      modifiers={[disabled(storage.empty), accessibilityLabel('Clear streaming cache')]} />
  </Section>;
}
