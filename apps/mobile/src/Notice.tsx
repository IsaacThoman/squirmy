import { BlurView } from 'expo-blur';
import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import { AccessibilityInfo, StyleSheet, Text } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createThemedStyles } from './theme';

const shownMs = 2800;

const NoticeContext = createContext<(message: string) => void>(() => undefined);

/** Shows `message` briefly at the top of the screen, above everything, and announces it. */
export function useNotice() {
  return useContext(NoticeContext);
}

export function NoticeProvider({ children }: PropsWithChildren) {
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null);
  const notify = useCallback((message: string) => {
    setNotice(current => ({ id: (current?.id ?? 0) + 1, message }));
    AccessibilityInfo.announceForAccessibility(message);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), shownMs);
    return () => clearTimeout(timer);
  }, [notice]);

  return <NoticeContext.Provider value={notify}>
    {children}
    {notice && <NoticeBanner key={notice.id} message={notice.message} />}
  </NoticeContext.Provider>;
}

function NoticeBanner({ message }: { message: string }) {
  const styles = useStyles();
  const { top } = useSafeAreaInsets();
  return <Animated.View entering={FadeInUp.duration(220)} exiting={FadeOutUp.duration(220)}
    pointerEvents="none" style={[styles.wrap, { top: top + 6 }]}>
    <BlurView tint="systemChromeMaterial" intensity={90} style={styles.pill}>
      <Text style={styles.text} numberOfLines={2}>{message}</Text>
    </BlurView>
  </Animated.View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  wrap: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  pill: { borderRadius: 22, overflow: 'hidden', paddingHorizontal: 18, paddingVertical: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.stroke },
  text: { color: colors.text, fontSize: 14, fontWeight: '600', textAlign: 'center' },
}));
