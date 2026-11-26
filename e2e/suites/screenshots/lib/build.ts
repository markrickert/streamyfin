import { type PlatformSpec } from "./cli";
import { type Deps, must, type Platform, ShotError } from "./core";
import { simctlInstall } from "./device";
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

/** First ABI reported by an Android emulator, used to build and cache a matching APK. */
export function deviceAbi(d: Deps, device: string): string {
  const out = must(
    d.exec(["adb", "-s", device, "shell", "getprop", "ro.product.cpu.abilist"]),
    "adb getprop ro.product.cpu.abilist",
  );
  const abi = out.trim().split(",")[0]?.trim();
  if (!abi)
    throw new ShotError(
      `adb getprop ro.product.cpu.abilist returned no ABI for ${device}`,
    );
  return abi;
}

/** Env var naming an optional executable that populates a missing local build-cache entry. */
export const BUILD_CACHE_FETCH_ENV = "SHOTS_BUILD_CACHE_FETCH";

/** Set to "1" in capture jobs that reuse the native job's build cache and must never compile. */
export const NO_BUILD_ENV = "SHOTS_NO_BUILD";

/** Bound on the remote cache fetch hook so a stalled download falls back to a local build. */
export const BUILD_CACHE_FETCH_TIMEOUT_MS = 300_000;

export type BuildSource = "local" | "fetched" | "built";

export interface BuildResult {
  artifact: string;
  built: boolean;
  source: BuildSource;
  hash: string;
}

function findCachedArtifact(
  d: Deps,
  platform: Platform,
  cacheDir: string,
): string | undefined {
  if (!d.fs.exists(cacheDir)) return undefined;
  const entries = d.fs.list(cacheDir);
  const ext =
    platform === "android" || platform === "android-tv" ? ".apk" : ".app";
  const matches = entries.filter((name) => name.endsWith(ext));
  return matches.length === 1 ? `${cacheDir}/${matches[0]}` : undefined;
}

function tryFetchCachedBuild(
  d: Deps,
  platform: Platform,
  hash: string,
  cacheDir: string,
): string | undefined {
  const fetchExe = d.env[BUILD_CACHE_FETCH_ENV]?.trim();
  if (!fetchExe) return undefined;
  const result = d.exec([fetchExe, platform, hash, cacheDir], {
    timeoutMs: BUILD_CACHE_FETCH_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    const detail =
      (result.stderr || result.stdout).trim().split("\n")[0] ||
      `exit ${result.code}`;
    d.log(
      `build cache fetch failed for ${platform}/${hash} (${detail}); building locally`,
    );
    if (d.fs.exists(cacheDir)) d.fs.rm(cacheDir);
    return undefined;
  }
  const artifact = findCachedArtifact(d, platform, cacheDir);
  if (artifact) return artifact;
  d.log(
    `build cache fetch exited 0 for ${platform}/${hash} without a valid artifact; building locally`,
  );
  if (d.fs.exists(cacheDir)) d.fs.rm(cacheDir);
  return undefined;
}

/**
 * Version of how this runner produces a debug client. The app's fingerprint cannot see
 * runner changes such as the env of `pod install`, so bump this whenever one changes the
 * native output, or every cache keeps serving clients built the old way.
 */
export const DEV_CLIENT_RECIPE = "r2";

/**
 * A debug client is native code: reuse the cached artifact for the same native
 * fingerprint and recipe (locally, else via the fetch hook), rebuild otherwise. Never a
 * CI release artifact.
 */
export function ensureDebugBuild(
  d: Deps,
  repo: string,
  platform: Platform,
  spec: PlatformSpec,
  fingerprint: string,
  sessionDir: string,
  onBeforeBuild?: () => void,
  abi?: string,
): BuildResult {
  const isAndroid = platform === "android" || platform === "android-tv";
  if (isAndroid && !abi)
    throw new ShotError(`ABI is required to build or cache ${platform}`);
  const keyed = `${fingerprint}-${DEV_CLIENT_RECIPE}`;
  const hash = isAndroid ? `${keyed}-${abi}` : keyed;
  const cacheDir = `${repo}/${REPORTS_DIR}/build-cache/${platform}/${hash}`;
  const cached = findCachedArtifact(d, platform, cacheDir);
  if (cached) return { artifact: cached, built: false, source: "local", hash };
  const fetched = tryFetchCachedBuild(d, platform, hash, cacheDir);
  if (fetched)
    return { artifact: fetched, built: false, source: "fetched", hash };
  if (d.env[NO_BUILD_ENV] === "1")
    throw new ShotError(
      `no cached ${platform} build for ${hash} and ${NO_BUILD_ENV}=1: the native job did not provide it`,
    );
  onBeforeBuild?.();
  if (isAndroid) {
    // Gradle's codegen shells out to `node` inside module dirs; where node is an asdf
    // shim and a module ships a .tool-versions without nodejs, the shim aborts. The
    // env override pins the runner's node for every nested invocation — inert when
    // node is not shimmed.
    const nodeVersion = d
      .exec(["node", "--version"])
      .stdout.trim()
      .replace(/^v/, "");
    must(
      d.exec(
        ["./gradlew", "assembleDebug", `-PreactNativeArchitectures=${abi}`],
        {
          cwd: `${repo}/android`,
          env: {
            EXPO_TV: spec.tv ? "1" : "0",
            ...(nodeVersion ? { ASDF_NODEJS_VERSION: nodeVersion } : {}),
          },
        },
      ),
      "gradle assembleDebug",
    );
    const apk = `${repo}/android/app/build/outputs/apk/debug/app-debug.apk`;
    if (!d.fs.exists(apk))
      throw new ShotError(`gradle built but ${apk} is missing`);
    d.fs.mkdir(cacheDir);
    d.fs.cp(apk, `${cacheDir}/app-debug.apk`);
    return {
      artifact: `${cacheDir}/app-debug.apk`,
      built: true,
      source: "built",
      hash,
    };
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
  return {
    artifact: `${cacheDir}/${apps[0]}`,
    built: true,
    source: "built",
    hash,
  };
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
  simctlInstall(d, device, artifact, "simctl install");
  return id;
}
