import { runCapture } from "./capture";
import { platformSpec } from "./cli";
import { ShotError } from "./core";
import { runComparison } from "./run";
import {
  execs,
  Fake,
  FakeSpawn,
  happyRoutes,
  ok,
  PASSWORD,
  REPO,
  runCli,
  seed,
  tvEmulator,
  tvRunCli,
} from "./testing";

describe("adb reverse for the plugin-pushed Seerr URL", () => {
  it("maps tcp:15055 on Android phone too, not only TV", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    const reverses = execs(f, "reverse tcp:");
    for (const argv of reverses)
      expect(argv).toEqual([
        "adb",
        "-s",
        "emulator-5554",
        "reverse",
        "tcp:15055",
        "tcp:15055",
      ]);
    expect(reverses.length).toBeGreaterThanOrEqual(1);
  });
  it("reuses an identical preexisting mapping without creating one", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    // Longer needle than the happy "reverse --list" route so it wins.
    f.routes.push([
      "emulator-5554 reverse --list",
      { code: 0, stdout: "emulator-5554 tcp:15055 tcp:15055\n", stderr: "" },
    ]);
    await runComparison(f, runCli, REPO);
    expect(execs(f, "reverse tcp:")).toHaveLength(0);
  });
  it("aborts on a conflicting mapping to a different host port", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "emulator-5554 reverse --list",
      { code: 0, stdout: "emulator-5554 tcp:15055 tcp:9999\n", stderr: "" },
    ]);
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(
      /held by a mapping to tcp:9999/,
    );
    expect(execs(f, "reverse tcp:")).toHaveLength(0);
  });
});

describe("Metro port TOCTOU and liveness", () => {
  it("refuses when the port fills between preflight and Metro spawn", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    tvEmulator(f);
    let lsofCalls = 0;
    f.routes = f.routes.filter(([m]) => m !== "lsof");
    f.routes.push([
      "lsof",
      () =>
        lsofCalls++ === 0
          ? { code: 1, stdout: "", stderr: "" }
          : {
              code: 0,
              stdout: "foreign 9 metro node *:18081 (LISTEN)\n",
              stderr: "",
            },
    ]);
    await expect(runComparison(f, tvRunCli, REPO)).rejects.toThrow(
      /already listening/,
    );
    // No Metro was spawned, so nothing the runner owns was killed either.
    expect(f.spawns).toHaveLength(0);
  });

  it("starts Metro offline, without telemetry or interactive port-hopping", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    tvEmulator(f);
    await runComparison(f, tvRunCli, REPO);
    for (const opts of f.spawnOpts) {
      expect(opts?.env).toMatchObject({
        EXPO_NO_INTERACTIVE: "1",
        EXPO_OFFLINE: "1",
        EXPO_NO_TELEMETRY: "1",
      });
    }
  });

  // Metro's cache keys on file content and transformer config; only a babel config,
  // metro config or lockfile change between refs needs Expo's --clear.
  it("clears Metro's cache on the first ref and on a later ref whose transform inputs differ", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    tvEmulator(f);
    await runComparison(f, tvRunCli, REPO);
    expect(f.spawns).toHaveLength(2);
    for (const spawn of f.spawns) expect(spawn.argv).toContain("--clear");
    const diffs = execs(f, "git diff --quiet");
    expect(diffs).toHaveLength(1);
    expect(diffs[0].join(" ")).toContain(
      "git diff --quiet sha-before sha-after -- babel.config.js metro.config.js bun.lock",
    );
  });

  it("skips --clear on a later ref whose transform inputs are unchanged", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    tvEmulator(f);
    f.routes.push(["git diff --quiet sha-before sha-after", ok]);
    await runComparison(f, tvRunCli, REPO);
    expect(f.spawns).toHaveLength(2);
    expect(f.spawns[0].argv).toContain("--clear");
    expect(f.spawns[1].argv).not.toContain("--clear");
  });

  it("fails before captures when its Metro dies but a foreign packager satisfies /status", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    tvEmulator(f);
    f.spawn = (argv: string[]) => {
      const handle = new FakeSpawn(argv);
      handle.alive = false; // died immediately; /status is a foreign Metro's
      return handle;
    };
    await expect(runComparison(f, tvRunCli, REPO)).rejects.toThrow(
      /did not report packager-status:running/,
    );
    expect(execs(f, "maestro.py")).toHaveLength(0);
  });
});

describe("dev-client deep link in the flow env", () => {
  // A deep-linked dev client that exits before Maestro starts comes back on a bare
  // launchApp with no Metro URL, and waits on the server picker. The flows re-open the
  // runner's link from this variable, so it must be the exact link the runner sent.
  it("hands every flow the same link the runner deep-linked with", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    tvEmulator(f);
    await runComparison(f, tvRunCli, REPO);
    const sent = execs(f, "am start").map((argv) =>
      argv[argv.indexOf("-d") + 1].slice(1, -1),
    );
    expect(sent).toHaveLength(3);
    const flows = execs(f, "maestro.py");
    expect(flows.length).toBeGreaterThan(0);
    for (const argv of flows) {
      const entry = argv.find((arg) =>
        arg.startsWith("MAESTRO_DEV_CLIENT_URL="),
      );
      expect(sent).toContain(entry?.slice("MAESTRO_DEV_CLIENT_URL=".length));
    }
  });
});

describe("runCapture failure detail", () => {
  // A failing pass throws with the raw stderr/stdout tail, which on CI is often an
  // unrelated warning. The debug output's commands.json names the failing command and
  // the flow chain around it; the thrown error must lead with that.
  const sessionDir = `${REPO}/e2e/reports/shots/session`;
  const outDir = `${sessionDir}/before`;

  function commandsJson(f: Fake, message: string) {
    f.dirs.add(outDir);
    f.dirs.add(`${outDir}/pass-mobile`);
    f.files.set(
      `${outDir}/pass-mobile/commands.json`,
      JSON.stringify([
        {
          command: {
            runFlowCommand: { sourceDescription: "mobile.yml", commands: [] },
          },
          metadata: { status: "FAILED", sequenceNumber: 57, depth: 0 },
        },
        {
          command: {
            runFlowCommand: {
              sourceDescription: "_tap-more.yml",
              commands: [],
            },
          },
          metadata: { status: "FAILED", sequenceNumber: 90, depth: 1 },
        },
        {
          command: {
            tapOnElement: { selector: { textRegex: ".*Settings.*" } },
          },
          metadata: {
            status: "FAILED",
            sequenceNumber: 97,
            depth: 2,
            error: { message },
          },
          artifacts: [
            {
              type: "SCREEN_HIERARCHY",
              path: "screen-hierarchy/step-098-tapOnElement-Settings.json",
            },
            {
              type: "SCREENSHOT",
              path: "screenshots/step-098-tapOnElement-Settings.png",
            },
          ],
        },
      ]),
    );
  }

  function capture(f: Fake) {
    return () =>
      runCapture(
        f,
        "tools",
        platformSpec("android"),
        "emulator-5554",
        outDir,
        { MAESTRO_JELLYFIN_PASS: PASSWORD },
        "maestro",
        false,
      );
  }

  it("names the failed step's chain, command, message and session-relative artifacts", () => {
    const f = new Fake();
    f.routes.push(["maestro.py", { code: 1, stdout: "", stderr: "boom" }]);
    commandsJson(f, "Element not found: Text matching regex: .*Settings.*");
    expect(capture(f)).toThrow(ShotError);
    expect(capture(f)).toThrow(
      "flow pass-mobile failed at mobile.yml > _tap-more.yml: tapOnElement: Element not found: Text matching regex: .*Settings.* " +
        "(screenshot before/pass-mobile/screenshots/step-098-tapOnElement-Settings.png, " +
        "hierarchy before/pass-mobile/screen-hierarchy/step-098-tapOnElement-Settings.json)",
    );
  });

  it("masks the fixture password in the failed step's message", () => {
    const f = new Fake();
    f.routes.push(["maestro.py", { code: 1, stdout: "", stderr: "boom" }]);
    commandsJson(f, `login rejected for ${PASSWORD}`);
    expect(capture(f)).toThrow("login rejected for ***");
    expect(capture(f)).not.toThrow(PASSWORD);
  });

  it("keeps the bare tail when the pass wrote no commands.json", () => {
    const f = new Fake();
    f.routes.push(["maestro.py", { code: 1, stdout: "", stderr: "boom" }]);
    expect(capture(f)).toThrow("flow pass-mobile failed (1): boom");
  });
});

describe("dev-client deep link quoting", () => {
  it("single-quotes the URL so adb's remote shell cannot split on &", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    tvEmulator(f);
    await runComparison(f, tvRunCli, REPO);
    for (const argv of execs(f, "am start")) {
      const dIdx = argv.indexOf("-d");
      const url = argv[dIdx + 1];
      // adb joins argv into one remote command line; the URL must arrive as a
      // single-quoted token or the & splits it and -p becomes a second command.
      expect(url.startsWith("'")).toBe(true);
      expect(url.endsWith("'")).toBe(true);
      expect(url).toContain("&");
    }
  });
});

describe("pass timeout configuration", () => {
  it("passes the default 900s --timeout to maestro.py when SHOTS_PASS_TIMEOUT_SECONDS is unset", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    const flows = execs(f, "maestro.py");
    expect(flows.length).toBeGreaterThan(0);
    for (const argv of flows) {
      const idx = argv.indexOf("--timeout");
      expect(idx).toBeGreaterThan(-1);
      expect(argv[idx + 1]).toBe("900");
    }
  });

  it("forwards SHOTS_PASS_TIMEOUT_SECONDS to maestro.py --timeout", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.env.SHOTS_PASS_TIMEOUT_SECONDS = "2700";
    await runComparison(f, runCli, REPO);
    const flows = execs(f, "maestro.py");
    expect(flows.length).toBeGreaterThan(0);
    for (const argv of flows) {
      const idx = argv.indexOf("--timeout");
      expect(idx).toBeGreaterThan(-1);
      expect(argv[idx + 1]).toBe("2700");
    }
  });

  // The fork's Orchestra.kt reads MAESTRO_OPTIONAL_LOOKUP_TIMEOUT_MS; absent-element
  // `when: visible` and `optional` guards each wait at most this long.
  it("caps Maestro's absent-element lookup through the fork's env override on every pass", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    const passIndices = f.execLog.flatMap((argv, index) =>
      argv.join(" ").includes("maestro.py") ? [index] : [],
    );
    expect(passIndices.length).toBeGreaterThan(0);
    for (const index of passIndices)
      expect(f.execOpts[index]?.env?.MAESTRO_OPTIONAL_LOOKUP_TIMEOUT_MS).toBe(
        "3000",
      );
  });

  it.each(["0", "-5", "abc", "Infinity"])(
    "refuses invalid SHOTS_PASS_TIMEOUT_SECONDS=%s",
    async (bad) => {
      const f = new Fake();
      seed(f);
      happyRoutes(f);
      f.env.SHOTS_PASS_TIMEOUT_SECONDS = bad;
      await expect(runComparison(f, runCli, REPO)).rejects.toThrow(
        /SHOTS_PASS_TIMEOUT_SECONDS/,
      );
    },
  );
});
