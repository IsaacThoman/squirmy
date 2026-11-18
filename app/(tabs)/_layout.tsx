import { BlurView } from 'expo-blur';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Tabs } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MiniPlayer } from '../../src/MiniPlayer';
import { colors, Icon } from '../../src/ui';

const tabs = [
  { route: '(home)', label: 'Home', icon: 'music.note.house' },
  { route: '(library)', label: 'Library', icon: 'music.note.list' },
  { route: '(search)', label: 'Search', icon: 'magnifyingglass' },
] as const;

function Accessory() {
  return <MiniPlayer native compact={NativeTabs.BottomAccessory.usePlacement() === 'inline'} />;
}

export default function TabLayout() {
  if (Platform.OS !== 'ios' || !isLiquidGlassAvailable()) return <FallbackTabs />;

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
  const { bottom } = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <Tabs screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: styles.bar,
        tabBarLabelStyle: styles.label,
        tabBarHideOnKeyboard: true,
      }}>
        {tabs.map(tab => <Tabs.Screen key={tab.route} name={tab.route} options={{
          title: tab.label,
          tabBarIcon: ({ color, size }) => <Icon name={tab.icon} color={color} size={size} />,
        }} />)}
      </Tabs>
      <BlurView tint="systemMaterialDark" intensity={50} style={[styles.floating, { bottom: 69 + bottom }]}>
        <MiniPlayer />
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: { backgroundColor: '#19161f', borderTopColor: '#ffffff18' },
  label: { fontSize: 11, fontWeight: '600' },
  floating: { position: 'absolute', left: 14, right: 14, height: 60, borderRadius: 30, overflow: 'hidden', borderWidth: 1, borderColor: '#ffffff26', backgroundColor: '#282333d9' },
});
