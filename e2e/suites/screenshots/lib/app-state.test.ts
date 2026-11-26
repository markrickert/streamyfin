import { runComparison } from "./run";
import { execs, Fake, happyRoutes, REPO, runCli, seed } from "./testing";

describe("fresh-state capture sequence", () => {
  // The Android phone captures on the Release repack: pm clear per pass is the
  // whole reset — the dev-client preference writes only work through run-as on a
  // debuggable build, and a Release app refuses them.
  it("resets the release app per capture pass on Android, with no run-as writes and no deep link", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);

    const clears = execs(f, "pm clear");
    expect(clears).toHaveLength(3);
    for (const argv of clears)
      expect(argv).toContain("com.example.streamyfin.debug");
    expect(execs(f, "run-as")).toHaveLength(0);
    expect(execs(f, "am start")).toHaveLength(0);
    // Every clear precedes that pass's flow; the flow's own launchApp opens the app.
    const trace = f.execLog.map((argv) => argv.join(" "));
    const firstClear = trace.findIndex((a) => a.includes("pm clear"));
    const firstFlow = trace.findIndex((a) => a.includes("maestro.py"));
    expect(firstClear).toBeGreaterThanOrEqual(0);
    expect(firstClear).toBeLessThan(firstFlow);
  });

  // android-tv stays on the Debug dev client: the run-as preference writes and the
  // deep-link launch still run per pass there.
  it("keeps the debug-client reset on android-tv: run-as preference writes and the deep link stay", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes = f.routes.filter(([needle]) => needle !== "has-feature");
    f.routes.push(["has-feature", { code: 0, stdout: "true\n", stderr: "" }]);
    await runComparison(f, { ...runCli, platform: "android-tv" }, REPO);

    expect(execs(f, "pm clear")).toHaveLength(3);
    // Fast Refresh off + dev-menu FAB off, pushed and copied once per pass.
    expect(
      execs(f, "shared_prefs/com.example.streamyfin.debug_preferences.xml"),
    ).toHaveLength(3);
    expect(
      execs(f, "shared_prefs/expo.modules.devmenu.sharedpreferences.xml"),
    ).toHaveLength(3);
    expect(execs(f, "run-as")).toHaveLength(12);
    expect(execs(f, "am start")).toHaveLength(3);
  });
});
