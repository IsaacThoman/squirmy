import { LinearGradient } from 'expo-linear-gradient';
import { useRef, type ComponentRef, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View, type ScrollViewProps } from 'react-native';
import { shade } from '../data/color';
import { Button } from './Button';
import { useTabScroll } from './screens/useTabScroll';
import { SidebarPanel, SidebarPill } from './Sidebar';
import { colors, tv, type } from './theme';

/**
 * The backdrop every page sits on: the app's violet charcoal, or, given an artwork color, a dark
 * wash of it that fades down into the charcoal, as the system's album pages tint themselves.
 */
export function Backdrop({ tint }: { tint?: string | null }) {
  const top = tint ? shade(tint, 0.32) : colors.backgroundTop;
  return <LinearGradient pointerEvents="none" colors={[top, colors.background, colors.backgroundBottom]} locations={[0, 0.55, 1]}
    style={StyleSheet.absoluteFill} />;
}

type PageProps = {
  children: ReactNode;
  tint?: string | null;
  /** Where the content starts: under the sidebar's pill on a tab's first page, higher on pages pushed over it. */
  top?: number;
  contentStyle?: ScrollViewProps['contentContainerStyle'];
} & Omit<ScrollViewProps, 'children'>;

/**
 * A page that scrolls as focus moves down it, over its backdrop. While it is on screen it tells
 * the sidebar whether it has left its top, so Menu scrolls it back before opening the sidebar.
 */
export function Page({ children, tint, top = tv.top, contentStyle, onScroll, ...props }: PageProps) {
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  const reportScroll = useTabScroll(list);
  return <View style={styles.page}>
    <Backdrop tint={tint} />
    <ScrollView {...props} ref={list} style={styles.scroll} contentContainerStyle={[styles.content, { paddingTop: top }, contentStyle]}
      showsVerticalScrollIndicator={false} scrollEventThrottle={100}
      onScroll={event => {
        reportScroll(event);
        onScroll?.(event);
      }}>
      {/* A tab's first page carries the sidebar's pill at its top, and it scrolls away with it. */}
      {top === tv.top && <SidebarPill />}
      {children}
    </ScrollView>
    {top === tv.top && <SidebarPanel />}
  </View>;
}

/** Waiting for a page, or why it could not load, with Try again. */
export function PageState({ loading, message, onRetry }: { loading?: boolean; message?: string; onRetry?: () => void }) {
  return <View style={styles.state}>
    <Backdrop />
    {loading
      ? <ActivityIndicator size="large" color={colors.secondary} />
      : <>
        {message ? <Text style={styles.message}>{message}</Text> : null}
        {onRetry && <Button label="Try again" icon="arrow.clockwise" onPress={onRetry} hasTVPreferredFocus />}
      </>}
  </View>;
}

/** Nothing to show yet, with what to do about it. */
export function EmptyMessage({ icon, title, description }: { icon?: ReactNode; title: string; description?: string }) {
  return <View style={styles.empty}>
    {icon}
    <Text style={type.title3}>{title}</Text>
    {description ? <Text style={styles.emptyDescription}>{description}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1, overflow: 'visible' },
  content: { paddingBottom: 120 },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 36, backgroundColor: colors.background },
  message: { ...type.title3, color: colors.secondary, textAlign: 'center', maxWidth: 1100 },
  empty: { alignItems: 'center', justifyContent: 'center', gap: 18, paddingVertical: 160, paddingHorizontal: tv.gutter },
  emptyDescription: { ...type.body, color: colors.secondary, textAlign: 'center', maxWidth: 1000 },
});
