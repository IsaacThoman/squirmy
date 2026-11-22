import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MiniPlayer } from '../../src/MiniPlayer';
import { usesNativeTabs } from '../../src/tabChrome';
import { useColors } from '../../src/theme';
import { Icon } from '../../src/ui';

const tabs = [
  { route: '(home)', label: 'Home', icon: 'music.note.house' },
  { route: '(library)', label: 'Library', icon: 'music.note.list' },
  { route: '(search)', label: 'Search', icon: 'magnifyingglass' },
] as const;

function Accessory() {
  return <MiniPlayer native compact={NativeTabs.BottomAccessory.usePlacement() === 'inline'} />;
}

export default function TabLayout() {
  const colors = useColors();
  if (!usesNativeTabs()) return <FallbackTabs />;

  return (
    <NativeTabs tintColor={colors.accent} labelStyle={{ color: colors.muted }} minimizeBehavior="never">
      <NativeTabs.BottomAccessory><Accessory /></NativeTabs.BottomAccessory>
      <NativeTabs.Trigger name="(home)" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Icon sf={{ default: 'music.note.house', selected: 'music.note.house.fill' }} />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(library)" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Icon sf="music.note.list" />
        <NativeTabs.Trigger.Label>Library</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(search)" disableAutomaticContentInsets disableScrollToTop>
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function FallbackTabs() {
  const colors = useColors();
  const { bottom } = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <Tabs screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.stroke },
        tabBarLabelStyle: styles.label,
        tabBarHideOnKeyboard: true,
      }}>
        {tabs.map(tab => <Tabs.Screen key={tab.route} name={tab.route} options={{
          title: tab.label,
          tabBarIcon: ({ color, size }) => <Icon name={tab.icon} color={color} size={size} />,
        }} />)}
      </Tabs>
      <BlurView tint="systemMaterial" intensity={50} style={[styles.floating, {
        bottom: 69 + bottom, borderColor: colors.stroke, backgroundColor: colors.floating,
      }]}>
        <MiniPlayer />
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  label: { fontSize: 11, fontWeight: '600' },
  floating: { position: 'absolute', left: 14, right: 14, height: 60, borderRadius: 30, overflow: 'hidden', borderWidth: 1 },
});
