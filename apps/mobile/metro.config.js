const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (process.env.EXPO_TV === '1' || /^appletv/.test(process.env.PLATFORM_NAME ?? '')) {
  // Expo and Xcode still ask Metro for the iOS platform when bundling tvOS.
  const resolve = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const entry = context.originModulePath === `${__dirname}/index.js` && moduleName === './src/entry';
    return (resolve ?? context.resolveRequest)(context, entry ? './src/entry.tv' : moduleName, platform);
  };
}

module.exports = config;
