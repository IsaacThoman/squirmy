import { useState, type ReactElement } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createThemedStyles, useColors } from './theme';
import { Icon } from './ui';

/** One entry of a menu. `icon` is an SF Symbol name; `destructive` draws it in red; `subtitle` goes under the title. */
export type MenuChoice = { title: string; subtitle?: string; icon?: string; destructive?: boolean; onPress: () => void };

type Menu = { title: string; message?: string; choices: readonly MenuChoice[] };

/**
 * A menu of any length, as a sheet from the bottom of the screen, for the platforms without
 * the system's own menus: Android's alert keeps only three buttons and drops the rest
 * without a word. iOS uses its native menus and action sheets instead. `open` shows it; the
 * caller renders `sheet` where it can, once.
 */
export function useMenuSheet(): { open: (title: string, choices: readonly MenuChoice[], message?: string) => void; sheet: ReactElement | null } {
  const [menu, setMenu] = useState<Menu | null>(null);
  return {
    open: (title, choices, message) => setMenu({ title, message, choices }),
    sheet: menu && <MenuSheet {...menu} onClose={() => setMenu(null)} />,
  };
}

function MenuSheet({ title, message, choices, onClose }: Menu & { onClose: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  const { bottom } = useSafeAreaInsets();
  // The menu goes before what was chosen runs, so a choice that opens something else (a
  // confirmation, a page) is not under it.
  const choose = (choice: MenuChoice) => {
    onClose();
    choice.onPress();
  };
  return <Modal transparent visible animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
    <Pressable accessibilityRole="button" accessibilityLabel="Close menu" style={styles.backdrop} onPress={onClose} />
    <View style={[styles.sheet, { paddingBottom: Math.max(16, bottom + 8) }]}>
      <Text accessibilityRole="header" numberOfLines={2} style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      <ScrollView style={styles.list} contentContainerStyle={styles.rows}>
        {choices.map(choice => {
          const tone = choice.destructive ? colors.danger : colors.text;
          // Two choices can share a title (one edition of an album in two qualities); their subtitles differ.
          return <Pressable key={`${choice.title}\n${choice.subtitle ?? ''}`} accessibilityRole="button" onPress={() => choose(choice)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            {choice.icon ? <Icon name={choice.icon} size={20} color={tone} /> : null}
            {choice.subtitle
              ? <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: tone }]}>{choice.title}</Text>
                <Text style={styles.rowSubtitle}>{choice.subtitle}</Text>
              </View>
              : <Text style={[styles.rowTitle, { color: tone }]}>{choice.title}</Text>}
          </Pressable>;
        })}
      </ScrollView>
      <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.row, styles.cancel, pressed && styles.pressed]}>
        <Text style={[styles.rowTitle, styles.cancelTitle]}>Cancel</Text>
      </Pressable>
    </View>
  </Modal>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#00000066' },
  sheet: { backgroundColor: colors.sheet, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 20, paddingHorizontal: 16, gap: 10, maxHeight: '80%' },
  title: { color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.4, paddingHorizontal: 6 },
  message: { color: colors.muted, fontSize: 14, paddingHorizontal: 6 },
  list: { flexGrow: 0 },
  rows: { gap: 6 },
  row: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, borderRadius: 14, backgroundColor: colors.overlay },
  rowTitle: { flex: 1, fontSize: 16, fontWeight: '600' },
  rowText: { flex: 1, gap: 2, paddingVertical: 8 },
  rowSubtitle: { color: colors.muted, fontSize: 13 },
  cancel: { justifyContent: 'center' },
  cancelTitle: { color: colors.accent, textAlign: 'center' },
  pressed: { opacity: 0.73 },
}));
