import {
  BUILD_CACHE_FETCH_ENV,
  BUILD_CACHE_FETCH_TIMEOUT_MS,
  ensureDebugBuild,
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

describe("ensureDebugBuild cache", () => {
  const spec = platformSpec("android");
  it("rebuilds on a new fingerprint, reuses the cache on the same one", () => {
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
    );
    expect(first.built).toBe(true);
    expect(first.source).toBe("built");
    const again = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-a",
      `${REPO}/session`,
    );
    expect(again.built).toBe(false);
    expect(again.source).toBe("local");
    expect(again.artifact).toBe(first.artifact);
    const other = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-b",
      `${REPO}/session`,
    );
    expect(other.built).toBe(true);
    expect(other.source).toBe("built");
    expect(builds).toBe(2);
  });

  it("uses the fetch hook on a local miss and skips building when an APK arrives", () => {
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
        expect(hash).toBe("fp-fetch");
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
    );
    expect(res).toEqual({
      artifact: `${REPO}/e2e/reports/shots/build-cache/android/fp-fetch/app-debug.apk`,
      built: false,
      source: "fetched",
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
        expect(hash).toBe("fp-ios");
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
      artifact: `${REPO}/e2e/reports/shots/build-cache/ios/fp-ios/Streamyfin.app`,
      built: false,
      source: "fetched",
    });
    expect(execs(f, "xcodebuild")).toHaveLength(0);
  });

  it("skips the fetch hook when the local cache already holds the artifact", () => {
    const f = new Fake();
    f.env[BUILD_CACHE_FETCH_ENV] = "/ci/fetch-dev-client.py";
    const cacheDir = `${REPO}/e2e/reports/shots/build-cache/android/fp-hit`;
    f.dirs.add(cacheDir);
    f.files.set(`${cacheDir}/app-debug.apk`, "apk");

    const res = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-hit",
      `${REPO}/session`,
    );
    expect(res).toEqual({
      artifact: `${cacheDir}/app-debug.apk`,
      built: false,
      source: "local",
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
