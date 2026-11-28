const { withInfoPlist } = require('expo/config-plugins');

/**
 * The native engine's Info.plist keys: background audio, and the long-form route-sharing
 * policy from launch, so iOS routes Squirmy as it does Music and Podcasts (the engine sets the
 * same policy when it activates the audio session).
 */
module.exports = config => withInfoPlist(config, mod => {
  const plist = mod.modResults;
  plist.AVInitialRouteSharingPolicy = 'LongFormAudio';
  const modes = plist.UIBackgroundModes ?? [];
  if (!modes.includes('audio')) plist.UIBackgroundModes = [...modes, 'audio'];
  return mod;
});
