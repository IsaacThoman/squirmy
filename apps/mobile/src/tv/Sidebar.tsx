import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useIsFocused, useRouter, useSegments, type Href } from 'expo-router';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, TVEventControl, TVFocusGuideView, View } from 'react-native';
import { useAccount } from '../account/AccountProvider';
import { BrandMark } from '../BrandMark';
import { Icon } from '../ui';
import { Focusable, focusClock } from './Focusable';
import { colors } from './theme';

/** The tabs, in the sidebar's order, with their symbols. Route names are the folders in `tv-app/(tabs)`. */
export const sidebarTabs = [
  { route: '(search)', label: 'Search', icon: 'magnifyingglass' },
  { route: '(home)', label: 'Home', icon: 'house.fill' },
  { route: '(library)', label: 'Library', icon: 'music.note.square.stack.fill' },
  { route: 'now-playing', label: 'Now Playing', icon: 'play.circle.fill' },
  { route: 'settings', label: 'Settings', icon: 'gearshape.fill' },
] as const;

type Chrome = {
  /** A tab's first page scrolled away from its top: Menu scrolls it back before it opens the sidebar. */
  setScrolled: (scrolled: boolean) => void;
  /** The page on screen, which Menu scrolls back to its top. */
  setScrollToTop: (scroll: (() => void) | null) => void;
  /** A screen that handles Menu itself for now (an open panel), so the sidebar leaves it alone. */
  setMenuOwner: (owned: boolean) => void;
  /** Whether the sidebar is open. */
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  /** The sidebar has just closed: the pill takes no focus for a moment, so focus goes on into the page. */
  settling: boolean;
};

const ChromeContext = createContext<Chrome | null>(null);

/** What a tab's screens tell the sidebar, and how they open it. */
export function useSidebarChrome(): Chrome | null {
  return useContext(ChromeContext);
}

/** The tab on screen, from the route: `(tabs)/(home)/…`. */
function useCurrentSidebarTab() {
  const segments: readonly string[] = useSegments();
  return {
    tab: sidebarTabs.find(item => item.route === segments[1]) ?? sidebarTabs[1],
    // Not a page pushed over the tab's first one, such as (tabs)/(home)/album/[id], nor a modal over the tabs.
    atRoot: segments[0] === '(tabs)' && (segments.length <= 2 || segments[2] === 'index'),
  };
}

/**
 * The sidebar's state for the tabs, and Menu on a tab's first page: it scrolls the page back to
 * its top, then opens the sidebar. With the sidebar open the system takes Menu and leaves the
 * app, as it does in the system's apps. The pill and the panel themselves are drawn by each
 * tab's first screen (`TabRoot`): the focus engine only reaches what lies inside the screen on show.
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const { atRoot } = useCurrentSidebarTab();
  const [scrolled, setScrolled] = useState(false);
  const [menuOwned, setMenuOwner] = useState(false);
  const [isOpen, setOpen] = useState(false);
  const [settling, setSettling] = useState(false);
  const scrollToTop = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (isOpen) return;
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), 600);
    return () => clearTimeout(timer);
  }, [isOpen]);
  // Leaving a tab's first page (a page pushed over it, a modal) closes the sidebar.
  useEffect(() => { if (!atRoot) setOpen(false); }, [atRoot]);

  // The app keeps the Menu key while a screen owns Menu too, so a press is never the system's
  // (which leaves the app) while the sidebar hands Menu over or takes it back. It is asked for
  // again whenever what Menu does changes, as the native side may not be listening at launch.
  const holdsKey = atRoot && !isOpen;
  const handlesMenu = holdsKey && !menuOwned;
  useEffect(() => {
    if (!holdsKey) return;
    TVEventControl.enableTVMenuKey();
    return () => TVEventControl.disableTVMenuKey();
  }, [holdsKey, handlesMenu, scrolled]);
  useEffect(() => {
    if (!handlesMenu) return;
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (scrolled && scrollToTop.current) scrollToTop.current();
      else setOpen(true);
      return true;
    });
    return () => listener.remove();
  }, [handlesMenu, scrolled]);

  const chrome = useMemo<Chrome>(() => ({
    setScrolled,
    setScrollToTop: scroll => { scrollToTop.current = scroll; },
    setMenuOwner,
    isOpen,
    setOpen,
    settling,
  }), [isOpen, settling]);
  return <ChromeContext.Provider value={chrome}>{children}</ChromeContext.Provider>;
}

/**
 * A tab's first screen: its content, the sidebar's pill at the top left (`pill={false}` for a
 * screen that places it itself, such as a page that scrolls it away, or has none, like Now
 * Playing), and the sidebar's panel over it while open.
 */
export function TabRoot({ children, pill = true }: { children: ReactNode; pill?: boolean }) {
  return <View style={styles.root}>
    {children}
    {pill && <SidebarPill />}
    <SidebarPanel />
  </View>;
}

/**
 * The collapsed sidebar: a small glass pill naming the tab, at the top left of a tab's first
 * screen; moving up onto it opens the sidebar. A page that scrolls puts it in its scroll view,
 * so it scrolls away with the page as the system's does.
 */
export function SidebarPill() {
  const chrome = useSidebarChrome();
  const { tab } = useCurrentSidebarTab();
  const [pill, setPill] = useState<ComponentRef<typeof Pressable> | null>(null);
  const [shownAt] = useState(() => Date.now());
  if (!chrome || chrome.isOpen) return null;
  // Moving onto the pill opens the sidebar; landing on it first, on a page with nothing else to
  // focus (an empty Home), does not, and a click opens it there.
  const opened = () => {
    if (focusClock.previous > shownAt) chrome.setOpen(true);
  };
  return <>
    {/* Under the pill, across the screen: moving up from the first row lands here and goes on to the pill. */}
    {pill && !chrome.settling && <TVFocusGuideView destinations={[pill]} style={styles.upGuide} />}
    <View style={styles.pillLayer}>
    <Focusable ref={setPill} accessibilityLabel={`${tab.label}, open the sidebar`} scale={1.06} focusable={!chrome.settling}
      onFocus={opened} onPress={() => chrome.setOpen(true)}
      liftStyle={({ focused }) => [styles.pill, focused && styles.itemFocused]}>
      {({ focused }) => <>
        <Icon name="chevron.left" size={20} color={focused ? colors.onFocused : colors.secondary} />
        <Icon name={tab.icon} size={26} color={focused ? colors.onFocused : colors.text} />
        <Text style={[styles.label, focused && styles.labelFocused]}>{tab.label}</Text>
      </>}
    </Focusable>
    </View>
  </>;
}

/**
 * The open sidebar: a glass panel of the tabs over the dimmed screen, the current tab focused.
 * Choosing a tab switches to it; moving right goes back into the screen and closes it.
 */
export function SidebarPanel() {
  const chrome = useSidebarChrome();
  const focusedScreen = useIsFocused();
  const { state: account } = useAccount();
  const { tab } = useCurrentSidebarTab();
  const router = useRouter();
  const inside = useRef(0);
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (leaving.current) clearTimeout(leaving.current); }, []);
  if (!chrome?.isOpen || !focusedScreen) return null;

  // The panel closes once focus has left all of its items, such as moving right into the screen.
  const entered = () => {
    inside.current += 1;
    if (leaving.current) clearTimeout(leaving.current);
  };
  const left = () => {
    inside.current = Math.max(0, inside.current - 1);
    if (leaving.current) clearTimeout(leaving.current);
    leaving.current = setTimeout(() => { if (inside.current === 0) chrome.setOpen(false); }, 80);
  };
  const choose = (name: string) => {
    chrome.setOpen(false);
    if (name !== tab.route) router.navigate(`/(tabs)/${name}` as Href);
  };
  const user = account.status === 'signedIn' ? account.user : null;
  return <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
    <View pointerEvents="none" style={styles.dim} />
    <Glass style={styles.panel}>
      <TVFocusGuideView autoFocus trapFocusUp trapFocusDown trapFocusLeft style={styles.items}>
        <View style={styles.header}>
          <View style={styles.avatar}><BrandMark size={50} /></View>
          <Text numberOfLines={1} style={styles.name}>{user?.displayName || user?.username || 'Squirmy'}</Text>
          <Clock />
        </View>
        {sidebarTabs.map(item => {
          const current = item.route === tab.route;
          return <Focusable key={item.route} accessibilityLabel={item.label} accessibilityState={{ selected: current }}
            hasTVPreferredFocus={current} scale={1.04} onFocus={entered} onBlur={left} onPress={() => choose(item.route)}
            liftStyle={({ focused }) => [styles.item, current && styles.itemCurrent, focused && styles.itemFocused]}>
            {({ focused }) => <>
              <View style={styles.itemIcon}><Icon name={item.icon} size={28} color={focused ? colors.onFocused : colors.text} /></View>
              <Text style={[styles.label, focused && styles.labelFocused]}>{item.label}</Text>
            </>}
          </Focusable>;
        })}
      </TVFocusGuideView>
    </Glass>
  </View>;
}

/** Liquid Glass where tvOS has it (26 and later), a dark blur before. */
function Glass({ style, children }: { style: object; children: ReactNode }) {
  if (isLiquidGlassAvailable()) return <GlassView glassEffectStyle="regular" colorScheme="dark" style={style}>{children}</GlassView>;
  return <BlurView intensity={80} tint="dark" style={[style, styles.blurFallback]}>{children}</BlurView>;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return <Text style={styles.clock}>{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  upGuide: { position: 'absolute', top: 114, left: 0, width: 1920, height: 20 },
  pillLayer: { position: 'absolute', top: 60, left: 37, zIndex: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 52, paddingHorizontal: 22, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.10)' },
  dim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.5)' },
  panel: { position: 'absolute', top: 37, left: 37, width: 355, borderRadius: 40, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
  blurFallback: { backgroundColor: 'rgba(40,36,52,0.55)' },
  items: { paddingHorizontal: 13, paddingTop: 23, paddingBottom: 26, gap: 2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, height: 76, paddingHorizontal: 12, marginBottom: 14 },
  avatar: { width: 50, height: 50, borderRadius: 25, overflow: 'hidden' },
  name: { flex: 1, fontSize: 25, fontWeight: '500', color: colors.text },
  clock: { fontSize: 22, color: colors.secondary },
  item: { flexDirection: 'row', alignItems: 'center', height: 74, borderRadius: 37, paddingHorizontal: 24, gap: 16 },
  itemCurrent: { backgroundColor: 'rgba(255,255,255,0.15)' },
  itemFocused: { backgroundColor: colors.focused },
  itemIcon: { width: 30, alignItems: 'center' },
  label: { fontSize: 27, fontWeight: '600', color: colors.text },
  labelFocused: { color: colors.onFocused },
});
