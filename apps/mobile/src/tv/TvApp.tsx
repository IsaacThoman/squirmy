import { QueryClientProvider } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, Text, TVEventControl, TVFocusGuideView, View } from 'react-native';
import { BrandMark } from '../BrandMark';
import { AccountProvider, createQueryClient, useAccount } from '../account/AccountProvider';
import { LibraryProvider } from '../data/library';
import { RealtimeProvider, useRealtime } from '../data/realtime';
import { DownloadsProvider } from '../downloads/DownloadsProvider';
import { PlaybackProvider, usePlaybackState } from '../playback';
import { StreamingCacheProvider } from '../streamingCache/StreamingCacheProvider';
import { TvConnect, TvSignIn } from './Auth';
import { TvBrowse, type BrowseRoute } from './Browse';
import { TvNowPlaying, TvRemoteTransport } from './NowPlaying';
import { TvSettings } from './Settings';
import { TvButton, TvControl, tvColors } from './ui';

const secondaryTabs = [
  { screen: 'library', label: 'Library' },
  { screen: 'search', label: 'Search' }, { screen: 'settings', label: 'Settings' },
] as const;
type Tab = 'home' | typeof secondaryTabs[number]['screen'];

export function TvApp() {
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>
    <AccountProvider>
      <RealtimeProvider>
        <LibraryProvider>
          <DownloadsProvider>
            <StreamingCacheProvider>
              <PlaybackProvider><TvRoutes /></PlaybackProvider>
            </StreamingCacheProvider>
          </DownloadsProvider>
        </LibraryProvider>
      </RealtimeProvider>
    </AccountProvider>
  </QueryClientProvider>;
}

function TvRoutes() {
  const { state, switchServer } = useAccount();
  const signingIn = state.status === 'signIn';
  useTvBack(signingIn, switchServer);
  useEffect(() => { if (state.status !== 'restoring') SplashScreen.hide(); }, [state.status]);

  if (state.status === 'restoring') {
    return <View style={styles.loading}><BrandMark size={90} /><ActivityIndicator color={tvColors.accent} /></View>;
  }
  if (state.status === 'connect') return <TvConnect />;
  if (state.status === 'signIn') return <TvSignIn key={state.server.url} server={state.server} notice={state.notice} />;
  return <TvShell key={`${state.server.url}|${state.user.id}`} />;
}

function useTvBack(enabled: boolean, back: () => void) {
  useEffect(() => {
    if (!enabled) return;
    TVEventControl.enableTVMenuKey();
    const listener = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => { listener.remove(); TVEventControl.disableTVMenuKey(); };
  }, [back, enabled]);
}

function TvShell() {
  const [tab, setTab] = useState<Tab>('home');
  const [details, setDetails] = useState<BrowseRoute[]>([]);
  const [player, setPlayer] = useState(false);
  const [returnToPlayerButton, setReturnToPlayerButton] = useState(false);
  const { offline } = useRealtime();
  const { track } = usePlaybackState();
  const back = useCallback(() => {
    if (player) {
      setReturnToPlayerButton(true);
      setPlayer(false);
    } else setDetails(stack => stack.slice(0, -1));
  }, [player]);
  const navigate = useCallback((route: BrowseRoute) => setDetails(stack => [...stack, route]), []);
  const selectTab = (next: Tab) => { setTab(next); setDetails([]); };
  useTvBack(player || details.length > 0, back);
  return <View style={styles.app}>
    <TvRemoteTransport />
    <View style={[styles.app, player && styles.hidden]} accessibilityElementsHidden={player}>
      <View style={styles.header}>
        <View style={styles.brandColumn}>
          <TvControl accessibilityLabel="Home" selected={tab === 'home'} onPress={() => selectTab('home')}
            style={[styles.brand, tab === 'home' && styles.brandSelected]} focusedStyle={styles.brandFocused}>
            {focused => <><BrandMark size={44} /><Text style={[styles.brandName, focused && styles.brandNameFocused]}>Squirmy</Text></>}
          </TvControl>
        </View>
        <View style={styles.tabs}>
          {secondaryTabs.map(item => <TvButton key={item.screen} label={item.label} tone="quiet" selected={tab === item.screen}
            onPress={() => selectTab(item.screen)} />)}
        </View>
        <View style={styles.playerControl}>
          {offline && <Text style={styles.offline}>Offline</Text>}
          <TvButton label="Now Playing" accessibilityLabel={track ? `Now Playing, ${track.title}` : 'Now Playing'}
            hasTVPreferredFocus={returnToPlayerButton} onFocus={() => setReturnToPlayerButton(false)}
            onPress={() => setPlayer(true)} tone="surface" />
        </View>
      </View>
      <View style={styles.app}>
        <TVFocusGuideView autoFocus enabled={details.length === 0} style={styles.app}>
          {tab === 'settings' ? <TvSettings /> : <TvBrowse key={tab} route={{ screen: tab }} navigate={navigate} back={back} active={details.length === 0 && !player} />}
        </TVFocusGuideView>
        {details.map((route, index) => {
          const active = index === details.length - 1 && !player;
          return <TVFocusGuideView key={index} autoFocus enabled={index === details.length - 1} style={styles.app}>
            <TvBrowse route={route} navigate={navigate} back={back} active={active} />
          </TVFocusGuideView>;
        })}
      </View>
    </View>
    {player && <TvNowPlaying onBack={back} />}
  </View>;
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: tvColors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: tvColors.background, gap: 28 },
  hidden: { display: 'none' },
  header: { minHeight: 121, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 74, paddingTop: 36, paddingBottom: 18, gap: 15 },
  brandColumn: { flex: 1, alignItems: 'flex-start' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 8, paddingHorizontal: 13, borderRadius: 23, borderWidth: 2, borderColor: 'transparent' },
  brandSelected: { borderColor: tvColors.border },
  brandFocused: { backgroundColor: tvColors.text, borderColor: tvColors.text, transform: [{ scale: 1.06 }] },
  brandName: { color: tvColors.text, fontWeight: '800', fontSize: 32, letterSpacing: -0.8 },
  brandNameFocused: { color: tvColors.ink },
  tabs: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  playerControl: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 18 },
  offline: { color: tvColors.muted, fontSize: 24 },
});
