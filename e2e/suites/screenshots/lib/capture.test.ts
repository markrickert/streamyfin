import { runComparison } from "./run";
import {
  execs,
  Fake,
  FakeSpawn,
  happyRoutes,
  REPO,
  runCli,
  seed,
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
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(
      /already listening/,
    );
    // No Metro was spawned, so nothing the runner owns was killed either.
    expect(f.spawns).toHaveLength(0);
  });

  it("fails before captures when its Metro dies but a foreign packager satisfies /status", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.spawn = (argv: string[]) => {
      const handle = new FakeSpawn(argv);
      handle.alive = false; // died immediately; /status is a foreign Metro's
      return handle;
    };
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(
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
    await runComparison(f, runCli, REPO);
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

describe("dev-client deep link quoting", () => {
  it("single-quotes the URL so adb's remote shell cannot split on &", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
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
