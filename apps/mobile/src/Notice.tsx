import { BlurView } from 'expo-blur';
import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import { AccessibilityInfo, Keyboard, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeInUp, FadeOutDown, FadeOutUp } from 'react-native-reanimated';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlayerShown } from './player/visibility';
import { useTabChrome } from './tabChrome';
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

/** Shows `message` briefly above the mini-player (at the top while Now Playing is open), over everything, and announces it; `action` adds a button such as Undo, `detail` a line under it. */
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

/**
 * Rises just above the mini-player and the tab bar, as toasts do in streaming apps: at the
 * top it covered the pages' back and header buttons. An open keyboard lifts it above itself.
 * While Now Playing is open its transport is down there, so the notice drops in at the top
 * instead, over the grabber and the "Playing from" line, which hold nothing else to press.
 */
function NoticeBanner({ message, detail, action }: { message: string; detail?: string; action?: NoticeAction }) {
  const styles = useStyles();
  const { contentInset } = useTabChrome();
  const keyboard = useKeyboardHeight();
  const insets = useSafeAreaInsets();
  const atTop = usePlayerShown();
  const place = atTop ? { top: (insets.top || initialWindowMetrics?.insets.top || 0) + 6 } : { bottom: Math.max(contentInset, keyboard + 12) };
  // Keyed by its place: when the player opens or closes under it, the notice leaves one spot and comes in at the other.
  return <Animated.View key={atTop ? 'top' : 'bottom'} entering={(atTop ? FadeInUp : FadeInDown).duration(220)}
    exiting={(atTop ? FadeOutUp : FadeOutDown).duration(220)} pointerEvents={action ? 'box-none' : 'none'} style={[styles.wrap, place]}>
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

function useKeyboardHeight(): number {
  const [height, setHeight] = useState(() => Keyboard.isVisible() ? Keyboard.metrics()?.height ?? 0 : 0);
  useEffect(() => {
    // iOS says so as the keyboard starts to move; Android only once it has.
    const subscriptions = [
      Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', event => setHeight(event.endCoordinates.height)),
      Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setHeight(0)),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, []);
  return height;
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
