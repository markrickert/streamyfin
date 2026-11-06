import type { ExpoConfig } from "expo/config";
import {
  type ConfigPlugin,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} from "expo/config-plugins";

const EXTENSION_TARGET_NAME = "StreamyfinTopShelf";
const TARGET_SOURCE_DIR = "../targets/StreamyfinTopShelf";
const APP_GROUP_INFO_PLIST_KEY = "StreamyfinAppGroupIdentifier";

interface AppExtensionConfig {
  targetName: string;
  bundleIdentifier: string;
  entitlements: {
    "com.apple.security.application-groups": string[];
  };
}

function getBundleIdentifier(config: ExpoConfig): string {
  return config.ios?.bundleIdentifier || "com.fredrikburmester.streamyfin";
}

function getAppGroupIdentifier(config: ExpoConfig): string {
  return `group.${getBundleIdentifier(config)}.tvtopshelf`;
}

// The xcode project object has no usable typings — keep `any` here.
function getBuildConfigurations(project: any, configurationListId: string) {
  const configurationList =
    project.hash.project.objects.XCConfigurationList[configurationListId];

  if (!configurationList?.buildConfigurations) return [];

  const buildConfigurations = project.pbxXCBuildConfigurationSection();
  return configurationList.buildConfigurations
    .map((config: { value: string }) => buildConfigurations[config.value])
    .filter(Boolean);
}

function ensureAppGroup(value: unknown, appGroupIdentifier: string): string[] {
  const groups = Array.isArray(value) ? value : [];
  return groups.includes(appGroupIdentifier)
    ? groups
    : [...groups, appGroupIdentifier];
}

function ensureAppExtension(
  appExtensions: unknown,
  targetName: string,
  bundleIdentifier: string,
  appGroupIdentifier: string,
): AppExtensionConfig[] {
  const extensionConfig: AppExtensionConfig = {
    targetName,
    bundleIdentifier,
    entitlements: {
      "com.apple.security.application-groups": [appGroupIdentifier],
    },
  };
  const extensions: AppExtensionConfig[] = Array.isArray(appExtensions)
    ? appExtensions
    : [];
  // Keep plugin runs idempotent and preserve unrelated app extension entries.
  const existingIndex = extensions.findIndex(
    (appExtension) => appExtension?.targetName === targetName,
  );

  if (existingIndex === -1) {
    return [...extensions, extensionConfig];
  }

  return extensions.map((appExtension, index) =>
    index === existingIndex ? extensionConfig : appExtension,
  );
}

const withTVOSTopShelf: ConfigPlugin = (config) => {
  const appGroupIdentifier = getAppGroupIdentifier(config);
  const bundleIdentifier = getBundleIdentifier(config);
  const extensionBundleIdentifier = `${bundleIdentifier}.tvtopshelf`;
  const isTVBuild = process.env.EXPO_TV === "1";

  if (isTVBuild) {
    config.extra = {
      ...config.extra,
      eas: {
        ...config.extra?.eas,
        build: {
          ...config.extra?.eas?.build,
          experimental: {
            ...config.extra?.eas?.build?.experimental,
            ios: {
              ...config.extra?.eas?.build?.experimental?.ios,
              appExtensions: ensureAppExtension(
                config.extra?.eas?.build?.experimental?.ios?.appExtensions,
                EXTENSION_TARGET_NAME,
                extensionBundleIdentifier,
                appGroupIdentifier,
              ),
            },
          },
        },
      },
    };

    config = withInfoPlist(config, (config) => {
      config.modResults[APP_GROUP_INFO_PLIST_KEY] = appGroupIdentifier;
      return config;
    });

    config = withEntitlementsPlist(config, (config) => {
      config.modResults["com.apple.security.application-groups"] =
        ensureAppGroup(
          config.modResults["com.apple.security.application-groups"],
          appGroupIdentifier,
        );
      return config;
    });
  }

  if (!isTVBuild) {
    return config;
  }

  return withXcodeProject(config, (config) => {
    const project = config.modResults;

    if (project.pbxTargetByName(EXTENSION_TARGET_NAME)) {
      return config;
    }

    const target = project.addTarget(
      EXTENSION_TARGET_NAME,
      "app_extension",
      EXTENSION_TARGET_NAME,
      extensionBundleIdentifier,
    );

    project.addBuildPhase(
      [`${TARGET_SOURCE_DIR}/TopShelfProvider.swift`],
      "PBXSourcesBuildPhase",
      "Sources",
      target.uuid,
    );
    project.addBuildPhase(
      ["TVServices.framework"],
      "PBXFrameworksBuildPhase",
      "Frameworks",
      target.uuid,
    );

    const buildConfigurations = getBuildConfigurations(
      project,
      target.pbxNativeTarget.buildConfigurationList,
    );

    for (const buildConfig of buildConfigurations) {
      buildConfig.buildSettings = {
        ...buildConfig.buildSettings,
        CODE_SIGN_ENTITLEMENTS: `${TARGET_SOURCE_DIR}/${EXTENSION_TARGET_NAME}.entitlements`,
        APPLICATION_EXTENSION_API_ONLY: "YES",
        CURRENT_PROJECT_VERSION: "1",
        INFOPLIST_FILE: `${TARGET_SOURCE_DIR}/Info.plist`,
        IPHONEOS_DEPLOYMENT_TARGET:
          buildConfig.buildSettings.IPHONEOS_DEPLOYMENT_TARGET || "15.6",
        MARKETING_VERSION: config.version || "1.0",
        PRODUCT_BUNDLE_IDENTIFIER: extensionBundleIdentifier,
        PRODUCT_NAME: `"${EXTENSION_TARGET_NAME}"`,
        SDKROOT: "appletvos",
        SKIP_INSTALL: "YES",
        SWIFT_VERSION: "5.9",
        APP_GROUP_IDENTIFIER: appGroupIdentifier,
        SUPPORTED_PLATFORMS: '"appletvos appletvsimulator"',
        TARGETED_DEVICE_FAMILY: "3",
      };
    }

    return config;
  });
};

export default withTVOSTopShelf;
