import { StyleSheet, Text, View } from 'react-native';
import { useAccountStorage } from '../account/storageUsage';
import { SheetRow, SheetRows } from '../SheetUI';
import { createThemedStyles, useColors } from '../theme';
import { accountNote, cacheNote, limitOptions, signedOutNote, useStorageSection } from './settings';

/** The Storage section of Settings. */
export function StorageSection() {
  const colors = useColors();
  const styles = useStyles();
  const storage = useStorageSection();
  const accounts = useAccountStorage();
  return <>
    <Text style={styles.heading}>Streaming cache</Text>
    <SheetRows>
      {limitOptions.map(option => <SheetRow key={option.label} title={option.label} icon="internaldrive"
        selected={storage.limitBytes === option.value} onPress={() => storage.setLimit(option.value)} />)}
    </SheetRows>
    <Text style={styles.note}>{cacheNote}</Text>
    {!storage.empty && <SheetRows>
      <SheetRow title="Clear" subtitle={storage.used} icon="trash" color={colors.danger} onPress={storage.clear} />
    </SheetRows>}
    {/* What each account on this phone keeps here: the one in use, and those kept for switching back. */}
    {accounts.map(({ account, title, downloads, downloadsLine, cacheLine, removeDownloads, removeAccount }) => <View key={account.key} style={styles.account}>
      <Text style={styles.heading}>{account.server.name}</Text>
      <SheetRows>
        <SheetRow title={title} subtitle={`Downloads: ${downloadsLine} · Streaming cache: ${cacheLine}`} icon="person.crop.circle"
          selected={account.current} onPress={() => undefined} />
        {downloads.count > 0 && <SheetRow title="Remove Downloads for This Server" icon="trash" color={colors.danger} onPress={removeDownloads} />}
        {removeAccount && <SheetRow title="Remove Account" icon="person.crop.circle.badge.minus" color={colors.danger} onPress={removeAccount} />}
      </SheetRows>
      {!account.current && <Text style={styles.note}>{account.signedIn ? accountNote : signedOutNote}</Text>}
    </View>)}
  </>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  heading: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 6 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  account: { gap: 8 },
}));
