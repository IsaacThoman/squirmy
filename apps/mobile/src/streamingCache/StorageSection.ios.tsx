import { Button, LabeledContent, Section, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, disabled, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { useAccountStorage } from '../account/storageUsage';
import { SheetPickerRow } from '../SheetUI';
import { useColors } from '../theme';
import { accountNote, cacheNote, limitOptions, signedOutNote, useStorageSection } from './settings';

/**
 * The Storage section of Settings. Its limit is picked like Settings' other values, by tapping anywhere on the row.
 * The value and note take `muted`, which reads at 4.5:1 on the form; its own secondary gray does not in Light.
 */
export function StorageSection() {
  const colors = useColors();
  const storage = useStorageSection();
  const accounts = useAccountStorage();
  const muted = foregroundStyle(colors.muted);
  return <>
    <Section title="Storage" footer={<Text modifiers={[muted]}>{cacheNote}</Text>}>
      <SheetPickerRow label="Streaming Cache" value={storage.limitBytes} options={limitOptions} onChange={storage.setLimit} />
      <LabeledContent label="Used"><Text modifiers={[muted]}>{storage.used}</Text></LabeledContent>
      <Button label="Clear" role="destructive" onPress={storage.clear}
        modifiers={[disabled(storage.empty), accessibilityLabel('Clear streaming cache')]} />
    </Section>
    {/* What each account on this phone keeps here: the one in use, and those kept for switching back. */}
    {accounts.map(({ account, title, downloads, downloadsLine, cacheLine, removeDownloads, removeAccount }) => (
      <Section key={account.key} title={account.server.name}
        footer={account.current ? undefined : <Text modifiers={[muted]}>{account.signedIn ? accountNote : signedOutNote}</Text>}>
        <LabeledContent label={title}><Text modifiers={[muted]}>{account.current ? 'In Use' : account.signedIn ? 'Signed In' : 'Signed Out'}</Text></LabeledContent>
        <LabeledContent label="Downloads"><Text modifiers={[muted]}>{downloadsLine}</Text></LabeledContent>
        <LabeledContent label="Streaming Cache"><Text modifiers={[muted]}>{cacheLine}</Text></LabeledContent>
        <Button label="Remove Downloads for This Server" role="destructive" onPress={removeDownloads}
          modifiers={[disabled(!downloads.count), accessibilityLabel(`Remove ${title}’s downloads for ${account.server.name}`)]} />
        {removeAccount && <Button label="Remove Account" role="destructive" onPress={removeAccount}
          modifiers={[accessibilityLabel(`Remove ${title} on ${account.server.name} from this iPhone`)]} />}
      </Section>
    ))}
  </>;
}
