import {
  BUILD_CACHE_FETCH_ENV,
  BUILD_CACHE_FETCH_TIMEOUT_MS,
  BUILD_RECIPE,
  DEV_CLIENT_RECIPE,
  deviceAbi,
  ensureDebugBuild,
  ensureReleaseBuild,
  NO_BUILD_ENV,
} from "./build";
import { platformSpec } from "./cli";
import { type Cli, ShotError } from "./core";
import { runComparison } from "./run";
import {
  execs,
  Fake,
  happyRoutes,
  ok,
  REPO,
  runCli,
  SIMCTL_JSON,
  seed,
} from "./testing";

describe("deviceAbi", () => {
  it("reads the first ABI from ro.product.cpu.abilist", () => {
    const f = new Fake();
    f.routes.push([
      "emulator-5554 shell getprop ro.product.cpu.abilist",
      { code: 0, stdout: "x86,armeabi-v7a\n", stderr: "" },
    ]);
    expect(deviceAbi(f, "emulator-5554")).toBe("x86");
  });

  it("throws when ro.product.cpu.abilist is empty", () => {
    const f = new Fake();
    f.routes.push([
      "emulator-5554 shell getprop ro.product.cpu.abilist",
      { code: 0, stdout: " \n", stderr: "" },
    ]);
    expect(() => deviceAbi(f, "emulator-5554")).toThrow(ShotError);
  });
});

describe("ensureDebugBuild cache", () => {
  const spec = platformSpec("android");
  it("rebuilds on a new fingerprint or ABI, reuses the cache on the same one", () => {
    const f = new Fake();
    f.routes.push([
      "node --version",
      { code: 0, stdout: "v22.14.0\n", stderr: "" },
    ]);
    let builds = 0;
    f.routes.push([
      "assembleDebug",
      (fake) => {
        builds++;
        fake.files.set(
          `${REPO}/android/app/build/outputs/apk/debug/app-debug.apk`,
          "apk",
        );
        return ok;
      },
    ]);
    const first = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-a",
      `${REPO}/session`,
      undefined,
      "arm64-v8a",
    );
    expect(first.built).toBe(true);
    expect(first.source).toBe("built");
    expect(first.hash).toBe(`fp-a-${DEV_CLIENT_RECIPE}-arm64-v8a`);
    expect(execs(f, "assembleDebug")[0]).toContain(
      "-PreactNativeArchitectures=arm64-v8a",
    );
    const again = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-a",
      `${REPO}/session`,
      undefined,
      "arm64-v8a",
    );
    expect(again.built).toBe(false);
    expect(again.source).toBe("local");
    expect(again.artifact).toBe(first.artifact);
    const otherAbi = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-a",
      `${REPO}/session`,
      undefined,
      "x86",
    );
    expect(otherAbi.built).toBe(true);
    expect(otherAbi.source).toBe("built");
    expect(otherAbi.hash).toBe(`fp-a-${DEV_CLIENT_RECIPE}-x86`);
    expect(otherAbi.artifact).not.toBe(first.artifact);
    const other = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-b",
      `${REPO}/session`,
      undefined,
      "arm64-v8a",
    );
    expect(other.built).toBe(true);
    expect(other.source).toBe("built");
    expect(builds).toBe(3);
  });

  it("uses the fetch hook on a local miss with <fingerprint>-<abi> and skips building when an APK arrives", () => {
    const f = new Fake();
    f.env[BUILD_CACHE_FETCH_ENV] = "/ci/fetch-dev-client.py";
    let observedTimeout: number | undefined;
    const origExec = f.exec.bind(f);
    f.exec = (argv, opts) => {
      if (argv[0] === "/ci/fetch-dev-client.py")
        observedTimeout = opts?.timeoutMs;
      return origExec(argv);
    };
    f.routes.push([
      "/ci/fetch-dev-client.py",
      (fake, argv) => {
        const [, platform, hash, cacheDir] = argv;
        expect(platform).toBe("android");
        expect(hash).toBe(`fp-fetch-${DEV_CLIENT_RECIPE}-x86_64`);
        fake.dirs.add(cacheDir);
        fake.files.set(`${cacheDir}/app-debug.apk`, "apk");
        return ok;
      },
    ]);

    const res = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-fetch",
      `${REPO}/session`,
      undefined,
      "x86_64",
    );
    expect(res).toEqual({
      artifact: `${REPO}/e2e/reports/shots/build-cache/android/fp-fetch-${DEV_CLIENT_RECIPE}-x86_64/app-debug.apk`,
      built: false,
      source: "fetched",
      hash: `fp-fetch-${DEV_CLIENT_RECIPE}-x86_64`,
    });
    expect(observedTimeout).toBe(BUILD_CACHE_FETCH_TIMEOUT_MS);
    expect(execs(f, "assembleDebug")).toHaveLength(0);
  });

  it("uses a single fetched .app for Apple and skips xcodebuild", () => {
    const f = new Fake();
    f.env[BUILD_CACHE_FETCH_ENV] = "/ci/fetch-dev-client.py";
    f.routes.push([
      "/ci/fetch-dev-client.py",
      (fake, argv) => {
        const [, platform, hash, cacheDir] = argv;
        expect(platform).toBe("ios");
        expect(hash).toBe(`fp-ios-${DEV_CLIENT_RECIPE}`);
        fake.dirs.add(cacheDir);
        fake.dirs.add(`${cacheDir}/Streamyfin.app`);
        return ok;
      },
    ]);

    const res = ensureDebugBuild(
      f,
      REPO,
      "ios",
      platformSpec("ios"),
      "fp-ios",
      `${REPO}/session`,
    );
    expect(res).toEqual({
      artifact: `${REPO}/e2e/reports/shots/build-cache/ios/fp-ios-${DEV_CLIENT_RECIPE}/Streamyfin.app`,
      built: false,
      source: "fetched",
      hash: `fp-ios-${DEV_CLIENT_RECIPE}`,
    });
    expect(execs(f, "xcodebuild")).toHaveLength(0);
  });

  it("skips the fetch hook when the local cache already holds the artifact", () => {
    const f = new Fake();
    f.env[BUILD_CACHE_FETCH_ENV] = "/ci/fetch-dev-client.py";
    const cacheDir = `${REPO}/e2e/reports/shots/build-cache/android/fp-hit-${DEV_CLIENT_RECIPE}-arm64-v8a`;
    f.dirs.add(cacheDir);
    f.files.set(`${cacheDir}/app-debug.apk`, "apk");

    const res = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-hit",
      `${REPO}/session`,
      undefined,
      "arm64-v8a",
    );
    expect(res).toEqual({
      artifact: `${cacheDir}/app-debug.apk`,
      built: false,
      source: "local",
      hash: `fp-hit-${DEV_CLIENT_RECIPE}-arm64-v8a`,
    });
    expect(execs(f, "fetch-dev-client.py")).toHaveLength(0);
  });

  it("logs one line and builds locally when the fetch hook fails", () => {
    const f = new Fake();
    f.env[BUILD_CACHE_FETCH_ENV] = "/ci/fetch-dev-client.py";
    f.routes.push(
      ["/ci/fetch-dev-client.py", { code: 1, stdout: "", stderr: "miss\n" }],
      ["node --version", { code: 0, stdout: "v22.14.0\n", stderr: "" }],
      [
        "assembleDebug",
        (fake) => {
          fake.files.set(
            `${REPO}/android/app/build/outputs/apk/debug/app-debug.apk`,
            "apk",
          );
          return ok;
        },
      ],
    );

    const res = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-miss",
      `${REPO}/session`,
      undefined,
      "arm64-v8a",
    );
    expect(res.built).toBe(true);
    expect(res.source).toBe("built");
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain("miss");
    expect(execs(f, "assembleDebug")).toHaveLength(1);
  });

  it("logs one line and builds locally when fetch exits 0 without a valid Apple .app", () => {
    const f = new Fake();
    f.env[BUILD_CACHE_FETCH_ENV] = "/ci/fetch-dev-client.py";
    f.dirs.add(`${REPO}/ios`);
    f.files.set(`${REPO}/ios/Streamyfin.xcworkspace`, "x");
    f.routes.push(
      [
        "/ci/fetch-dev-client.py",
        (fake, argv) => {
          const cacheDir = argv[3];
          fake.dirs.add(cacheDir);
          fake.dirs.add(`${cacheDir}/A.app`);
          fake.dirs.add(`${cacheDir}/B.app`);
          return ok;
        },
      ],
      [
        "xcodebuild",
        (fake, argv) => {
          const derived = argv[argv.indexOf("-derivedDataPath") + 1];
          fake.dirs.add(`${derived}/Build/Products/Debug-iphonesimulator`);
          fake.dirs.add(
            `${derived}/Build/Products/Debug-iphonesimulator/Streamyfin.app`,
          );
          return ok;
        },
      ],
    );

    const res = ensureDebugBuild(
      f,
      REPO,
      "ios",
      platformSpec("ios"),
      "fp-bad",
      `${REPO}/session`,
    );
    expect(res.built).toBe(true);
    expect(res.source).toBe("built");
    expect(f.logs).toHaveLength(1);
    expect(execs(f, "xcodebuild")).toHaveLength(1);
  });

  it("refuses a miss under SHOTS_NO_BUILD=1, naming platform and hash, without building", () => {
    const f = new Fake();
    f.env[NO_BUILD_ENV] = "1";
    let beforeBuild = false;
    expect(() =>
      ensureDebugBuild(
        f,
        REPO,
        "android",
        spec,
        "fp-none",
        `${REPO}/session`,
        () => {
          beforeBuild = true;
        },
        "arm64-v8a",
      ),
    ).toThrow(
      `no cached android build for fp-none-${DEV_CLIENT_RECIPE}-arm64-v8a and ${NO_BUILD_ENV}=1`,
    );
    expect(beforeBuild).toBe(false);
    expect(execs(f, "assembleDebug")).toHaveLength(0);
  });

  it("still returns local and fetched hits under SHOTS_NO_BUILD=1", () => {
    const f = new Fake();
    f.env[NO_BUILD_ENV] = "1";
    const cacheDir = `${REPO}/e2e/reports/shots/build-cache/android/fp-hit-${DEV_CLIENT_RECIPE}-arm64-v8a`;
    f.dirs.add(cacheDir);
    f.files.set(`${cacheDir}/app-debug.apk`, "apk");
    expect(
      ensureDebugBuild(
        f,
        REPO,
        "android",
        spec,
        "fp-hit",
        `${REPO}/session`,
        undefined,
        "arm64-v8a",
      ).source,
    ).toBe("local");

    const g = new Fake();
    g.env[NO_BUILD_ENV] = "1";
    g.env[BUILD_CACHE_FETCH_ENV] = "/ci/fetch-dev-client.py";
    g.routes.push([
      "/ci/fetch-dev-client.py",
      (fake, argv) => {
        const dir = argv[3];
        fake.dirs.add(dir);
        fake.files.set(`${dir}/app-debug.apk`, "apk");
        return ok;
      },
    ]);
    expect(
      ensureDebugBuild(
        g,
        REPO,
        "android",
        spec,
        "fp-fetch",
        `${REPO}/session`,
        undefined,
        "arm64-v8a",
      ).source,
    ).toBe("fetched");
    expect(execs(g, "assembleDebug")).toHaveLength(0);
  });
});

describe("ensureReleaseBuild", () => {
  const spec = platformSpec("android");

  it("assembles a Release APK with shrinking off and caches it under <fingerprint>-r3-release-<abi>", () => {
    const f = new Fake();
    f.routes.push(
      ["node --version", { code: 0, stdout: "v22.14.0\n", stderr: "" }],
      [
        "assembleRelease",
        (fake) => {
          fake.files.set(
            `${REPO}/android/app/build/outputs/apk/release/app-release.apk`,
            "apk",
          );
          return ok;
        },
      ],
    );

    const res = ensureReleaseBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-a",
      `${REPO}/session`,
      undefined,
      "arm64-v8a",
    );
    expect(res).toEqual({
      artifact: `${REPO}/e2e/reports/shots/build-cache/android/fp-a-${BUILD_RECIPE}-arm64-v8a/app-release.apk`,
      built: true,
      source: "built",
      hash: `fp-a-${BUILD_RECIPE}-arm64-v8a`,
    });
    const gradle = execs(f, "assembleRelease");
    expect(gradle).toHaveLength(1);
    const argv = gradle[0].join(" ");
    // Minify and resource shrinking stay off: R8's shrinked output no longer
    // links under the repack's apktool rebuild.
    expect(argv).toContain("-PreactNativeArchitectures=arm64-v8a");
    expect(argv).toContain("-Pandroid.enableMinifyInReleaseBuilds=false");
    expect(argv).toContain(
      "-Pandroid.enableShrinkResourcesInReleaseBuilds=false",
    );
    const opts = f.execOpts[f.execLog.indexOf(gradle[0])];
    expect(opts?.env?.NODE_ENV).toBe("production");
    expect(opts?.env?.EXPO_TV).toBe("0");
    expect(opts?.env?.ASDF_NODEJS_VERSION).toBe("22.14.0");

    // The same fingerprint + ABI hits the local cache, like the debug recipe.
    expect(
      ensureReleaseBuild(
        f,
        REPO,
        "android",
        spec,
        "fp-a",
        `${REPO}/session`,
        undefined,
        "arm64-v8a",
      ).source,
    ).toBe("local");
    expect(execs(f, "assembleRelease")).toHaveLength(1);
  });

  it("uses the fetch hook on a local miss and refuses a miss under SHOTS_NO_BUILD=1", () => {
    const f = new Fake();
    f.env[BUILD_CACHE_FETCH_ENV] = "/ci/fetch-dev-client.py";
    f.routes.push([
      "/ci/fetch-dev-client.py",
      (fake, argv) => {
        expect(argv[2]).toBe(`fp-rel-${BUILD_RECIPE}-arm64-v8a`);
        fake.dirs.add(argv[3]);
        fake.files.set(`${argv[3]}/app-release.apk`, "apk");
        return ok;
      },
    ]);
    expect(
      ensureReleaseBuild(
        f,
        REPO,
        "android",
        spec,
        "fp-rel",
        `${REPO}/session`,
        undefined,
        "arm64-v8a",
      ).source,
    ).toBe("fetched");
    expect(execs(f, "assembleRelease")).toHaveLength(0);

    const g = new Fake();
    g.env[NO_BUILD_ENV] = "1";
    expect(() =>
      ensureReleaseBuild(
        g,
        REPO,
        "android",
        spec,
        "fp-none",
        `${REPO}/session`,
        undefined,
        "arm64-v8a",
      ),
    ).toThrow(
      `no cached android build for fp-none-${BUILD_RECIPE}-arm64-v8a and ${NO_BUILD_ENV}=1`,
    );
    expect(execs(g, "assembleRelease")).toHaveLength(0);
  });

  it("is Android-only for now: Apple platforms refuse before any cache lookup", () => {
    const f = new Fake();
    expect(() =>
      ensureReleaseBuild(
        f,
        REPO,
        "ios",
        platformSpec("ios"),
        "fp",
        `${REPO}/s`,
      ),
    ).toThrow(ShotError);
    expect(() =>
      ensureReleaseBuild(
        f,
        REPO,
        "apple-tv",
        platformSpec("apple-tv"),
        "fp",
        `${REPO}/s`,
      ),
    ).toThrow(ShotError);
    expect(execs(f, "xcodebuild")).toHaveLength(0);
  });
});

describe("existing Android install", () => {
  // A run that fails after installing leaves the app behind, and the next run used to
  // refuse to start until it was uninstalled by hand.
  it("installs over whatever is on the emulator, without checking for it", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    expect(execs(f, "pm path")).toHaveLength(0);
    expect(execs(f, "install -r")).toHaveLength(2);
    expect(execs(f, "pm clear")).toHaveLength(3);
  });

  it("uninstalls and installs again when the existing install has another signature", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "emulator-5554 install -r",
      (fake) =>
        fake.execLog.some((argv) => argv.join(" ").includes(" uninstall "))
          ? ok
          : {
              code: 1,
              stdout: "",
              stderr:
                "adb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]",
            },
    ]);
    f.routes.push(["uninstall com.example.streamyfin.debug", ok]);
    await runComparison(f, runCli, REPO);
    expect(execs(f, "uninstall com.example.streamyfin.debug")).toHaveLength(1);
    const trace = f.execLog.map((argv) => argv.join(" "));
    const removed = trace.findIndex((a) => a.includes(" uninstall "));
    expect(
      trace.findIndex((a, i) => i > removed && a.includes("install -r")),
    ).toBeGreaterThan(removed);
  });

  it("fails the run when the install fails for another reason", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "emulator-5554 install -r",
      {
        code: 1,
        stdout: "",
        stderr: "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]",
      },
    ]);
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(/adb install/);
    expect(execs(f, " uninstall ")).toHaveLength(0);
    expect(execs(f, "pm clear")).toHaveLength(0);
  });
});

describe("iOS install", () => {
  const iosCli: Cli = {
    command: "run",
    platform: "ios",
    before: "main",
    after: "feat/x",
    device: "UDID-PHONE",
  };

  function iosHappyRoutes(f: Fake) {
    happyRoutes(f);
    f.routes.push(
      [
        "list devices",
        { code: 0, stdout: JSON.stringify(SIMCTL_JSON), stderr: "" },
      ],
      [
        "pod install",
        (fake) => {
          fake.dirs.add(`${REPO}/ios`);
          fake.files.set(`${REPO}/ios/Streamyfin.xcworkspace`, "x");
          return ok;
        },
      ],
      [
        "xcodebuild",
        (fake, argv) => {
          expect(argv[argv.indexOf("-workspace") + 1]).toBe(
            `${REPO}/ios/Streamyfin.xcworkspace`,
          );
          expect(argv[argv.indexOf("-scheme") + 1]).toBe("Streamyfin");
          const derived = argv[argv.indexOf("-derivedDataPath") + 1];
          fake.dirs.add(`${derived}/Build/Products/Debug-iphonesimulator`);
          fake.files.set(
            `${derived}/Build/Products/Debug-iphonesimulator/Streamyfin.app`,
            "app",
          );
          return ok;
        },
      ],
      [
        "PlistBuddy",
        { code: 0, stdout: "com.example.streamyfin\n", stderr: "" },
      ],
      ["status_bar", ok],
    );
  }

  it("installs over an app it finds on the simulator, without checking for one", async () => {
    const f = new Fake();
    seed(f);
    iosHappyRoutes(f);
    f.routes.push(
      ["simctl uninstall", ok],
      ["simctl install", ok],
      [
        "get_app_container",
        { code: 0, stdout: "/sim/container\n", stderr: "" },
      ],
      ["plutil", ok],
      ["simctl openurl", ok],
    );
    await runComparison(f, iosCli, REPO);
    expect(execs(f, "listapps")).toHaveLength(0);
    expect(execs(f, "simctl install").length).toBeGreaterThan(0);
  });

  it("overrides the status bar before the first install and clears it at the end", async () => {
    const f = new Fake();
    seed(f);
    iosHappyRoutes(f);
    f.routes.push(
      ["simctl uninstall", ok],
      ["simctl install", ok],
      [
        "get_app_container",
        { code: 0, stdout: "/sim/container\n", stderr: "" },
      ],
      ["plutil", ok],
      ["simctl openurl", ok],
    );
    await runComparison(f, iosCli, REPO);
    const trace = f.execLog.map((argv) => argv.join(" "));
    const override = trace.findIndex((a) =>
      a.startsWith("xcrun simctl status_bar UDID-PHONE override"),
    );
    expect(override).toBeGreaterThanOrEqual(0);
    expect(override).toBeLessThan(
      trace.findIndex((a) => a.includes("simctl install")),
    );
    const clear = trace.lastIndexOf("xcrun simctl status_bar UDID-PHONE clear");
    const lastFlow = trace.findLastIndex((a) => a.includes("maestro.py"));
    expect(lastFlow).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(lastFlow);
  });

  it("clears the status bar when a flow fails", async () => {
    const f = new Fake();
    seed(f);
    iosHappyRoutes(f);
    f.routes.push(
      ["simctl uninstall", ok],
      ["simctl install", ok],
      [
        "get_app_container",
        { code: 0, stdout: "/sim/container\n", stderr: "" },
      ],
      ["plutil", ok],
      ["simctl openurl", ok],
      ["pass-mobile.yml", { code: 1, stdout: "", stderr: "boom" }],
    );
    await expect(runComparison(f, iosCli, REPO)).rejects.toThrow(ShotError);
    expect(execs(f, "status_bar UDID-PHONE clear")).toHaveLength(1);
  });

  it("turns Fast Refresh off in each fresh install before the deep link", async () => {
    const f = new Fake();
    seed(f);
    iosHappyRoutes(f);
    f.routes.push(
      ["simctl uninstall", ok],
      ["simctl install", ok],
      [
        "get_app_container",
        { code: 0, stdout: "/sim/container\n", stderr: "" },
      ],
      ["plutil -create", ok],
      ["plutil -insert", ok],
      ["simctl openurl", ok],
    );
    await runComparison(f, iosCli, REPO);

    const plist =
      "/sim/container/Library/Preferences/com.example.streamyfin.plist";
    const hot = execs(f, "RCTDevMenu.hotLoadingEnabled");
    expect(hot).toHaveLength(3);
    for (const argv of hot)
      expect(argv).toEqual([
        "plutil",
        "-insert",
        "RCTDevMenu.hotLoadingEnabled",
        "-bool",
        "NO",
        plist,
      ]);
    // The dev menu's floating button stays off across the flows' launchApp restarts,
    // which drop the deep link's one-process __expo_disable_fab.
    const fab = execs(f, "EXDevMenuShowFloatingActionButton");
    expect(fab).toHaveLength(3);
    for (const argv of fab)
      expect(argv).toEqual([
        "plutil",
        "-insert",
        "EXDevMenuShowFloatingActionButton",
        "-bool",
        "NO",
        plist,
      ]);
    // The default is written after the reinstall and before the app is first opened.
    const trace = f.execLog.map((argv) => argv.join(" "));
    const install = trace.findIndex((a) => a.includes("simctl install"));
    const write = trace.findIndex((a) => a.includes("hotLoadingEnabled"));
    const open = trace.findIndex((a) => a.includes("simctl openurl"));
    expect(install).toBeLessThan(write);
    expect(write).toBeLessThan(open);
  });
});
