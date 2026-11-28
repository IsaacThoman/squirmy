const fs = require('node:fs');
const path = require('node:path');
const {
  IOSConfig,
  withAppDelegate,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');

const sourceName = 'SquirmyCarPlayScenes.swift';
const carRole = 'CPTemplateApplicationSceneSessionRoleApplication';
const phoneRole = 'UIWindowSceneSessionRoleApplication';
const carEntitlement = 'com.apple.developer.carplay-audio';
const siriEntitlement = 'com.apple.developer.siri';
const playMedia = 'INPlayMediaIntent';
const music = 'INMediaCategoryMusic';
const siriUsage = 'Play music from your Squirmy library with Siri.';

module.exports = (config, { enabled = false } = {}) => {
  config = withEntitlementsPlist(config, (mod) => {
    const entitlements = mod.modResults;
    if (enabled) {
      entitlements[carEntitlement] = true;
      entitlements[siriEntitlement] = true;
    } else {
      delete entitlements[carEntitlement];
      delete entitlements[siriEntitlement];
    }
    return mod;
  });

  config = withInfoPlist(config, (mod) => {
    const plist = mod.modResults;
    const manifest = plist.UIApplicationSceneManifest ?? {};
    const scenes = manifest.UISceneConfigurations ?? {};

    if (enabled) {
      if (!scenes[phoneRole] && !mod.modRequest.introspect) {
        throw new Error('Squirmy CarPlay requires Expo’s generated phone scene.');
      }
      manifest.UIApplicationSupportsMultipleScenes = true;
      manifest.UISceneConfigurations = scenes;
      plist.UIApplicationSceneManifest = manifest;
      scenes[carRole] = [{
        UISceneConfigurationName: 'CarPlay',
        UISceneClassName: 'CPTemplateApplicationScene',
        UISceneDelegateClassName: 'SquirmyCarPlaySceneDelegate',
      }];
      plist.NSSiriUsageDescription ??= siriUsage;
      plist.INIntentsSupported = [...new Set([...(plist.INIntentsSupported ?? []), playMedia])];
      plist.INSupportedMediaCategories = [...new Set([...(plist.INSupportedMediaCategories ?? []), music])];
    } else if (scenes[carRole]) {
      // A developer can re-run prebuild with a different entitlement setting.
      const removeCarPlay = (key, value) => {
        const remaining = plist[key]?.filter((entry) => entry !== value);
        if (remaining?.length) plist[key] = remaining;
        else delete plist[key];
      };
      delete scenes[carRole];
      manifest.UIApplicationSupportsMultipleScenes = false;
      if (plist.NSSiriUsageDescription === siriUsage) delete plist.NSSiriUsageDescription;
      removeCarPlay('INIntentsSupported', playMedia);
      removeCarPlay('INSupportedMediaCategories', music);
    }
    return mod;
  });

  config = withAppDelegate(config, (mod) => {
    const appDelegate = mod.modResults;
    const delegateMarker = 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {';
    const carPlayDelegate = `${delegateMarker}
  func application(_ application: UIApplication, handlerFor intent: INIntent) -> Any? {
    guard intent is INPlayMediaIntent else { return nil }
    return SquirmyPlayMediaIntentHandler()
  }
`;
    if (enabled) {
      if (appDelegate.language !== 'swift' || !appDelegate.contents.includes(delegateMarker)) {
        throw new Error('Squirmy CarPlay could not find Expo’s generated app delegate.');
      }
      if (!appDelegate.contents.includes(carPlayDelegate)) {
        appDelegate.contents = 'import Intents\n' +
          appDelegate.contents.replace(delegateMarker, carPlayDelegate);
      }
    } else if (appDelegate.contents.includes(carPlayDelegate)) {
      appDelegate.contents = appDelegate.contents
        .replace(/^import Intents\n/, '')
        .replace(carPlayDelegate, delegateMarker);
    }
    return mod;
  });

  return withXcodeProject(config, (mod) => {
    const sourceRoot = IOSConfig.Paths.getSourceRoot(mod.modRequest.projectRoot);
    const sceneDelegatePath = path.join(sourceRoot, 'SceneDelegate.swift');
    if (!enabled && !fs.existsSync(sceneDelegatePath)) return mod;
    const sceneDelegate = fs.readFileSync(sceneDelegatePath, 'utf8');
    const original = 'class SceneDelegate: ExpoAppSceneDelegate {';
    const replacement = 'class SceneDelegate: SquirmyPhoneSceneDelegate {';
    const sourcePath = path.join(sourceRoot, sourceName);
    const groupName = path.basename(sourceRoot);
    const filepath = path.posix.join(groupName, sourceName);
    if (!enabled) {
      if (sceneDelegate.includes(replacement)) {
        fs.writeFileSync(sceneDelegatePath, sceneDelegate.replace(replacement, original));
      }
      if (mod.modResults.hasFile(filepath)) {
        const group = mod.modResults.findPBXGroupKey({ name: groupName });
        const target = mod.modResults.getTarget('com.apple.product-type.application')?.uuid;
        mod.modResults.removeSourceFile(filepath, { target }, group);
        fs.rmSync(sourcePath, { force: true });
      }
      return mod;
    }
    if (!sceneDelegate.includes(original) && !sceneDelegate.includes(replacement)) {
      throw new Error('Squirmy CarPlay could not find Expo’s generated phone scene delegate.');
    }
    fs.writeFileSync(sceneDelegatePath, sceneDelegate.replace(original, replacement));
    fs.copyFileSync(path.join(__dirname, 'plugin', sourceName), sourcePath);
    mod.modResults = IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath,
      groupName,
      project: mod.modResults,
    });
    return mod;
  });
};
