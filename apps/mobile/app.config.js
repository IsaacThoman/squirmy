module.exports = ({ config }) => {
  const variant = process.env.SQUIRMY_APP_VARIANT;
  const development = variant === 'development';
  const plugins = [
    ...config.plugins,
    ['expo-dev-client', { addGeneratedScheme: false }],
    ['./modules/carplay/app.plugin.js', { enabled: process.env.SQUIRMY_IOS_CARPLAY === '1' }],
  ];

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
