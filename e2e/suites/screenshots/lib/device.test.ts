import { ShotError } from "./core";
import {
  ensurePortFree,
  prepareDevice,
  selectDevice,
  simctlInstall,
} from "./device";
import { runComparison } from "./run";
import {
  execs,
  Fake,
  happyRoutes,
  ok,
  REPO,
  runCli,
  seed,
  simctlFake,
} from "./testing";

describe("device setup", () => {
  const demo = (f: Fake) =>
    execs(f, "com.android.systemui.demo").map((argv) => argv.join(" "));

  // Gboard's "Try out your stylus" tutorial opened over the login screen once typing
  // started, and hid the Connect button from the flow.
  it("turns stylus handwriting off and freezes the status bar before the first pass", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    const trace = f.execLog.map((argv) => argv.join(" "));
    const stylus = trace.findIndex((a) =>
      a.includes(
        "adb -s emulator-5554 shell settings put secure stylus_handwriting_enabled 0",
      ),
    );
    const allowed = trace.findIndex((a) =>
      a.includes("settings put global sysui_demo_allowed 1"),
    );
    const firstClear = trace.findIndex((a) => a.includes("pm clear"));
    expect(stylus).toBeGreaterThanOrEqual(0);
    expect(stylus).toBeLessThan(firstClear);
    expect(allowed).toBeGreaterThanOrEqual(0);
    const commands = demo(f);
    expect(commands[0]).toContain("-e command enter");
    for (const value of [
      "-e command clock -e hhmm 1200",
      "-e command battery -e level 100 -e plugged false",
      "-e command network -e wifi show -e level 4",
      "-e command network -e mobile show -e datatype none -e level 4",
      "-e command notifications -e visible false",
      "-e command status -e bluetooth hide -e alarm hide -e location hide -e volume hide",
    ])
      expect(commands.some((c) => c.includes(value))).toBe(true);
    expect(trace.findIndex((a) => a.includes("-e command enter"))).toBeLessThan(
      firstClear,
    );
  });

  it("leaves demo mode when the run ends", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    expect(demo(f).at(-1)).toContain("-e command exit");
  });

  // Local runs must leave the emulator's animation and input settings as they found them.
  it.each([false, true])(
    "restores Android device settings after flow failure=%s",
    async (fail) => {
      const f = new Fake();
      seed(f);
      happyRoutes(f);
      f.routes.unshift([
        "settings get",
        (_f, argv) => ({
          code: 0,
          stdout:
            argv.at(-1) === "stylus_handwriting_enabled" ? "1\n" : "0.5\n",
          stderr: "",
        }),
      ]);
      if (fail)
        f.routes.push([
          "pass-mobile.yml",
          { code: 1, stdout: "", stderr: "boom" },
        ]);
      if (fail)
        await expect(runComparison(f, runCli, REPO)).rejects.toThrow(ShotError);
      else await runComparison(f, runCli, REPO);
      const trace = f.execLog.map((a) => a.join(" "));
      for (const scale of [
        "window_animation_scale",
        "transition_animation_scale",
        "animator_duration_scale",
      ]) {
        expect(trace).toContain(
          `adb -s emulator-5554 shell settings put global ${scale} 0`,
        );
        expect(trace).toContain(
          `adb -s emulator-5554 shell settings put global ${scale} 0.5`,
        );
      }
      expect(trace).toContain(
        "adb -s emulator-5554 shell settings put secure stylus_handwriting_enabled 1",
      );
      expect(trace).toContain(
        "adb -s emulator-5554 shell settings put global sysui_demo_allowed 0.5",
      );
      expect(
        trace.indexOf(
          `adb -s emulator-5554 shell settings put global window_animation_scale 0`,
        ),
      ).toBeLessThan(trace.findIndex((s) => s.includes("pm clear")));
    },
  );

  it("restores Android TV animation scales even when setup fails halfway", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.unshift([
      "has-feature",
      { code: 0, stdout: "true\n", stderr: "" },
    ]);
    f.routes.push(["settings get", { code: 0, stdout: "null\n", stderr: "" }]);
    f.routes.push([
      "settings put global transition_animation_scale 0",
      { code: 1, stdout: "", stderr: "denied" },
    ]);
    await expect(
      runComparison(f, { ...runCli, platform: "android-tv" }, REPO),
    ).rejects.toThrow(/animation/);
    expect(
      execs(f, "settings delete global window_animation_scale"),
    ).toHaveLength(1);
  });

  it("leaves demo mode when a flow fails", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push(["pass-mobile.yml", { code: 1, stdout: "", stderr: "boom" }]);
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(ShotError);
    expect(demo(f).at(-1)).toContain("-e command exit");
  });

  it("leaves demo mode when the status bar setup fails after entering it", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "com.android.systemui.demo -e command clock",
      { code: 1, stdout: "", stderr: "boom" },
    ]);
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(ShotError);
    expect(demo(f).at(-1)).toContain("-e command exit");
  });

  it("fails the run when the stylus setting cannot be written", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "stylus_handwriting_enabled",
      { code: 1, stdout: "", stderr: "denied" },
    ]);
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(
      /stylus handwriting/,
    );
    expect(execs(f, "pm clear")).toHaveLength(0);
  });

  it("turns stylus handwriting off on Android TV but leaves its status bar alone", () => {
    const f = new Fake();
    f.routes.push(
      ["settings put", ok],
      ["settings get", { code: 0, stdout: "null\n", stderr: "" }],
    );
    prepareDevice(f, "android-tv", "emulator-5556");
    expect(
      execs(f, "settings put secure stylus_handwriting_enabled"),
    ).toHaveLength(1);
    expect(execs(f, "com.android.systemui.demo")).toHaveLength(0);
    expect(execs(f, "sysui_demo_allowed")).toHaveLength(0);
  });

  it("freezes the iPhone status bar with the same values as the Android phone", () => {
    const f = new Fake();
    f.routes.push(
      ["status_bar", ok],
      ["defaults read", { code: 1, stdout: "", stderr: "not found" }],
      ["defaults write", ok],
    );
    prepareDevice(f, "ios", "UDID");
    expect(f.execLog.at(-1)).toEqual([
      "xcrun",
      "simctl",
      "status_bar",
      "UDID",
      "override",
      "--time",
      "2026-01-01T12:00:00.000Z",
      "--dataNetwork",
      "wifi",
      "--wifiMode",
      "active",
      "--wifiBars",
      "3",
      "--cellularMode",
      "active",
      "--cellularBars",
      "4",
      "--operatorName",
      "",
      "--batteryState",
      "charged",
      "--batteryLevel",
      "100",
    ]);
  });

  it.each([false, true])(
    "restores iOS Reduce Motion after flow failure=%s",
    async (fail) => {
      const f = simctlFake();
      seed(f);
      happyRoutes(f);
      f.routes.push(["status_bar", ok]);
      f.routes.unshift([
        "defaults read com.apple.Accessibility ReduceMotionEnabled",
        { code: 0, stdout: "0\n", stderr: "" },
      ]);
      f.routes.push([
        "defaults write com.apple.Accessibility ReduceMotionEnabled",
        ok,
      ]);
      f.routes.push(
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
            const derived = argv[argv.indexOf("-derivedDataPath") + 1];
            fake.dirs.add(`${derived}/Build/Products/Debug-iphonesimulator`);
            fake.dirs.add(
              `${derived}/Build/Products/Debug-iphonesimulator/Streamyfin.app`,
            );
            return ok;
          },
        ],
        [
          "PlistBuddy",
          { code: 0, stdout: "com.example.streamyfin\n", stderr: "" },
        ],
        ["simctl uninstall", ok],
        ["simctl install", ok],
        [
          "get_app_container",
          { code: 0, stdout: "/sim/container\n", stderr: "" },
        ],
        ["plutil", ok],
        ["simctl openurl", ok],
      );
      if (fail)
        f.routes.push([
          "pass-mobile.yml",
          { code: 1, stdout: "", stderr: "boom" },
        ]);
      if (fail)
        await expect(
          runComparison(
            f,
            { ...runCli, platform: "ios", device: "UDID-PHONE" },
            REPO,
          ),
        ).rejects.toThrow(ShotError);
      else
        await runComparison(
          f,
          { ...runCli, platform: "ios", device: "UDID-PHONE" },
          REPO,
        );
      const trace = f.execLog.map((a) => a.join(" "));
      expect(trace).toContain(
        "xcrun simctl spawn UDID-PHONE defaults write com.apple.Accessibility ReduceMotionEnabled -bool YES",
      );
      expect(trace).toContain(
        "xcrun simctl spawn UDID-PHONE defaults write com.apple.Accessibility ReduceMotionEnabled -bool NO",
      );
      expect(
        trace.indexOf(
          "xcrun simctl spawn UDID-PHONE defaults write com.apple.Accessibility ReduceMotionEnabled -bool YES",
        ),
      ).toBeLessThan(
        trace.findIndex((s) => s.includes("status_bar UDID-PHONE override")),
      );
    },
  );

  it("does nothing on Apple TV, which has no status bar", () => {
    const f = new Fake();
    prepareDevice(f, "apple-tv", "UDID");
    expect(f.execLog).toHaveLength(0);
  });
});

describe("selectDevice", () => {
  it("parses simctl's runtime-keyed shape and separates tvOS from iOS", () => {
    const f = simctlFake();
    expect(selectDevice(f, "ios", undefined)).toBe("UDID-PHONE");
    expect(selectDevice(f, "apple-tv", undefined)).toBe("UDID-TV");
  });
  it("rejects an explicit UDID of the wrong simulator kind", () => {
    const f = simctlFake();
    expect(() => selectDevice(f, "apple-tv", "UDID-PHONE")).toThrow(
      /not a Apple TV simulator/,
    );
  });
  it("requires --device when more than one matching simulator is booted", () => {
    const f = simctlFake({
      "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
        { udid: "A", name: "iPhone 17 Pro" },
        { udid: "B", name: "iPhone 16" },
      ],
    });
    expect(() => selectDevice(f, "ios", undefined)).toThrow(/--device/);
  });
  it("requires --device when more than one Android emulator is running", () => {
    const f = new Fake();
    f.routes.push([
      "adb devices",
      {
        code: 0,
        stdout:
          "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n",
        stderr: "",
      },
    ]);
    expect(() => selectDevice(f, "android", undefined)).toThrow(/--device/);
  });
});

describe("simctlInstall", () => {
  // SimError 405 is the CoreSimulator service dying mid-install; it restarts
  // itself, so bootstatus -b waits for the device and the install retries once.
  it("waits for boot and retries the install once when CoreSimulator dies", () => {
    const f = new Fake();
    let installs = 0;
    f.routes.push(
      [
        "simctl install",
        () => {
          installs += 1;
          return installs === 1
            ? {
                code: 1,
                stdout: "",
                stderr:
                  "(domain=com.apple.CoreSimulator.SimError, code=405): Invalid device state … (Mach error -308 - (ipc/mig) server died)",
              }
            : ok;
        },
      ],
      ["simctl bootstatus", ok],
    );
    expect(() =>
      simctlInstall(
        f,
        "UDID-PHONE",
        "/sim/Streamyfin.app",
        "simctl install test app",
      ),
    ).not.toThrow();
    expect(f.execLog.map((argv) => argv.join(" "))).toEqual([
      "xcrun simctl install UDID-PHONE /sim/Streamyfin.app",
      "xcrun simctl bootstatus UDID-PHONE -b",
      "xcrun simctl install UDID-PHONE /sim/Streamyfin.app",
    ]);
    expect(f.logs.some((line) => line.includes("CoreSimulator"))).toBe(true);
  });

  it("does not retry an install failure that is not a dead CoreSimulator", () => {
    const f = new Fake();
    f.routes.push([
      "simctl install",
      { code: 1, stdout: "", stderr: "An application was not specified" },
    ]);
    expect(() =>
      simctlInstall(f, "UDID-PHONE", "/sim/a.app", "simctl install test app"),
    ).toThrow("simctl install test app failed (1)");
    expect(execs(f, "simctl install")).toHaveLength(1);
    expect(execs(f, "bootstatus")).toHaveLength(0);
  });

  it("throws after the retry when CoreSimulator dies again", () => {
    const f = new Fake();
    f.routes.push(
      [
        "simctl install",
        { code: 1, stdout: "", stderr: "(ipc/mig) server died" },
      ],
      ["simctl bootstatus", ok],
    );
    expect(() =>
      simctlInstall(f, "UDID-PHONE", "/sim/a.app", "simctl install"),
    ).toThrow("simctl install failed (1)");
    expect(execs(f, "simctl install")).toHaveLength(2);
    expect(execs(f, "bootstatus")).toHaveLength(1);
  });
});

describe("ensurePortFree", () => {
  it("fails when lsof itself fails instead of reading a missing listener as free", () => {
    const f = new Fake();
    f.routes.push([
      "lsof",
      { code: 127, stdout: "", stderr: "lsof: not found" },
    ]);
    expect(() => ensurePortFree(f, 18081)).toThrow(/cannot verify port/);
  });
});

describe("selectDevice leanback check", () => {
  const adbFake = (leanback: string) => {
    const f = new Fake();
    f.routes.push(
      [
        "adb devices",
        {
          code: 0,
          stdout: "List of devices attached\nemulator-5554\tdevice\n",
          stderr: "",
        },
      ],
      // `pm has-feature` exits 1 when the feature is absent — the boolean is stdout.
      [
        "has-feature",
        {
          code: leanback === "true" ? 0 : 1,
          stdout: `${leanback}\n`,
          stderr: "",
        },
      ],
    );
    return f;
  };
  it("accepts a phone emulator for android and rejects a TV one", () => {
    expect(selectDevice(adbFake("false"), "android", undefined)).toBe(
      "emulator-5554",
    );
    expect(() => selectDevice(adbFake("true"), "android", undefined)).toThrow(
      /Android TV emulator, not a phone/,
    );
  });
  it("accepts a TV emulator for android-tv and rejects a phone one", () => {
    expect(selectDevice(adbFake("true"), "android-tv", undefined)).toBe(
      "emulator-5554",
    );
    expect(() =>
      selectDevice(adbFake("false"), "android-tv", undefined),
    ).toThrow(/not an Android TV emulator/);
  });
});
