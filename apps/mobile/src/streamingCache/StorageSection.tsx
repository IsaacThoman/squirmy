import { StyleSheet, Text } from 'react-native';
import { SheetRow, SheetRows } from '../SheetUI';
import { createThemedStyles, useColors } from '../theme';
import { cacheNote, limitOptions, useStorageSection } from './settings';

/** The Storage section of Settings. */
export function StorageSection() {
  const colors = useColors();
  const styles = useStyles();
  const storage = useStorageSection();
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
  </>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  heading: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 6 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19 },
}));
