import { type PlatformSpec } from "./cli";
import { type Deps, must, type Platform, ShotError } from "./core";
import { REPORTS_DIR } from "./tooling";

export function nativeFingerprint(
  d: Deps,
  repo: string,
  spec: PlatformSpec,
): string {
  const argv = [
    "bunx",
    "@expo/fingerprint",
    "fingerprint:generate",
    "--platform",
    spec.fingerprintPlatform,
  ];
  if (spec.fingerprintPlatform === "android")
    argv.push(
      "--ignore-path",
      "scripts/ios/**/*",
      "--ignore-path",
      "targets/**/*",
    );
  const out = must(
    d.exec(argv, { cwd: repo, env: { EXPO_TV: spec.tv ? "1" : "0" } }),
    "fingerprint:generate",
  );
  const parsed = JSON.parse(out);
  if (!parsed.sources?.some?.((s: { id: string }) => s.id === "expoConfig"))
    throw new ShotError(
      "the fingerprint has no expoConfig source; it would match builds it should not",
    );
  return parsed.hash as string;
}

export interface BuildResult {
  artifact: string;
  built: boolean;
}

/**
 * A debug client is native code: reuse the cached artifact for the same native
 * fingerprint, rebuild otherwise. Never a CI release artifact.
 */
export function ensureDebugBuild(
  d: Deps,
  repo: string,
  platform: Platform,
  spec: PlatformSpec,
  hash: string,
  sessionDir: string,
): BuildResult {
  const cacheDir = `${repo}/${REPORTS_DIR}/build-cache/${platform}/${hash}`;
  const cached = d.fs.exists(cacheDir) ? d.fs.list(cacheDir)[0] : undefined;
  if (cached) return { artifact: `${cacheDir}/${cached}`, built: false };
  if (platform === "android" || platform === "android-tv") {
    // Gradle's codegen shells out to `node` inside module dirs; where node is an asdf
    // shim and a module ships a .tool-versions without nodejs, the shim aborts. The
    // env override pins the runner's node for every nested invocation — inert when
    // node is not shimmed.
    const nodeVersion = d
      .exec(["node", "--version"])
      .stdout.trim()
      .replace(/^v/, "");
    must(
      d.exec(["./gradlew", "assembleDebug"], {
        cwd: `${repo}/android`,
        env: {
          EXPO_TV: spec.tv ? "1" : "0",
          ...(nodeVersion ? { ASDF_NODEJS_VERSION: nodeVersion } : {}),
        },
      }),
      "gradle assembleDebug",
    );
    const apk = `${repo}/android/app/build/outputs/apk/debug/app-debug.apk`;
    if (!d.fs.exists(apk))
      throw new ShotError(`gradle built but ${apk} is missing`);
    d.fs.mkdir(cacheDir);
    d.fs.cp(apk, `${cacheDir}/app-debug.apk`);
    return { artifact: `${cacheDir}/app-debug.apk`, built: true };
  }
  const sdk = platform === "apple-tv" ? "appletvsimulator" : "iphonesimulator";
  const derived = `${sessionDir}/DerivedData`;
  // The prebuild names the project after the ref's app name, so read it back.
  const workspace = d.fs
    .list(`${repo}/ios`)
    .find((name) => name.endsWith(".xcworkspace"));
  if (!workspace)
    throw new ShotError(`prebuild produced no .xcworkspace under ${repo}/ios`);
  must(
    d.exec(
      [
        "xcodebuild",
        "-workspace",
        `${repo}/ios/${workspace}`,
        "-scheme",
        workspace.replace(/\.xcworkspace$/, ""),
        "-configuration",
        "Debug",
        "-sdk",
        sdk,
        "-derivedDataPath",
        derived,
        "build",
      ],
      { cwd: repo, env: { EXPO_TV: spec.tv ? "1" : "0" } },
    ),
    "xcodebuild debug",
  );
  const apps = d.fs.exists(`${derived}/Build/Products/Debug-${sdk}`)
    ? d.fs
        .list(`${derived}/Build/Products/Debug-${sdk}`)
        .filter((name) => name.endsWith(".app"))
    : [];
  if (!apps.length)
    throw new ShotError(`xcodebuild produced no .app under Debug-${sdk}`);
  d.fs.mkdir(cacheDir);
  d.fs.cp(
    `${derived}/Build/Products/Debug-${sdk}/${apps[0]}`,
    `${cacheDir}/${apps[0]}`,
  );
  return { artifact: `${cacheDir}/${apps[0]}`, built: true };
}

/** Latest aapt in the Android SDK build-tools — reads the APK's real applicationId. */
function aaptPath(d: Deps): string {
  const sdk = d.env.ANDROID_HOME ?? `${d.env.HOME ?? ""}/Library/Android/sdk`;
  const tools = d.fs.exists(`${sdk}/build-tools`)
    ? d.fs.list(`${sdk}/build-tools`).sort()
    : [];
  const aapt = tools.length
    ? `${sdk}/build-tools/${tools[tools.length - 1]}/aapt`
    : "";
  if (!aapt || !d.fs.exists(aapt))
    throw new ShotError(
      `Android build-tools aapt not found under ${sdk} — it is needed to read the built APK's applicationId`,
    );
  return aapt;
}

/**
 * Install the artifact and report its exact applicationId. On Android the id comes
 * from aapt badging of the APK itself — a production install on the same emulator may
 * share the "streamyfin" substring, so pm list could hand us the wrong package to
 * clear and launch.
 */
export function appIdOnDevice(
  d: Deps,
  platform: Platform,
  device: string,
  artifact: string,
): string {
  if (platform === "android" || platform === "android-tv") {
    const badging = must(
      d.exec([aaptPath(d), "dump", "badging", artifact]),
      "aapt dump badging",
    );
    const id = badging.match(/package: name='([^']+)'/)?.[1];
    if (!id)
      throw new ShotError("aapt could not read the built APK's applicationId");
    // Overwrites whatever copy of the id is on the emulator, a leftover from an earlier
    // run included: the runner clears the app's data on every pass anyway. A copy
    // signed with another key refuses the update, so it is removed and installed again.
    const install = () =>
      d.exec(["adb", "-s", device, "install", "-r", artifact]);
    let installed = install();
    if (
      installed.code !== 0 &&
      `${installed.stdout}${installed.stderr}`.includes(
        "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
      )
    ) {
      must(d.exec(["adb", "-s", device, "uninstall", id]), "adb uninstall");
      installed = install();
    }
    must(installed, "adb install");
    return id;
  }
  const plist = `${artifact}/Info.plist`;
  const plistResult = d.exec([
    "/usr/libexec/PlistBuddy",
    "-c",
    "Print :CFBundleIdentifier",
    plist,
  ]);
  if (plistResult.code !== 0)
    throw new ShotError(`cannot read the built app's bundle id from ${plist}`);
  const id = plistResult.stdout.trim();
  must(
    d.exec(["xcrun", "simctl", "install", device, artifact]),
    "simctl install",
  );
  return id;
}
