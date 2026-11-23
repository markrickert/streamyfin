import { type Deps, must, type Platform, ShotError } from "./core";

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

const DEMO_BROADCAST = "com.android.systemui.demo";

/** The status bar values every Android phone shot is taken with. */
const DEMO_STATUS_BAR: string[][] = [
  ["clock", "-e", "hhmm", "1200"],
  ["battery", "-e", "level", "100", "-e", "plugged", "false"],
  ["network", "-e", "wifi", "show", "-e", "level", "4"],
  [
    "network",
    "-e",
    "mobile",
    "show",
    "-e",
    "datatype",
    "none",
    "-e",
    "level",
    "4",
  ],
  ["notifications", "-e", "visible", "false"],
];

const demoCommand = (device: string, command: string[]) => [
  "adb",
  "-s",
  device,
  "shell",
  "am",
  "broadcast",
  "-a",
  DEMO_BROADCAST,
  "-e",
  "command",
  ...command,
];

/**
 * The iPhone counterpart of DEMO_STATUS_BAR. `simctl` accepts only an ISO 8601 time
 * with fractional seconds (a bare "12:00" is refused), and the simulator shows it in the
 * Mac's time zone, so the time is local noon: the clock reads 12:00 on any Mac.
 */
const IOS_STATUS_BAR = [
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
];

/**
 * Prepares the selected emulator or simulator for capture. The phone's status bar is
 * frozen, so the clock, signal, battery and notification icons are the same in every
 * shot, and the run's cleanup puts it back (restoreDevice): System UI demo mode on
 * Android, `simctl status_bar` on iOS. TV has no status bar. Stylus handwriting goes
 * off on every Android emulator: Gboard's "Try out your stylus" tutorial can open over
 * a field as typing starts and hide the controls below it. The setting is written on
 * every run, because a wiped or new emulator starts with the default. Only emulators
 * and simulators reach here: selectDevice refuses anything else.
 */
export function prepareDevice(
  d: Deps,
  platform: Platform,
  device: string,
): void {
  if (platform === "ios") {
    must(
      d.exec([
        "xcrun",
        "simctl",
        "status_bar",
        device,
        "override",
        ...IOS_STATUS_BAR,
      ]),
      "override the simulator status bar",
    );
    return;
  }
  if (platform !== "android" && platform !== "android-tv") return;
  must(
    d.exec([
      "adb",
      "-s",
      device,
      "shell",
      "settings",
      "put",
      "secure",
      "stylus_handwriting_enabled",
      "0",
    ]),
    "turn stylus handwriting off",
  );
  if (platform !== "android") return;
  must(
    d.exec([
      "adb",
      "-s",
      device,
      "shell",
      "settings",
      "put",
      "global",
      "sysui_demo_allowed",
      "1",
    ]),
    "allow status bar demo mode",
  );
  must(d.exec(demoCommand(device, ["enter"])), "enter status bar demo mode");
  for (const command of DEMO_STATUS_BAR)
    must(d.exec(demoCommand(device, command)), "set demo status bar");
}

/**
 * Undoes prepareDevice's status bar. Best effort: it runs in the run's cleanup, where a
 * throw would hide the run's error. Sent on every phone run, even one whose setup never
 * finished: undoing a status bar that was never frozen changes nothing, and a setup
 * that failed halfway still gets undone.
 */
export function restoreDevice(
  d: Deps,
  platform: Platform,
  device: string,
): void {
  const argv =
    platform === "android"
      ? demoCommand(device, ["exit"])
      : platform === "ios"
        ? ["xcrun", "simctl", "status_bar", device, "clear"]
        : undefined;
  if (argv && d.exec(argv).code !== 0)
    d.log(`could not restore the status bar on ${device}`);
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
