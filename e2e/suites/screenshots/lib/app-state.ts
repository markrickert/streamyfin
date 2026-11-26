import { type Deps, must, type Platform } from "./core";
import { simctlInstall } from "./device";

/**
 * Fresh app state per capture pass, scoped to the TEST app only: Android `pm clear`
 * on the exact debug package aapt reported (never a substring — the release app on
 * the same emulator is untouched); iOS/tvOS uninstall + reinstall of the built .app,
 * never a whole-simulator erase. The login/intro flows then capture 00-* on genuinely
 * first-run state.
 */
export function resetTestAppState(
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
    hideAndroidDevMenuFab(d, device, appId);
    return;
  }
  must(
    d.exec(["xcrun", "simctl", "uninstall", device, appId]),
    "simctl uninstall test app",
  );
  simctlInstall(d, device, artifact, "simctl install test app");
  const plist = disableFastRefresh(d, device, appId);
  hideDevMenuFab(d, plist);
}

const FAST_REFRESH_OFF_XML =
  '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map>\n    <boolean name="hot_module_replacement" value="false" />\n</map>\n';

const DEV_MENU_FAB_OFF_XML =
  '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map>\n    <boolean name="showFab" value="false" />\n</map>\n';

/**
 * Writes one shared preferences file into the test app. The file goes in through
 * `adb push` and `run-as` (the debug build is debuggable), which keeps the XML out of
 * the remote shell's quoting. Best effort: a failure only means an overlay may show,
 * never a failed run.
 */
function writeAndroidPrefs(
  d: Deps,
  device: string,
  appId: string,
  name: string,
  file: string,
  xml: string,
): void {
  const local = `/tmp/streamyfin-shots-${name}.xml`;
  const staged = `/data/local/tmp/streamyfin-shots-${name}.xml`;
  d.fs.write(local, xml);
  const adb = ["adb", "-s", device];
  for (const argv of [
    [...adb, "push", local, staged],
    [...adb, "shell", "run-as", appId, "mkdir", "-p", "shared_prefs"],
    [...adb, "shell", "run-as", appId, "cp", staged, `shared_prefs/${file}`],
  ])
    if (d.exec(argv).code !== 0) return;
}

/**
 * Android counterpart of disableFastRefresh: React Native reads `hot_module_replacement`
 * from the app's default shared preferences.
 */
function disableAndroidFastRefresh(
  d: Deps,
  device: string,
  appId: string,
): void {
  writeAndroidPrefs(
    d,
    device,
    appId,
    "fast-refresh-off",
    `${appId}_preferences.xml`,
    FAST_REFRESH_OFF_XML,
  );
}

/**
 * Turns off the dev menu's floating button. The deep link's __expo_disable_fab lasts
 * only for the process it opens (expo-dev-menu's DevMenuLaunchOverrides). A flow's
 * launchApp restarts the app, the button comes back, and its "Tools" label shows for
 * its first 10 s, so two shots of one screen differ on timing alone. The stored
 * `showFab` preference survives restarts.
 */
function hideAndroidDevMenuFab(d: Deps, device: string, appId: string): void {
  writeAndroidPrefs(
    d,
    device,
    appId,
    "dev-menu-fab-off",
    "expo.modules.devmenu.sharedpreferences.xml",
    DEV_MENU_FAB_OFF_XML,
  );
}

/**
 * Turns Fast Refresh off for the fresh install. Metro pushes an update when a file
 * changes, and the dev client then draws a blue "Refreshing..." banner over the top of
 * the screen. A shot taken meanwhile differs from one taken without it on timing alone.
 * React Native reads the switch from `RCTDevMenu` in the app's defaults at startup, and
 * the runner's deep link carries no flag for it. Returns the defaults plist it wrote.
 */
function disableFastRefresh(d: Deps, device: string, appId: string): string {
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
  return plist;
}

/**
 * iOS and tvOS counterpart of hideAndroidDevMenuFab, in the app defaults plist that
 * disableFastRefresh wrote: expo-dev-menu reads `EXDevMenuShowFloatingActionButton` from
 * the app's defaults at startup.
 */
function hideDevMenuFab(d: Deps, plist: string): void {
  must(
    d.exec([
      "plutil",
      "-insert",
      "EXDevMenuShowFloatingActionButton",
      "-bool",
      "NO",
      plist,
    ]),
    "hide dev menu button",
  );
}
