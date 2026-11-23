/**
 * Dev-mode screenshot comparison: switch this checkout between two refs, run the same
 * Metro-backed capture on each plus a fresh "noise" pass on the before ref, and compare
 * with compare.ts. Everything that runs a subprocess or touches the filesystem goes
 * through Deps, so the orchestration is testable without a device, git, or Metro.
 *
 * Invariants this file protects:
 * - It never force-switches, stashes, resets, or deletes user files. A dirty tree refuses
 *   before the first `git switch`; restoration on failure/interrupt is `--detach`-safe.
 * - Metro and the build cache are owned by the runner: it only kills a Metro it spawned,
 *   on a port it proved free first, and never touches a preexisting process.
 * - ios/ and android/ are user state: they are moved into the session backup before a
 *   clean prebuild and restored afterwards, never deleted.
 * - Secrets ride process env into run.sh/maestro.py; they are never logged or echoed.
 */

export const PLATFORMS = ["ios", "android", "android-tv", "apple-tv"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface Cli {
  command: "doctor" | "run";
  /** doctor only: bring up what the runner itself would, instead of only reporting. */
  fix?: boolean;
  platform?: Platform;
  before?: string;
  after?: string;
  device?: string;
  outDir?: string;
  port?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnHandle {
  kill(): void;
  /** False once the child exited — a live /status after that is a foreign packager. */
  isAlive(): boolean;
}

export interface FsOps {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, data: string): void;
  mkdir(path: string): void;
  cp(src: string, dst: string): void;
  mv(src: string, dst: string): void;
  rm(path: string): void;
  list(path: string): string[];
}

export interface Deps {
  exec(
    argv: string[],
    opts?: { cwd?: string; env?: Record<string, string | undefined> },
  ): ExecResult;
  spawn(
    argv: string[],
    opts?: { cwd?: string; env?: Record<string, string | undefined> },
  ): SpawnHandle;
  waitFor(url: string, needle: string, timeoutMs: number): Promise<boolean>;
  fs: FsOps;
  env: Record<string, string | undefined>;
  log(message: string): void;
}

export class ShotError extends Error {}

/** How a device reaches this Mac: the Android emulator's alias for the host loopback, or the loopback itself. */
const hostFor = (platform: Platform) =>
  platform === "android" || platform === "android-tv"
    ? "10.0.2.2"
    : "127.0.0.1";

export function parseArgs(argv: string[]): Cli {
  const [command, ...rest] = argv;
  if (command !== "doctor" && command !== "run")
    throw new ShotError(
      "usage: shots.ts doctor [--fix] [--platform <p>] | run --platform <p> [--before <ref>] [--after <ref>] [--device <id>] [--out <dir>] [--port <port>]",
    );
  const flags: Record<string, string> = {};
  let fix = false;
  for (let i = 0; i < rest.length; i++) {
    if (command === "doctor" && rest[i] === "--fix") {
      fix = true;
      continue;
    }
    if (!rest[i].startsWith("--") || rest[i + 1] === undefined)
      throw new ShotError(`shots.ts: bad flag near '${rest[i]}'`);
    flags[rest[i].slice(2)] = rest[++i];
  }
  const cli: Cli = {
    command,
    fix,
    platform: flags.platform as Platform | undefined,
    before: flags.before,
    after: flags.after ?? "HEAD",
    device: flags.device,
    outDir: flags.out,
    port: flags.port ? Number(flags.port) : undefined,
  };
  if (
    cli.platform !== undefined &&
    !(PLATFORMS as readonly string[]).includes(cli.platform)
  )
    throw new ShotError(
      `shots.ts: --platform must be one of ${PLATFORMS.join(", ")}`,
    );
  if (command === "run") {
    if (!cli.platform)
      throw new ShotError("shots.ts run: --platform is required");
    if (
      cli.port !== undefined &&
      (!Number.isInteger(cli.port) || cli.port <= 0)
    )
      throw new ShotError("shots.ts run: --port must be a positive integer");
  }
  return cli;
}

interface PlatformSpec {
  tv: boolean;
  fingerprintPlatform: "ios" | "android";
  /** Forwarded as `maestro --platform`: the pinned fork's tvOS driver. */
  maestroPlatform?: "tvos";
  login: string;
  screens: string;
  seerrBootstrap: string;
  seerr: string;
  masks: string;
}

export function platformSpec(platform: Platform): PlatformSpec {
  switch (platform) {
    case "ios":
    case "android":
      return {
        tv: false,
        fingerprintPlatform: platform,
        login: "bootstrap-login-mobile",
        screens: "mobile",
        // Plugin-provisioned settings may already have the app connected: the ensure
        // flow runs the bootstrap only when the Discover switch is absent.
        seerrBootstrap: "ensure-seerr-mobile",
        seerr: "seerr-mobile",
        masks: `masks-${platform}-phone.json`,
      };
    case "android-tv":
      return {
        tv: true,
        fingerprintPlatform: "android",
        login: "bootstrap-login-tv",
        screens: "tv",
        seerrBootstrap: "bootstrap-seerr-tv",
        seerr: "seerr-tv",
        masks: "masks-android-tv.json",
      };
    case "apple-tv":
      return {
        tv: true,
        fingerprintPlatform: "ios",
        maestroPlatform: "tvos",
        login: "bootstrap-login-tv",
        screens: "tv",
        seerrBootstrap: "bootstrap-seerr-tv",
        seerr: "seerr-tv",
        masks: "masks-ios-tv.json",
      };
  }
}

function must(result: ExecResult, what: string): string {
  if (result.code !== 0)
    throw new ShotError(
      `${what} failed (${result.code}): ${result.stderr.trim()}`,
    );
  return result.stdout.trim();
}

/** must() for flows: Maestro stderr can echo -e values, so secrets are masked first. */
function mustSanitized(
  result: ExecResult,
  what: string,
  secrets: string[],
): string {
  if (result.code !== 0) {
    let stderr = result.stderr.trim().slice(0, 500);
    for (const secret of new Set(secrets))
      if (secret) stderr = stderr.split(secret).join("***");
    throw new ShotError(`${what} failed (${result.code}): ${stderr}`);
  }
  return result.stdout.trim();
}

export interface GitStart {
  /** Branch name when the run starts on a branch, the detached SHA otherwise. */
  ref: string;
  detached: boolean;
}

export function gitStart(d: Deps, repo: string): GitStart {
  const branch = d.exec(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: repo,
  });
  if (branch.code === 0) return { ref: branch.stdout.trim(), detached: false };
  const sha = must(
    d.exec(["git", "rev-parse", "HEAD"], { cwd: repo }),
    "git rev-parse HEAD",
  );
  return { ref: sha, detached: true };
}

export function preflight(
  d: Deps,
  repo: string,
  cli: Cli,
): { beforeSha: string; afterSha: string; start: GitStart } {
  const status = must(
    d.exec(["git", "status", "--porcelain", "--untracked-files=all"], {
      cwd: repo,
    }),
    "git status",
  );
  if (status)
    throw new ShotError(
      "working tree is not clean: commit, stash or move everything before running the comparison",
    );
  const beforeSha = must(
    d.exec(["git", "rev-parse", "--verify", `${cli.before}^{commit}`], {
      cwd: repo,
    }),
    `git rev-parse ${cli.before}`,
  );
  const afterSha = must(
    d.exec(["git", "rev-parse", "--verify", `${cli.after}^{commit}`], {
      cwd: repo,
    }),
    `git rev-parse ${cli.after}`,
  );
  if (beforeSha === afterSha)
    throw new ShotError("--before and --after resolve to the same commit");
  return { beforeSha, afterSha, start: gitStart(d, repo) };
}

export function selectDevice(
  d: Deps,
  platform: Platform,
  device: string | undefined,
): string {
  if (platform === "ios" || platform === "apple-tv") {
    const json = must(
      d.exec(["xcrun", "simctl", "list", "devices", "booted", "-j"]),
      "simctl list",
    );
    // simctl groups devices under per-runtime keys
    // ("com.apple.CoreSimulator.SimRuntime.iOS-…", "…tvOS-…"), not a flat array.
    const booted = Object.entries(
      JSON.parse(json).devices as Record<
        string,
        { udid: string; name: string }[]
      >,
    ).flatMap(([runtime, devs]) =>
      devs.map((dev) => ({ ...dev, tv: runtime.includes("tvOS") })),
    );
    const tv = platform === "apple-tv";
    const kind = tv ? "Apple TV" : "iPhone/iPad";
    if (device) {
      if (booted.every((dev) => dev.udid !== device))
        throw new ShotError(
          `${device} is not a booted simulator; only simulators can be re-provisioned`,
        );
      if (booted.find((dev) => dev.udid === device)!.tv !== tv)
        throw new ShotError(
          `${device} is booted but is not a ${kind} simulator`,
        );
      return device;
    }
    const candidates = booted.filter((dev) => dev.tv === tv);
    if (candidates.length === 0)
      throw new ShotError(`no booted ${kind} simulator`);
    if (candidates.length > 1)
      throw new ShotError(
        `${candidates.length} ${kind} simulators are booted — pass --device`,
      );
    return candidates[0].udid;
  }
  const lines = must(d.exec(["adb", "devices"]), "adb devices")
    .split("\n")
    .filter((line) => line.endsWith("\tdevice") || line.endsWith(" device"))
    .map((line) => line.split(/\s+/)[0]);
  const emulators = lines.filter((serial) => serial.startsWith("emulator-"));
  let serial: string;
  if (device) {
    if (!emulators.includes(device))
      throw new ShotError(
        `${device} is not an Android emulator; only emulators can be re-provisioned`,
      );
    serial = device;
  } else {
    if (emulators.length === 0)
      throw new ShotError("no Android emulator running");
    if (emulators.length > 1)
      throw new ShotError(
        `${emulators.length} Android emulators are running — pass --device`,
      );
    serial = emulators[0];
  }
  // An Android TV emulator looks identical to a phone in `adb devices`; the only
  // reliable discriminator is the leanback feature. Check before install/clearState.
  // `pm has-feature` prints true/false but also exits 1 for "absent", so the answer
  // lives in stdout — a non-boolean output is the only real failure.
  const feature = d.exec([
    "adb",
    "-s",
    serial,
    "shell",
    "pm",
    "has-feature",
    "android.software.leanback",
  ]);
  const leanback = feature.stdout.trim();
  if (leanback !== "true" && leanback !== "false")
    throw new ShotError(
      `pm has-feature did not answer on ${serial} (exit ${feature.code}): ${feature.stderr.trim()}`,
    );
  const isTv = leanback === "true";
  if (platform === "android-tv" && !isTv)
    throw new ShotError(
      `${serial} is not an Android TV emulator (no leanback)`,
    );
  if (platform === "android" && isTv)
    throw new ShotError(`${serial} is an Android TV emulator, not a phone`);
  return serial;
}

export function ensurePortFree(d: Deps, port: number): void {
  const result = d.exec(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  if (result.stdout.trim())
    throw new ShotError(
      `port ${port} is already listening — pass --port for another; the runner never stops a foreign process`,
    );
  // lsof exits 1 with empty output when nothing listens; anything else (missing
  // lsof, a bad flag) must fail loudly instead of passing as "free".
  if (result.code !== 0 && result.code !== 1)
    throw new ShotError(
      `cannot verify port ${port} is free (lsof exited ${result.code}): ${result.stderr.trim()}`,
    );
}

/**
 * The pinned Maestro every platform runs through. Upstream Maestro hangs on tvOS
 * (mobile-dev-inc/Maestro#3021 is unmerged), so this is plexinc/Maestro, downloaded into
 * the ignored tools cache with its release checksum verified. The cache is keyed by tag:
 * bumping the pin makes the old binary count as missing. The user's global maestro is
 * never used or touched.
 */
export const MAESTRO_TAG = "cli-2.8.0.6";
export const MAESTRO_SHA256 =
  "fd9abfd350659585e9b317877a38dc159b0dda4bb6c4f081a3f79d3388a90ea3";

const maestroBinary = (toolsDir: string) =>
  `${toolsDir}/${MAESTRO_TAG}/maestro/bin/maestro`;

export function ensureMaestro(d: Deps, toolsDir: string): string {
  const binary = maestroBinary(toolsDir);
  if (d.fs.exists(binary)) return binary;
  const url = `https://github.com/plexinc/Maestro/releases/download/${MAESTRO_TAG}/maestro.zip`;
  const zip = `${toolsDir}/maestro-${MAESTRO_TAG}.zip`;
  const dest = `${toolsDir}/${MAESTRO_TAG}`;
  d.fs.mkdir(toolsDir);
  must(d.exec(["curl", "-fsSL", url, "-o", zip]), "download maestro");
  const sha = must(
    d.exec(["shasum", "-a", "256", zip]),
    "checksum maestro",
  ).split(/\s+/)[0];
  if (sha !== MAESTRO_SHA256) {
    d.fs.rm(zip);
    throw new ShotError(
      `maestro ${MAESTRO_TAG} checksum mismatch: got ${sha}, want ${MAESTRO_SHA256}`,
    );
  }
  // A half-unpacked earlier attempt must not mix into this one.
  d.fs.rm(dest);
  must(d.exec(["unzip", "-q", zip, "-d", dest]), "unzip maestro");
  must(d.exec(["chmod", "+x", binary]), "chmod maestro");
  d.fs.rm(zip);
  if (!d.fs.exists(binary))
    throw new ShotError(`maestro ${MAESTRO_TAG} unpacked without ${binary}`);
  return binary;
}

export function snapshotTooling(
  d: Deps,
  repo: string,
  sessionDir: string,
): string {
  const tooling = `${sessionDir}/tooling`;
  const suite = `${repo}/e2e/suites/screenshots`;
  d.fs.mkdir(`${tooling}/flows`);
  for (const file of [
    "shots.ts",
    "shots-lib.ts",
    "compare.ts",
    "run.sh",
    "ios-disable-autofill.sh",
  ])
    d.fs.cp(`${suite}/${file}`, `${tooling}/${file}`);
  for (const mask of d.fs
    .list(suite)
    .filter((name) => name.startsWith("masks-")))
    d.fs.cp(`${suite}/${mask}`, `${tooling}/${mask}`);
  for (const flow of d.fs.list(`${suite}/flows`))
    d.fs.cp(`${suite}/flows/${flow}`, `${tooling}/flows/${flow}`);
  d.fs.cp(`${repo}/e2e/bench/maestro.py`, `${tooling}/maestro.py`);
  return tooling;
}

const DEFAULT_PORT = 18081;

/** Ignored root for sessions, the build cache, and the pinned maestro. */
const REPORTS_DIR = "e2e/reports/shots";

/** Read the persisted fixture .env, tolerating its absence (doctor runs without one). */
export function fixtureDotenv(d: Deps, repo: string): Record<string, string> {
  const path = `${repo}/e2e/suites/syncplay/.env`;
  if (!d.fs.exists(path)) return {};
  return Object.fromEntries(
    d.fs
      .read(path)
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => line.split("=", 2) as [string, string]),
  );
}

/**
 * Fixture environment for the flows — minus MAESTRO_APP_ID, which differs per built
 * ref. Call it once before the first `git switch`: after the switch the working tree
 * (and with it .state/credentials.json and .env) is the other ref's.
 */
export function fixtureEnv(
  d: Deps,
  repo: string,
  platform: Platform,
): Record<string, string> {
  const state = `${repo}/e2e/suites/syncplay/.state`;
  const credentials = JSON.parse(d.fs.read(`${state}/credentials.json`));
  const dotenv = fixtureDotenv(d, repo);
  for (const key of ["SYNCPLAY_PORT", "SYNCPLAY_SEERR_PORT"] as const)
    if (!/^\d+$/.test(dotenv[key] ?? ""))
      throw new ShotError(
        `fixture .env is missing a numeric ${key} — run e2e:setup before screenshots`,
      );
  const host = hostFor(platform);
  return {
    MAESTRO_JELLYFIN_URL: `http://${host}:${dotenv.SYNCPLAY_PORT}`,
    MAESTRO_JELLYFIN_USER: credentials.host.name,
    MAESTRO_JELLYFIN_PASS: credentials.password,
    MAESTRO_SEERR_URL: `http://${host}:${dotenv.SYNCPLAY_SEERR_PORT}`,
    MAESTRO_SEERR_PASS: credentials.password,
  };
}

export function ensureFixture(d: Deps, repo: string): void {
  for (const step of ["e2e:setup", "e2e:seed", "e2e:enrich"]) {
    const result = d.exec(["bun", "run", step], { cwd: repo });
    if (result.code !== 0)
      throw new ShotError(
        `${step} failed; the local fixture is not ready (${result.stderr.trim().slice(0, 200)})`,
      );
  }
  must(
    d.exec(
      [
        "env",
        "PYTHONPATH=e2e",
        "python3",
        "-c",
        "from suites.syncplay import seerr, setup; seerr.enable_catalog_libraries(setup.identity()); seerr.provision_client_access(setup.identity())",
      ],
      { cwd: repo },
    ),
    "seerr catalog + client provisioning",
  );
}

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
function appIdOnDevice(
  d: Deps,
  platform: Platform,
  device: string,
  artifact: string,
  ownedAppIds: Set<string>,
): string {
  if (platform === "android" || platform === "android-tv") {
    const badging = must(
      d.exec([aaptPath(d), "dump", "badging", artifact]),
      "aapt dump badging",
    );
    const id = badging.match(/package: name='([^']+)'/)?.[1];
    if (!id)
      throw new ShotError("aapt could not read the built APK's applicationId");
    // SAFETY INVARIANT: never replace or clear a package that already exists. The
    // runner clears app data per capture, so an installed copy — release or a
    // same-id debug build — is user data UNLESS this run installed it (a same-id
    // after-ref rebuild is ours to update). `pm path` answers package:… lines for
    // an installed id, exits 1 with empty output for an absent one; anything else
    // is undetermined and refuses too.
    const path = d.exec(["adb", "-s", device, "shell", "pm", "path", id]);
    if (path.stdout.includes("package:")) {
      if (!ownedAppIds.has(id))
        throw new ShotError(
          `app ${id} already installed; use a fresh dedicated emulator: refusing to replace or clear user data`,
        );
    } else if (path.code !== 1 || path.stdout.trim() !== "")
      throw new ShotError(
        `cannot determine whether ${id} is installed (pm path exit ${path.code}): ${path.stderr.trim()}`,
      );
    must(
      d.exec(["adb", "-s", device, "install", "-r", artifact]),
      "adb install",
    );
    ownedAppIds.add(id);
    return id;
  }
  // Read the bundle id BEFORE touching the device: installing first would already
  // have overwritten a user's app, and resetTestAppState uninstalls per pass.
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
  // SAFETY INVARIANT: same as Android — an exact-id install that this run did not
  // create is user data; refuse before any install/uninstall. `simctl listapps`
  // prints `CFBundleIdentifier = "<id>";` lines; a nonzero result is undetermined
  // and fails closed.
  const apps = d.exec(["xcrun", "simctl", "listapps", device]);
  if (apps.code !== 0)
    throw new ShotError(
      `cannot determine whether ${id} is installed (simctl listapps exit ${apps.code}): ${apps.stderr.trim()}`,
    );
  if (
    apps.stdout
      .split("\n")
      .some((line) => line.trim() === `CFBundleIdentifier = "${id}";`) &&
    !ownedAppIds.has(id)
  )
    throw new ShotError(
      `app ${id} already installed; use a fresh dedicated simulator: refusing to replace or clear user data`,
    );
  must(
    d.exec(["xcrun", "simctl", "install", device, artifact]),
    "simctl install",
  );
  ownedAppIds.add(id);
  return id;
}

/**
 * Fresh app state per capture pass, scoped to the TEST app only: Android `pm clear`
 * on the exact debug package aapt reported (never a substring — the release app on
 * the same emulator is untouched); iOS/tvOS uninstall + reinstall of the built .app,
 * never a whole-simulator erase. The login/intro flows then capture 00-* on genuinely
 * first-run state.
 */
function resetTestAppState(
  d: Deps,
  platform: Platform,
  device: string,
  appId: string,
  artifact: string,
): void {
  if (platform === "android" || platform === "android-tv") {
    must(
      d.exec(["adb", "-s", device, "shell", "pm", "clear", appId]),
      "pm clear test app",
    );
    disableAndroidFastRefresh(d, device, appId);
    return;
  }
  must(
    d.exec(["xcrun", "simctl", "uninstall", device, appId]),
    "simctl uninstall test app",
  );
  must(
    d.exec(["xcrun", "simctl", "install", device, artifact]),
    "simctl install test app",
  );
  disableFastRefresh(d, device, appId);
}

const FAST_REFRESH_OFF_XML =
  '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map>\n    <boolean name="hot_module_replacement" value="false" />\n</map>\n';

/**
 * Android counterpart of disableFastRefresh: React Native reads `hot_module_replacement`
 * from the app's default shared preferences. The file goes in through `adb push` and
 * `run-as` (the debug build is debuggable), which keeps the XML out of the remote shell's
 * quoting. Best effort: a failure only means the banner may show, never a failed run.
 */
function disableAndroidFastRefresh(
  d: Deps,
  device: string,
  appId: string,
): void {
  const local = "/tmp/streamyfin-shots-fast-refresh-off.xml";
  const staged = "/data/local/tmp/streamyfin-shots-fast-refresh-off.xml";
  d.fs.write(local, FAST_REFRESH_OFF_XML);
  const adb = ["adb", "-s", device];
  for (const argv of [
    [...adb, "push", local, staged],
    [...adb, "shell", "run-as", appId, "mkdir", "-p", "shared_prefs"],
    [
      ...adb,
      "shell",
      "run-as",
      appId,
      "cp",
      staged,
      `shared_prefs/${appId}_preferences.xml`,
    ],
  ])
    if (d.exec(argv).code !== 0) return;
}

/**
 * Turns Fast Refresh off for the fresh install. Metro pushes an update when a file
 * changes, and the dev client then draws a blue "Refreshing..." banner over the top of
 * the screen. A shot taken meanwhile differs from one taken without it on timing alone.
 * React Native reads the switch from `RCTDevMenu` in the app's defaults at startup, and
 * the runner's deep link carries no flag for it.
 */
function disableFastRefresh(d: Deps, device: string, appId: string): void {
  const container = must(
    d.exec(["xcrun", "simctl", "get_app_container", device, appId, "data"]),
    "simctl get_app_container",
  ).trim();
  const plist = `${container}/Library/Preferences/${appId}.plist`;
  d.fs.mkdir(`${container}/Library/Preferences`);
  for (const argv of [
    ["plutil", "-create", "xml1", plist],
    ["plutil", "-insert", "RCTDevMenu", "-dictionary", plist],
    ["plutil", "-insert", "RCTDevMenu.hotLoadingEnabled", "-bool", "NO", plist],
  ])
    must(d.exec(argv), "disable fast refresh");
}

function launchDevClient(
  d: Deps,
  platform: Platform,
  device: string,
  appId: string,
  port: number,
): void {
  const host = hostFor(platform);
  // SDK 58 dev-client deep link: __expo_url pins Metro, the disable flags skip the
  // one-time onboarding sheet and hide the dev client's floating menu button
  // (expo.dev/changelog/sdk-58). The app's scheme is `streamyfin`.
  const url = `streamyfin://?__expo_url=${encodeURIComponent(`http://${host}:${port}`)}&__expo_disable_onboarding=1&__expo_disable_fab=1`;
  // adb joins argv into one remote shell command — the & in the URL would split it
  // and turn -p into a second command, so the -d value must be remote-quoted.
  const quotedUrl = `'${url.replaceAll("'", "'\\''")}'`;
  if (platform === "android" || platform === "android-tv")
    must(
      d.exec([
        "adb",
        "-s",
        device,
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        quotedUrl,
        "-p",
        appId,
      ]),
      "launch dev client",
    );
  else
    must(
      d.exec(["xcrun", "simctl", "openurl", device, url]),
      "openurl dev client",
    );
}

function flowArgv(
  tooling: string,
  flow: string,
  device: string,
  outDir: string,
  env: Record<string, string>,
  maestro: string,
  maestroPlatform?: "tvos",
): string[] {
  const argv = [
    "python3",
    `${tooling}/maestro.py`,
    "--flow",
    `${tooling}/flows/${flow}.yml`,
    "--out",
    outDir,
    "--device",
    device,
  ];
  argv.push("--maestro", maestro);
  if (maestroPlatform) argv.push("--platform", maestroPlatform);
  argv.push("--env", `MAESTRO_TVOS=${maestroPlatform === "tvos" ? "1" : "0"}`);
  for (const [key, value] of Object.entries(env))
    argv.push("--env", `${key}=${value}`);
  return argv;
}

function runFlow(
  d: Deps,
  tooling: string,
  flow: string,
  device: string,
  outDir: string,
  env: Record<string, string>,
  maestro: string,
  maestroPlatform?: "tvos",
): void {
  // The env map reaches maestro.py through argv; it is never printed by this runner,
  // and a failing flow's stderr is stripped of credentials before it is thrown.
  mustSanitized(
    d.exec(
      flowArgv(tooling, flow, device, outDir, env, maestro, maestroPlatform),
    ),
    `flow ${flow}`,
    [env.MAESTRO_JELLYFIN_PASS, env.MAESTRO_SEERR_PASS],
  );
}

async function startMetro(
  d: Deps,
  repo: string,
  spec: PlatformSpec,
  port: number,
): Promise<SpawnHandle> {
  // TOCTOU: the preflight check ran minutes ago; re-verify immediately before bind so
  // a foreign Metro that grabbed the port meanwhile aborts the run instead of being
  // adopted as ours. EXPO_NO_INTERACTIVE keeps Expo from auto-hopping to a free port.
  ensurePortFree(d, port);
  const metro = d.spawn(
    [
      "bunx",
      "expo",
      "start",
      "--dev-client",
      "--port",
      String(port),
      "--clear",
    ],
    {
      cwd: repo,
      env: { EXPO_TV: spec.tv ? "1" : "0", EXPO_NO_INTERACTIVE: "1" },
    },
  );
  const up = await d.waitFor(
    `http://127.0.0.1:${port}/status`,
    "packager-status:running",
    120_000,
  );
  // /status answering while OUR child is dead means a foreign packager satisfied the
  // probe — never treat it as ours.
  if (!up || !metro.isAlive()) {
    metro.kill();
    throw new ShotError(
      `Metro did not report packager-status:running on port ${port}`,
    );
  }
  return metro;
}

function runCapture(
  d: Deps,
  tooling: string,
  spec: PlatformSpec,
  device: string,
  outDir: string,
  env: Record<string, string>,
  maestro: string,
): void {
  for (const flow of [
    spec.login,
    spec.screens,
    spec.seerrBootstrap,
    spec.seerr,
  ])
    runFlow(
      d,
      tooling,
      flow,
      device,
      outDir,
      env,
      maestro,
      spec.maestroPlatform,
    );
}

function restoreGit(d: Deps, repo: string, start: GitStart): void {
  const argv = start.detached
    ? ["git", "switch", "--detach", start.ref]
    : ["git", "switch", start.ref];
  if (d.exec(argv, { cwd: repo }).code !== 0)
    throw new ShotError(
      `could not switch back to ${start.ref}; the tree gained new edits — restore it by hand, the runner never force-switches`,
    );
}

const NATIVE_DIRS = ["ios", "android"];

function backupNativeDirs(d: Deps, repo: string, sessionDir: string): string[] {
  const backup = `${sessionDir}/native-backup`;
  const moved: string[] = [];
  for (const dir of NATIVE_DIRS) {
    const path = `${repo}/${dir}`;
    if (d.fs.exists(path)) {
      d.fs.mkdir(backup);
      d.fs.mv(path, `${backup}/${dir}`);
      moved.push(dir);
    }
  }
  return moved;
}

function restoreNativeDirs(
  d: Deps,
  repo: string,
  sessionDir: string,
  moved: string[],
): void {
  const backup = `${sessionDir}/native-backup`;
  for (const dir of moved) {
    // Whatever prebuild regenerated is runner-owned, but it may have picked up user
    // edits mid-run: move it aside for diagnosis, never delete it.
    const generated = `${repo}/${dir}`;
    if (d.fs.exists(generated)) {
      d.fs.mkdir(`${sessionDir}/native-generated`);
      d.fs.mv(generated, `${sessionDir}/native-generated/${dir}`);
    }
    d.fs.mv(`${backup}/${dir}`, generated);
  }
}

function lockfileChanged(d: Deps, repo: string, previous: string): boolean {
  const marker = "bun.lock\npackage.json\n";
  const current = marker
    .split("\n")
    .filter(Boolean)
    .map((name) =>
      d.fs.exists(`${repo}/${name}`) ? d.fs.read(`${repo}/${name}`) : "",
    )
    .join("\n---\n");
  return current !== previous;
}

export interface RunReport {
  sessionDir: string;
  beforeSha: string;
  afterSha: string;
  restored: GitStart;
}

/** Set by runComparison while it holds live state; shots.ts calls it on SIGINT/SIGTERM. */
export let interruptCleanup: (() => void) | undefined;
export function setInterruptCleanup(fn: (() => void) | undefined): void {
  interruptCleanup = fn;
}

/**
 * The whole session output must be gitignored, or a report file written under a ref
 * that does not ignore it would block the next `git switch --detach`.
 */
export function ensureOutIgnored(
  d: Deps,
  repo: string,
  sessionDir: string,
): void {
  const rel = sessionDir.startsWith(`${repo}/`)
    ? sessionDir.slice(repo.length + 1)
    : sessionDir;
  const result = d.exec(["git", "check-ignore", "-q", rel], { cwd: repo });
  if (result.code !== 0)
    throw new ShotError(
      `--out ${sessionDir} is not gitignored; screenshot output must never be able to block a ref switch`,
    );
}

/**
 * before → noise → after, on one checkout. The before and noise passes share the before
 * ref's switch (noise is a fresh capture of the same build — never cached, never
 * carried). Restoration runs on success, failure and interrupt.
 */
export async function runComparison(
  d: Deps,
  cli: Cli,
  repo: string,
): Promise<RunReport> {
  const spec = platformSpec(cli.platform!);
  const { beforeSha, afterSha, start } = preflight(d, repo, cli);
  const device = selectDevice(d, cli.platform!, cli.device);
  const port = cli.port ?? DEFAULT_PORT;
  ensurePortFree(d, port);
  const sessionDir = cli.outDir ?? `${repo}/${REPORTS_DIR}/${Date.now()}`;
  ensureOutIgnored(d, repo, sessionDir);
  d.fs.mkdir(sessionDir);
  const tooling = snapshotTooling(d, repo, sessionDir);
  const maestro = ensureMaestro(d, `${repo}/${REPORTS_DIR}/tools`);
  ensureFixture(d, repo);
  // Capture the fixture contract while the checkout that produced it is still on disk:
  // .state/ and .env are gitignored, so they survive the switch — but an absent or
  // changed file on the other ref must never be re-read mid-run.
  const baseEnv = fixtureEnv(d, repo, cli.platform!);

  let metro: SpawnHandle | undefined;
  let nativeMoved: string[] = [];
  let buildDeps = "";
  // Nested: a refused git restore (new user edits mid-run) must not strand the
  // native dirs in the backup.
  const cleanup = (): void => {
    metro?.kill();
    metro = undefined;
    try {
      restoreGit(d, repo, start);
      // node_modules still holds the last switched ref's lockfile. Logged, not thrown:
      // a throw here would hide the error this cleanup runs after.
      if (buildDeps && lockfileChanged(d, repo, buildDeps)) {
        const install = d.exec(["bun", "install", "--frozen-lockfile"], {
          cwd: repo,
        });
        if (install.code !== 0)
          d.log(
            `bun install failed while restoring ${start.ref}; run it by hand before anything else: ${install.stderr.trim().slice(0, 200)}`,
          );
      }
    } finally {
      if (nativeMoved.length)
        restoreNativeDirs(d, repo, sessionDir, nativeMoved);
    }
  };
  setInterruptCleanup(cleanup);
  try {
    // App ids this run installed itself: only these may be reinstalled or
    // state-cleared — anything else on the device is user data.
    const ownedAppIds = new Set<string>();
    const refs: { label: string; sha: string; captures: string[] }[] = [
      { label: "before", sha: beforeSha, captures: ["before", "noise"] },
      { label: "after", sha: afterSha, captures: ["after"] },
    ];
    for (const ref of refs) {
      must(
        d.exec(["git", "switch", "--detach", ref.sha], { cwd: repo }),
        `git switch ${ref.label}`,
      );
      if (lockfileChanged(d, repo, buildDeps))
        must(
          d.exec(["bun", "install", "--frozen-lockfile"], { cwd: repo }),
          "bun install --frozen-lockfile",
        );
      buildDeps = ["bun.lock", "package.json"]
        .map((n) =>
          d.fs.exists(`${repo}/${n}`) ? d.fs.read(`${repo}/${n}`) : "",
        )
        .join("\n---\n");
      const hash = nativeFingerprint(d, repo, spec);
      const cacheDir = `${repo}/${REPORTS_DIR}/build-cache/${cli.platform}/${hash}`;
      const needsBuild = !d.fs.exists(cacheDir);
      if (needsBuild && !nativeMoved.length)
        nativeMoved = backupNativeDirs(d, repo, sessionDir);
      if (needsBuild) {
        must(
          d.exec(["bun", "run", spec.tv ? "prebuild:tv" : "prebuild"], {
            cwd: repo,
          }),
          "expo prebuild",
        );
        // `expo prebuild` writes the ios project but does not run pod install.
        if (spec.fingerprintPlatform === "ios")
          must(
            d.exec(["pod", "install"], { cwd: `${repo}/ios` }),
            "pod install",
          );
      }
      const { artifact } = ensureDebugBuild(
        d,
        repo,
        cli.platform!,
        spec,
        hash,
        sessionDir,
      );
      const appId = appIdOnDevice(
        d,
        cli.platform!,
        device,
        artifact,
        ownedAppIds,
      );
      // The plugin pushes Seerr as 127.0.0.1:<seerrPort>, which on ANY Android emulator
      // means the emulator's own loopback — both phone and TV need the reverse mapping
      // to reach the host fixture. Reuse an identical mapping, abort on a conflicting
      // one, and never remove a mapping that predates this run.
      if (cli.platform === "android" || cli.platform === "android-tv") {
        const reverses = must(
          d.exec(["adb", "-s", device, "reverse", "--list"]),
          "adb reverse --list",
        );
        const seerrPort = baseEnv.MAESTRO_SEERR_URL.split(":").pop()!;
        let mapped = false;
        for (const line of reverses.split("\n")) {
          const ports = line.match(/\btcp:(\d+)\s+tcp:(\d+)\b/);
          if (!ports || ports[1] !== seerrPort) continue;
          if (ports[2] !== seerrPort)
            throw new ShotError(
              `adb reverse tcp:${seerrPort} is held by a mapping to tcp:${ports[2]} — refusing to shadow it`,
            );
          mapped = true;
        }
        if (!mapped)
          must(
            d.exec([
              "adb",
              "-s",
              device,
              "reverse",
              `tcp:${seerrPort}`,
              `tcp:${seerrPort}`,
            ]),
            "adb reverse seerr",
          );
      }
      const env = { ...baseEnv, MAESTRO_APP_ID: appId };
      metro = await startMetro(d, repo, spec, port);
      try {
        // Prove this Metro serves the checked-out ref's JS — /status alone says only
        // that a packager answers. A compile error in the switched ref fails here,
        // before any screenshot is taken.
        const bundled = await d.waitFor(
          `http://127.0.0.1:${port}/index.bundle?platform=${spec.fingerprintPlatform}&dev=true`,
          "__BUNDLE_START_TIME__",
          300_000,
        );
        if (!bundled)
          throw new ShotError(
            `Metro on ${port} is up but did not bundle ${spec.fingerprintPlatform} JS for the switched ref`,
          );
        for (const capture of ref.captures) {
          const outDir = `${sessionDir}/${capture}`;
          d.fs.mkdir(outDir);
          // Every pass is a first run: fresh state, then the deep link that points the
          // dev client at this ref's Metro — the flows themselves carry no clearState,
          // because wiping state would also wipe the URL the link just set.
          resetTestAppState(d, cli.platform!, device, appId, artifact);
          launchDevClient(d, cli.platform!, device, appId, port);
          runCapture(d, tooling, spec, device, outDir, env, maestro);
        }
      } finally {
        metro.kill();
        metro = undefined;
      }
    }
    const spec_masks = `${tooling}/${spec.masks}`;
    must(
      d.exec(
        [
          "bun",
          `${tooling}/compare.ts`,
          "--before",
          `${sessionDir}/before`,
          "--noise",
          `${sessionDir}/noise`,
          "--after",
          `${sessionDir}/after`,
          "--masks",
          spec_masks,
          "--evidence",
          `${sessionDir}/evidence`,
          "--out",
          `${sessionDir}/report`,
        ],
        { cwd: repo },
      ),
      "compare",
    );
    return { sessionDir, beforeSha, afterSha, restored: start };
  } finally {
    setInterruptCleanup(undefined);
    cleanup();
  }
}

/** Re-reads .env each call: e2e:setup may have just written it. */
function fixtureChecks(d: Deps, repo: string): string[] {
  const dotenv = fixtureDotenv(d, repo);
  const jellyfinPort = dotenv.SYNCPLAY_PORT ?? "18096";
  const seerrPort = dotenv.SYNCPLAY_SEERR_PORT ?? "15055";
  const jellyfin = d.exec([
    "curl",
    "-fsS",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    `http://127.0.0.1:${jellyfinPort}/health`,
  ]);
  const seerr = d.exec([
    "curl",
    "-fsS",
    `http://127.0.0.1:${seerrPort}/api/v1/settings/public`,
  ]);
  return [
    jellyfin.stdout.trim() === "200"
      ? "jellyfin fixture healthy"
      : `jellyfin fixture NOT reachable at :${jellyfinPort}`,
    seerr.code === 0 && seerr.stdout.includes('"initialized":true')
      ? "seerr fixture initialized"
      : "seerr fixture NOT initialized",
  ];
}

export function doctor(
  d: Deps,
  cli: Cli,
  repo: string,
): { ok: boolean; checks: string[] } {
  const checks: string[] = [];
  const status = must(
    d.exec(["git", "status", "--porcelain", "--untracked-files=all"], {
      cwd: repo,
    }),
    "git status",
  );
  checks.push(
    status
      ? `tree dirty (${status.split("\n").length} entries) — run refuses until clean`
      : "tree clean",
  );
  let fixture = fixtureChecks(d, repo);
  if (cli.fix && fixture.some((check) => check.includes("NOT"))) {
    d.log("fix: bringing up the local fixture");
    ensureFixture(d, repo);
    fixture = fixtureChecks(d, repo);
  }
  checks.push(...fixture);
  const tools = `${repo}/${REPORTS_DIR}/tools`;
  if (cli.fix && !d.fs.exists(maestroBinary(tools))) {
    d.log(`fix: installing maestro ${MAESTRO_TAG}`);
    ensureMaestro(d, tools);
  }
  checks.push(
    d.fs.exists(maestroBinary(tools))
      ? `maestro ${MAESTRO_TAG} installed`
      : `maestro ${MAESTRO_TAG} NOT installed`,
  );
  const ok = checks.every((check) => !check.includes("NOT"));
  return { ok, checks };
}
