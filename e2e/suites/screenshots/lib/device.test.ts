import { ShotError } from "./core";
import { ensurePortFree, prepareDevice, selectDevice } from "./device";
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
    f.routes.push(["settings put", ok]);
    prepareDevice(f, "android-tv", "emulator-5556");
    expect(execs(f, "stylus_handwriting_enabled")).toHaveLength(1);
    expect(execs(f, "com.android.systemui.demo")).toHaveLength(0);
    expect(execs(f, "sysui_demo_allowed")).toHaveLength(0);
  });

  it("freezes the iPhone status bar with the same values as the Android phone", () => {
    const f = new Fake();
    f.routes.push(["status_bar", ok]);
    prepareDevice(f, "ios", "UDID");
    expect(f.execLog).toEqual([
      [
        "xcrun",
        "simctl",
        "status_bar",
        "UDID",
        "override",
        "--time",
        new Date(2026, 0, 1, 12).toISOString(),
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
      ],
    ]);
  });

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
