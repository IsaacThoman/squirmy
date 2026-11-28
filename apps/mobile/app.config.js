const { withPodfileProperties } = require('expo/config-plugins');

// The TV app's system context menus and menu buttons need tvOS 17, which every Apple TV that ran 16 can run.
const tvosDeploymentTarget = '17.0';
const withTvPods = config => withPodfileProperties(config, mod => {
  mod.modResults['ios.deploymentTarget'] = tvosDeploymentTarget;
  return mod;
});

module.exports = ({ config }) => {
  const variant = process.env.SQUIRMY_APP_VARIANT;
  const development = variant === 'development';
  // Xcode's bundling phase does not pass EXPO_TV on, but names the platform it builds for.
  const tv = process.env.EXPO_TV === '1' || /^appletv/.test(process.env.PLATFORM_NAME ?? '');
  // The native audio engine's Info.plist keys, for the phone and the TV alike.
  const plugins = [...config.plugins, ['expo-dev-client', { addGeneratedScheme: false }], './modules/audio-engine/app.plugin.js'];

  if (tv) {
    return {
      ...config,
      orientation: 'landscape',
      userInterfaceStyle: 'dark',
      version: process.env.SQUIRMY_IOS_VERSION ?? config.version,
      ios: {
        ...config.ios,
        icon: config.icon,
        buildNumber: process.env.SQUIRMY_IOS_BUILD_NUMBER ?? config.ios.buildNumber,
        infoPlist: { ...config.ios.infoPlist, UIBackgroundModes: ['audio'] },
      },
      plugins: [
        ...plugins.filter(plugin => plugin !== 'expo-router' && plugin[0] !== 'expo-splash-screen'),
        ['expo-router', { root: './tv-app' }],
        ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 190, backgroundColor: '#12101C' }],
        ['@react-native-tvos/config-tv', { isTV: true, tvosDeploymentTarget, appleTVImages: require('./assets/tv/brand-assets.cjs') }],
        withTvPods,
      ],
    };
  }

  // Siri, Shortcuts and Spotlight, the widgets and the Live Activity, on the phone only.
  // SQUIRMY_IOS_WIDGETS=0 leaves out the widget extension and its App Group.
  plugins.push(['./modules/app-intents/app.plugin.js', { widgets: process.env.SQUIRMY_IOS_WIDGETS !== '0' }]);

  if (!development) {
    return {
      ...config,
      version: process.env.SQUIRMY_IOS_VERSION ?? config.version,
      ios: {
        ...config.ios,
        buildNumber: process.env.SQUIRMY_IOS_BUILD_NUMBER ?? config.ios.buildNumber,
      },
      plugins,
    };
  }

  return {
    ...config,
    name: 'Squirmy Dev',
    scheme: 'squirmy-dev',
    ios: {
      ...config.ios,
      bundleIdentifier: 'com.isaacthoman.music.dev',
      infoPlist: {
        ...config.ios.infoPlist,
        NSLocalNetworkUsageDescription: 'Squirmy Dev connects to your music server, and to Metro on your Mac to load the latest app code.',
      },
    },
    android: { ...config.android, package: 'com.isaacthoman.music.dev' },
    plugins,
  };
};
