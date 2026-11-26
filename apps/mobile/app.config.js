module.exports = ({ config }) => {
  const variant = process.env.SQUIRMY_APP_VARIANT;
  const development = variant === 'development';
  const tv = process.env.EXPO_TV === '1';
  const plugins = [...config.plugins, ['expo-dev-client', { addGeneratedScheme: false }]];

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
        ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 190, backgroundColor: '#12101C' }],
        ['@react-native-tvos/config-tv', { isTV: true, appleTVImages: require('./assets/tv/brand-assets.cjs') }],
      ],
    };
  }

  plugins.push(['./modules/carplay/app.plugin.js', { enabled: process.env.SQUIRMY_IOS_CARPLAY === '1' }]);

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
