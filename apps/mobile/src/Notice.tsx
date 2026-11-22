import { BlurView } from 'expo-blur';
import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createThemedStyles } from './theme';

const shownMs = 2800;
/** A notice with something to do or a second line stays a little longer, so there is time to reach or read it. */
const longShownMs = 4500;

/** Something the notice offers, such as Undo. Tapping it runs `run` and closes the notice. */
export type NoticeAction = { label: string; run: () => void };
/** `detail`: a quieter line under the message, such as why something failed. */
export type NoticeOptions = { action?: NoticeAction; detail?: string };
type Notify = (message: string, options?: NoticeOptions) => void;

const NoticeContext = createContext<Notify>(() => undefined);

/** Shows `message` briefly at the top of the screen, above everything, and announces it; `action` adds a button such as Undo, `detail` a line under it. */
export function useNotice() {
  return useContext(NoticeContext);
}

export function NoticeProvider({ children }: PropsWithChildren) {
  const [notice, setNotice] = useState<{ id: number; message: string } & NoticeOptions | null>(null);
  const notify = useCallback<Notify>((message, { action, detail } = {}) => {
    setNotice(current => ({ id: (current?.id ?? 0) + 1, message, action, detail }));
    const spoken = detail ? `${message}. ${detail}` : message;
    AccessibilityInfo.announceForAccessibility(action ? `${spoken} ${action.label} is available.` : spoken);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.action || notice.detail ? longShownMs : shownMs);
    return () => clearTimeout(timer);
  }, [notice]);

  return <NoticeContext.Provider value={notify}>
    {children}
    {notice && <NoticeBanner key={notice.id} message={notice.message} detail={notice.detail} action={notice.action && {
      label: notice.action.label,
      run: () => {
        setNotice(null);
        notice.action!.run();
      },
    }} />}
  </NoticeContext.Provider>;
}

function NoticeBanner({ message, detail, action }: { message: string; detail?: string; action?: NoticeAction }) {
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  return <Animated.View entering={FadeInUp.duration(220)} exiting={FadeOutUp.duration(220)}
    pointerEvents={action ? 'box-none' : 'none'} style={[styles.wrap, { top: top + 6 }]}>
    <BlurView tint="systemChromeMaterial" intensity={90} style={[styles.pill, action && styles.withAction]}>
      {detail
        ? <View style={[styles.lines, action && styles.textWithAction]}>
          <Text style={styles.text} numberOfLines={2}>{message}</Text>
          <Text style={styles.detail} numberOfLines={3}>{detail}</Text>
        </View>
        : <Text style={[styles.text, action && styles.textWithAction]} numberOfLines={2}>{message}</Text>}
      {action && <View style={styles.divider} />}
      {action && <Pressable accessibilityRole="button" accessibilityLabel={action.label} onPress={action.run} hitSlop={10}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
        <Text style={styles.actionText}>{action.label}</Text>
      </Pressable>}
    </BlurView>
  </Animated.View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  wrap: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  pill: { borderRadius: 22, overflow: 'hidden', paddingHorizontal: 18, paddingVertical: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.stroke },
  text: { color: colors.text, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  lines: { gap: 2 },
  detail: { color: colors.muted, fontSize: 13, textAlign: 'center' },
  withAction: { flexDirection: 'row', alignItems: 'center', paddingRight: 6, gap: 12 },
  textWithAction: { flexShrink: 1, textAlign: 'left' },
  divider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', backgroundColor: colors.stroke },
  action: { paddingHorizontal: 10, minHeight: 30, justifyContent: 'center' },
  actionText: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.6 },
}));
