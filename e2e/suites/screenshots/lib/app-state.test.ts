import { runComparison } from "./run";
import { execs, Fake, happyRoutes, REPO, runCli, seed } from "./testing";

describe("fresh-state capture sequence", () => {
  it("resets the test app and deep-links per capture pass on Android", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);

    // before + noise + after → three pm clears of the DEBUG package only, each
    // followed by its own deep-link launch before the flows run.
    const clears = execs(f, "pm clear");
    expect(clears).toHaveLength(3);
    for (const argv of clears)
      expect(argv).toContain("com.example.streamyfin.debug");
    const starts = execs(f, "am start");
    expect(starts).toHaveLength(3);
    for (const argv of starts) {
      const joined = argv.join(" ");
      expect(joined).toContain("streamyfin://?__expo_url=");
      expect(joined).toContain("__expo_disable_onboarding=1");
      expect(joined).toContain("__expo_disable_fab=1");
      expect(joined).toContain("-p com.example.streamyfin.debug");
    }
    // Fast Refresh is switched off after each clear, before that pass's launch.
    const prefs = execs(f, "_preferences.xml");
    expect(prefs).toHaveLength(3);
    for (const argv of prefs)
      expect(argv.join(" ")).toContain(
        "run-as com.example.streamyfin.debug cp /data/local/tmp/streamyfin-shots-fast-refresh-off.xml shared_prefs/com.example.streamyfin.debug_preferences.xml",
      );
    expect(f.files.get("/tmp/streamyfin-shots-fast-refresh-off.xml")).toContain(
      'name="hot_module_replacement" value="false"',
    );
    // The dev menu's floating button is off after each clear, before that pass's launch.
    // The deep link's __expo_disable_fab lasts one process; a flow's launchApp restarts
    // the app and brings the button back, its "Tools" label in the first 10 s of a shot.
    const fab = execs(f, "expo.modules.devmenu.sharedpreferences.xml");
    expect(fab).toHaveLength(3);
    for (const argv of fab)
      expect(argv.join(" ")).toContain(
        "run-as com.example.streamyfin.debug cp /data/local/tmp/streamyfin-shots-dev-menu-fab-off.xml shared_prefs/expo.modules.devmenu.sharedpreferences.xml",
      );
    expect(f.files.get("/tmp/streamyfin-shots-dev-menu-fab-off.xml")).toContain(
      'name="showFab" value="false"',
    );
    const steps = f.execLog.map((argv) => argv.join(" "));
    expect(
      steps.findIndex((a) => a.includes("devmenu.sharedpreferences.xml")),
    ).toBeLessThan(steps.findIndex((a) => a.includes("am start")));
    const order = f.execLog.map((argv) => argv.join(" "));
    expect(order.findIndex((a) => a.includes("pm clear"))).toBeLessThan(
      order.findIndex((a) => a.includes("_preferences.xml")),
    );
    expect(order.findIndex((a) => a.includes("_preferences.xml"))).toBeLessThan(
      order.findIndex((a) => a.includes("am start")),
    );
    // Every clear precedes its own launch, which precedes that pass's flows.
    const trace = f.execLog.map((argv) => argv.join(" "));
    const firstClear = trace.findIndex((a) => a.includes("pm clear"));
    const firstStart = trace.findIndex((a) => a.includes("am start"));
    const firstFlow = trace.findIndex((a) => a.includes("maestro.py"));
    expect(firstClear).toBeLessThan(firstStart);
    expect(firstStart).toBeLessThan(firstFlow);
  });
});
