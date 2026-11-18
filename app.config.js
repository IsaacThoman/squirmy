module.exports = ({ config }) => {
  const development = process.env.TONE_APP_VARIANT === 'development';
  const plugins = [...config.plugins, ['expo-dev-client', { addGeneratedScheme: false }]];

  if (!development) return { ...config, plugins };

  return {
    ...config,
    name: 'TONE Dev',
    scheme: 'tone-dev',
    ios: {
      ...config.ios,
      bundleIdentifier: 'com.isaacthoman.music.dev',
      infoPlist: {
        ...config.ios.infoPlist,
        NSLocalNetworkUsageDescription: 'TONE Dev connects to Metro on your Mac to load the latest app code.',
      },
    },
    android: { ...config.android, package: 'com.isaacthoman.music.dev' },
    plugins,
  };
};
