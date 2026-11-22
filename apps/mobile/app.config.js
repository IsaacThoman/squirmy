module.exports = ({ config }) => {
  const variant = process.env.SQUIRMY_APP_VARIANT;
  const development = variant === 'development';
  const plugins = [...config.plugins, ['expo-dev-client', { addGeneratedScheme: false }]];

  if (!development) return { ...config, plugins };

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
