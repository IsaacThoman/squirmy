const fs = require('node:fs');
const path = require('node:path');
const { IOSConfig, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('expo/config-plugins');

/**
 * Squirmy outside the app on iOS: App Intents for Siri, Shortcuts, Spotlight and the widgets'
 * buttons, compiled into the app target (the App Intents metadata processor reads only the
 * app's own Swift, not a pod's static library), and a WidgetKit extension with the Home Screen
 * and Lock Screen widgets and the Live Activity. Both read what the app writes in one App Group
 * container, `group.<bundle id>`.
 *
 * `widgets: false` builds the app without the extension and the App Group, for a team whose
 * provisioning profiles do not have the App Group yet; Siri and Shortcuts still work.
 */

const appGroupKey = 'SquirmyAppGroup';
const schemeKey = 'SquirmyURLScheme';
const groupEntitlement = 'com.apple.security.application-groups';
const extensionName = 'SquirmyWidgets';
const sceneOriginal = 'class SceneDelegate: ExpoAppSceneDelegate {';
const sceneReplacement = 'class SceneDelegate: SquirmySceneDelegate {';

/** Swift each target compiles, from this module's folders. */
const sources = {
  // The app target: its own files, the intents the widgets' buttons share, and the snapshot model.
  app: ['app', 'intents', 'shared'],
  widgets: ['widgets', 'intents', 'shared'],
};

const swiftIn = folder => fs.readdirSync(path.join(__dirname, folder)).filter(name => name.endsWith('.swift')).sort();

const appGroupOf = config => `group.${config.ios.bundleIdentifier}`;

module.exports = (config, { widgets = true } = {}) => {
  config = withEntitlementsPlist(config, mod => {
    const groups = (mod.modResults[groupEntitlement] ?? []).filter(group => group !== appGroupOf(mod));
    if (widgets) groups.push(appGroupOf(mod));
    if (groups.length) mod.modResults[groupEntitlement] = groups;
    else delete mod.modResults[groupEntitlement];
    return mod;
  });

  config = withInfoPlist(config, mod => {
    const plist = mod.modResults;
    if (widgets) {
      plist[appGroupKey] = appGroupOf(mod);
      // Updated from the app while it runs; nothing is pushed from the server.
      plist.NSSupportsLiveActivities = true;
    } else {
      delete plist[appGroupKey];
      delete plist.NSSupportsLiveActivities;
    }
    return mod;
  });

  return withXcodeProject(config, mod => {
    const project = mod.modResults;
    const sourceRoot = IOSConfig.Paths.getSourceRoot(mod.modRequest.projectRoot);
    const groupName = path.basename(sourceRoot);
    const iosRoot = path.dirname(sourceRoot);

    // React Native starts once per process: in the phone's window, or without one when Siri,
    // Shortcuts or a widget launches the app in the background (`SquirmySceneDelegate`).
    const sceneDelegatePath = path.join(sourceRoot, 'SceneDelegate.swift');
    const sceneDelegate = fs.readFileSync(sceneDelegatePath, 'utf8');
    if (!sceneDelegate.includes(sceneOriginal) && !sceneDelegate.includes(sceneReplacement)) {
      throw new Error('Squirmy’s App Intents could not find Expo’s generated scene delegate.');
    }
    fs.writeFileSync(sceneDelegatePath, sceneDelegate.replace(sceneOriginal, sceneReplacement));

    for (const folder of sources.app) {
      for (const name of swiftIn(folder)) {
        fs.copyFileSync(path.join(__dirname, folder, name), path.join(sourceRoot, name));
        const filepath = path.posix.join(groupName, name);
        if (!project.hasFile(filepath)) {
          IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName, project });
        }
      }
    }

    const existing = project.pbxTargetByName(extensionName);
    if (!widgets) {
      if (existing) throw new Error(`Run prebuild with --clean to remove the ${extensionName} target.`);
      return mod;
    }
    writeExtensionFiles(path.join(iosRoot, extensionName), mod);
    if (!existing) addExtensionTarget(project, mod);
    return mod;
  });
};

/** The extension's folder in `ios/`: its Swift, Info.plist and entitlements, written again on every prebuild. */
function writeExtensionFiles(folder, mod) {
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  for (const source of sources.widgets) {
    for (const name of swiftIn(source)) fs.copyFileSync(path.join(__dirname, source, name), path.join(folder, name));
  }
  const { version, ios } = mod;
  fs.writeFileSync(path.join(folder, 'Info.plist'), plist({
    CFBundleDevelopmentRegion: '$(DEVELOPMENT_LANGUAGE)',
    CFBundleDisplayName: mod.name,
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: '$(PRODUCT_BUNDLE_PACKAGE_TYPE)',
    // An extension's versions must be the app's, which prebuild writes into the app's Info.plist.
    CFBundleShortVersionString: version,
    CFBundleVersion: ios.buildNumber ?? '1',
    NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' },
    [appGroupKey]: appGroupOf(mod),
    [schemeKey]: Array.isArray(mod.scheme) ? mod.scheme[0] : mod.scheme,
  }));
  fs.writeFileSync(path.join(folder, `${extensionName}.entitlements`), plist({ [groupEntitlement]: [appGroupOf(mod)] }));
}

/**
 * Adds the extension target: its sources, its build settings, and the app's dependency on it
 * and copy of it into `PlugIns/`. The `xcode` package's `addTarget` makes the configuration
 * list, the product, the target and the copy phase; the rest is filled in here.
 */
function addExtensionTarget(project, mod) {
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  const bundleId = `${mod.ios.bundleIdentifier}.widgets`;
  const target = project.addTarget(extensionName, 'app_extension', extensionName, bundleId);

  // `addTarget` names the product after the target, without the `.appex` an extension needs.
  const productRef = target.pbxNativeTarget.productReference;
  const product = objects.PBXFileReference[productRef];
  product.path = `"${extensionName}.appex"`;
  delete product.name;
  // The writer prints undefined fields as `undefined`.
  for (const key of Object.keys(product)) if (product[key] === undefined) delete product[key];
  objects.PBXFileReference[`${productRef}_comment`] = `${extensionName}.appex`;
  for (const [key, file] of Object.entries(objects.PBXBuildFile)) {
    if (typeof file === 'object' && file.fileRef === productRef) {
      file.fileRef_comment = `${extensionName}.appex`;
      objects.PBXBuildFile[`${key}_comment`] = `${extensionName}.appex in Embed Foundation Extensions`;
    }
  }
  for (const [key, phase] of Object.entries(objects.PBXCopyFilesBuildPhase)) {
    if (typeof phase === 'object' && phase.files.some(file => objects.PBXBuildFile[file.value]?.fileRef === productRef)) {
      phase.name = '"Embed Foundation Extensions"';
      objects.PBXCopyFilesBuildPhase[`${key}_comment`] = 'Embed Foundation Extensions';
      // Re-signed with the app; the extension is code that runs on its own.
      for (const file of phase.files) objects.PBXBuildFile[file.value].settings = { ATTRIBUTES: ['RemoveHeadersOnCopy'] };
    }
  }

  const files = [...new Set(sources.widgets.flatMap(swiftIn))];
  const group = project.addPbxGroup([], extensionName, extensionName);
  const children = group.pbxGroup.children;
  const buildFiles = [];
  for (const name of [...files, 'Info.plist', `${extensionName}.entitlements`]) {
    const ref = project.generateUuid();
    const type = name.endsWith('.swift') ? 'sourcecode.swift' : name.endsWith('.plist') ? 'text.plist.xml' : 'text.plist.entitlements';
    objects.PBXFileReference[ref] = { isa: 'PBXFileReference', lastKnownFileType: type, path: `"${name}"`, sourceTree: '"<group>"' };
    objects.PBXFileReference[`${ref}_comment`] = name;
    children.push({ value: ref, comment: name });
    if (!name.endsWith('.swift')) continue;
    const buildFile = project.generateUuid();
    objects.PBXBuildFile[buildFile] = { isa: 'PBXBuildFile', fileRef: ref, fileRef_comment: name };
    objects.PBXBuildFile[`${buildFile}_comment`] = `${name} in Sources`;
    buildFiles.push({ value: buildFile, comment: `${name} in Sources` });
  }
  const mainGroup = objects.PBXProject[project.hash.project.rootObject].mainGroup;
  objects.PBXGroup[mainGroup].children.push({ value: group.uuid, comment: extensionName });

  const sourcesPhase = project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  sourcesPhase.buildPhase.files.push(...buildFiles);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);

  const app = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName: IOSConfig.XcodeUtils.getProjectName(mod.modRequest.projectRoot) });
  const appSettings = buildSettingsOf(project, app.target.buildConfigurationList);
  const configurationList = objects.XCConfigurationList[target.pbxNativeTarget.buildConfigurationList];
  for (const { value } of configurationList.buildConfigurations) {
    const configuration = objects.XCBuildConfiguration[value];
    const app = appSettings[configuration.name] ?? {};
    Object.assign(configuration.buildSettings, {
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      CODE_SIGN_ENTITLEMENTS: `"${extensionName}/${extensionName}.entitlements"`,
      CODE_SIGN_STYLE: 'Automatic',
      CURRENT_PROJECT_VERSION: app.CURRENT_PROJECT_VERSION ?? 1,
      GENERATE_INFOPLIST_FILE: 'NO',
      INFOPLIST_FILE: `"${extensionName}/Info.plist"`,
      // The widgets' buttons and backgrounds need iOS 17; on iOS 16 the app runs without its widgets.
      IPHONEOS_DEPLOYMENT_TARGET: '17.0',
      LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
      MARKETING_VERSION: app.MARKETING_VERSION ?? '1.0',
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}"`,
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      SDKROOT: 'iphoneos',
      SKIP_INSTALL: 'YES',
      // The playback intents compile here too, for the widgets' buttons, but run in the app.
      SWIFT_ACTIVE_COMPILATION_CONDITIONS: configuration.name === 'Debug' ? '"DEBUG SQUIRMY_WIDGETS"' : 'SQUIRMY_WIDGETS',
      SWIFT_EMIT_LOC_STRINGS: 'YES',
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      ...(app.DEVELOPMENT_TEAM ? { DEVELOPMENT_TEAM: app.DEVELOPMENT_TEAM } : {}),
    });
    delete configuration.buildSettings.GCC_PREPROCESSOR_DEFINITIONS;
  }
}

function buildSettingsOf(project, listId) {
  const objects = project.hash.project.objects;
  return Object.fromEntries(objects.XCConfigurationList[listId].buildConfigurations.map(({ value }) => {
    const configuration = objects.XCBuildConfiguration[value];
    return [configuration.name, configuration.buildSettings];
  }));
}

function plist(value) {
  const encode = (item, indent) => {
    const pad = '  '.repeat(indent);
    if (Array.isArray(item)) return `${pad}<array>\n${item.map(entry => encode(entry, indent + 1)).join('')}${pad}</array>\n`;
    if (typeof item === 'boolean') return `${pad}<${item}/>\n`;
    if (typeof item === 'object') {
      return `${pad}<dict>\n${Object.entries(item).map(([key, entry]) => `${pad}  <key>${escape(key)}</key>\n${encode(entry, indent + 1)}`).join('')}${pad}</dict>\n`;
    }
    return `${pad}<string>${escape(String(item))}</string>\n`;
  };
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${encode(value, 0)}</plist>\n`;
}
