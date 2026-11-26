import { DEV_CLIENT_RECIPE } from "./build";
import { type Cli, ShotError } from "./core";
import { doctor, metroBundleUrl, runComparison } from "./run";
import {
  execs,
  Fake,
  happyRoutes,
  MAESTRO_BIN,
  MAESTRO_TOOLS,
  ok,
  PASSWORD,
  REPO,
  runCli,
  SIMCTL_JSON,
  seed,
} from "./testing";
import { DEFAULT_PORT, MAESTRO_SHA256, MAESTRO_TAG } from "./tooling";

describe("doctor", () => {
  const doctorCli: Cli = { command: "doctor", platform: "android" };

  /** A fixture that answers healthy only once `bun run e2e:setup` has run. */
  function fixtureRoutes(f: Fake, { up }: { up: boolean }) {
    let healthy = up;
    f.routes.push(
      ["status --porcelain", { code: 0, stdout: "", stderr: "" }],
      [
        "/health",
        () => ({ code: 0, stdout: healthy ? "200" : "000", stderr: "" }),
      ],
      [
        "/api/v1/settings/public",
        () =>
          healthy
            ? { code: 0, stdout: '{"initialized":true}', stderr: "" }
            : { code: 7, stdout: "", stderr: "refused" },
      ],
      [
        "bun run e2e:setup",
        () => {
          healthy = true;
          return ok;
        },
      ],
      ["bun run e2e:seed", ok],
      ["bun run e2e:enrich", ok],
      ["suites.syncplay import seerr", ok],
    );
  }

  it("stays read-only without --fix", () => {
    const f = new Fake();
    seed(f);
    fixtureRoutes(f, { up: false });
    const report = doctor(f, doctorCli, REPO);
    expect(report.ok).toBe(false);
    expect(execs(f, "bun run e2e:")).toHaveLength(0);
  });

  it("brings the fixture up with --fix and reports the rechecked state", () => {
    const f = new Fake();
    seed(f);
    fixtureRoutes(f, { up: false });
    const report = doctor(f, { ...doctorCli, fix: true }, REPO);
    expect(execs(f, "bun run e2e:").map((argv) => argv[2])).toEqual([
      "e2e:setup",
      "e2e:seed",
      "e2e:enrich",
    ]);
    expect(execs(f, "suites.syncplay import seerr")).toHaveLength(1);
    expect(report).toEqual({
      ok: true,
      checks: [
        "tree clean",
        "jellyfin fixture healthy",
        "seerr fixture initialized",
        `maestro ${MAESTRO_TAG} installed`,
      ],
    });
  });

  it("leaves a healthy fixture alone with --fix", () => {
    const f = new Fake();
    seed(f);
    fixtureRoutes(f, { up: true });
    expect(doctor(f, { ...doctorCli, fix: true }, REPO).ok).toBe(true);
    expect(execs(f, "bun run e2e:")).toHaveLength(0);
  });

  it("never touches a dirty tree, even with --fix", () => {
    const f = new Fake();
    seed(f);
    fixtureRoutes(f, { up: true });
    f.routes.unshift([
      "status --porcelain --untracked-files=all",
      { code: 0, stdout: " M app.tsx", stderr: "" },
    ]);
    const report = doctor(f, { ...doctorCli, fix: true }, REPO);
    expect(report.checks[0]).toContain("tree dirty");
    expect(
      f.execLog.filter((argv) => argv[0] === "git" && argv[1] !== "status"),
    ).toHaveLength(0);
  });

  function downloadRoutes(f: Fake) {
    f.routes.push(
      ["curl -fsSL", ok],
      ["shasum", { code: 0, stdout: `${MAESTRO_SHA256}  x.zip\n`, stderr: "" }],
      [
        "unzip",
        (fake) => {
          fake.files.set(MAESTRO_BIN, "bin");
          return ok;
        },
      ],
      ["chmod", ok],
    );
  }

  it("fails without the pinned maestro, even when an older pin is cached", () => {
    const f = new Fake();
    seed(f);
    fixtureRoutes(f, { up: true });
    f.files.delete(MAESTRO_BIN);
    f.files.set(`${MAESTRO_TOOLS}/cli-0.0.1/maestro/bin/maestro`, "old");
    const report = doctor(f, doctorCli, REPO);
    expect(report.ok).toBe(false);
    expect(report.checks).toContain(`maestro ${MAESTRO_TAG} NOT installed`);
    expect(execs(f, "curl -fsSL")).toHaveLength(0);
  });

  for (const platform of ["android", "apple-tv"] as const)
    it(`installs the pinned maestro with --fix on ${platform}`, () => {
      const f = new Fake();
      seed(f);
      fixtureRoutes(f, { up: true });
      f.files.delete(MAESTRO_BIN);
      downloadRoutes(f);
      const report = doctor(
        f,
        { command: "doctor", platform, fix: true },
        REPO,
      );
      expect(execs(f, "curl -fsSL")).toHaveLength(1);
      expect(execs(f, "unzip")[0]).toContain(`${MAESTRO_TOOLS}/${MAESTRO_TAG}`);
      expect(report.ok).toBe(true);
      expect(report.checks).toContain(`maestro ${MAESTRO_TAG} installed`);
    });
});

describe("runComparison preflight", () => {
  it("refuses a dirty tree before any git switch", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f, { dirty: " M app/x.ts\n" });
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(ShotError);
    expect(execs(f, "git switch")).toHaveLength(0);
  });
});

describe("runComparison restore", () => {
  /** Each ref's checkout carries its own lockfile, as a real `git switch` would. */
  function lockfilePerRef(f: Fake, locks: Record<string, string>) {
    for (const [needle, lock] of Object.entries(locks))
      f.routes.push([
        needle,
        (fake) => {
          fake.files.set(`${REPO}/bun.lock`, lock);
          return ok;
        },
      ]);
  }

  it("reinstalls the starting branch's dependencies when the last ref's lockfile differs", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    lockfilePerRef(f, {
      "git switch --detach sha-before": "lock-v0",
      "git switch --detach sha-after": "lock-v0",
      "git switch feat/dev": "lock-v1",
    });
    await runComparison(f, runCli, REPO);
    const installs = f.execLog
      .map((argv) => argv.join(" "))
      .filter(
        (cmd) =>
          cmd.includes("bun install --frozen-lockfile") ||
          cmd.includes("git switch"),
      );
    expect(installs).toEqual([
      "git switch --detach sha-before",
      "bun install --frozen-lockfile",
      "git switch --detach sha-after",
      "git switch feat/dev",
      "bun install --frozen-lockfile",
    ]);
  });

  it("skips the reinstall when the last ref already installed the starting lockfile", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    lockfilePerRef(f, {
      "git switch --detach sha-before": "lock-v0",
      "git switch --detach sha-after": "lock-v1",
      "git switch feat/dev": "lock-v1",
    });
    await runComparison(f, runCli, REPO);
    expect(execs(f, "bun install --frozen-lockfile")).toHaveLength(2);
  });

  it("reports a failed restore install without hiding the run's own error", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    lockfilePerRef(f, {
      "git switch --detach sha-before": "lock-v0",
      "git switch feat/dev": "lock-v1",
    });
    let installs = 0;
    f.routes = f.routes.filter(
      ([needle]) => needle !== "bun install --frozen-lockfile",
    );
    f.routes.push(
      [
        "bun install --frozen-lockfile",
        () =>
          ++installs === 1 ? ok : { code: 1, stdout: "", stderr: "offline" },
      ],
      ["compare.ts --before", { code: 1, stdout: "", stderr: "boom" }],
    );
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(
      /compare failed/,
    );
    expect(installs).toBe(2);
    expect(f.logs.join("\n")).toContain(
      "bun install failed while restoring feat/dev",
    );
  });
});

describe("runComparison ordering", () => {
  it("captures before then noise on the before ref, then after on a second Metro", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const report = await runComparison(f, runCli, REPO);

    const trace = (needle: string) =>
      f.execLog.findIndex((argv) => argv.join(" ").includes(needle));
    const switchBefore = trace("git switch --detach sha-before");
    const beforeOut = f.execLog.findIndex((argv) =>
      argv.join(" ").includes(`/before`),
    );
    const noiseOut = f.execLog.findIndex((argv) =>
      argv.join(" ").includes(`/noise`),
    );
    const switchAfter = trace("git switch --detach sha-after");
    const afterOut = f.execLog.findIndex((argv) =>
      argv.join(" ").includes(`/after`),
    );
    expect(switchBefore).toBeGreaterThanOrEqual(0);
    expect(switchBefore).toBeLessThan(beforeOut);
    expect(beforeOut).toBeLessThan(noiseOut);
    expect(noiseOut).toBeLessThan(switchAfter);
    expect(switchAfter).toBeLessThan(afterOut);

    // One owned Metro per ref, both stopped, each logging into the session dir.
    expect(f.spawns).toHaveLength(2);
    expect(f.spawns.every((s) => s.killed)).toBe(true);
    expect(f.spawnOpts.map((o) => o?.logFile?.split("/").pop())).toEqual([
      "metro-before.log",
      "metro-after.log",
    ]);
    // Each first bundle logs how long it took.
    expect(
      f.logs.filter((line) =>
        /^Metro bundled android JS in (\d+s|\d+m\d+s)$/.test(line),
      ),
    ).toHaveLength(2);

    // compare runs from the snapshot, before/noise/after wired together.
    const compare = execs(f, "compare.ts")[0].join(" ");
    expect(compare).toContain("--before");
    expect(compare).toContain("--noise");
    expect(compare).toContain("--after");
    expect(report.beforeSha).toBe("sha-before");
  });

  it("drives a phone with the pinned maestro, without the tvOS platform", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    const flows = execs(f, "maestro.py");
    expect(flows.length).toBeGreaterThan(0);
    for (const argv of flows) {
      expect(argv.join(" ")).toContain(`--maestro ${MAESTRO_BIN}`);
      expect(argv).not.toContain("tvos");
      expect(argv).toContain("MAESTRO_TVOS=0");
    }
  });

  // A pass is one parent invocation: splitting it back into per-flow maestro runs
  // would reset nothing between flows and break the order the parent enforces.
  it("runs the phone pass as exactly three maestro invocations, one parent per capture dir", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    const flows = execs(f, "maestro.py");
    expect(flows).toHaveLength(3);
    const passes = ["before", "noise", "after"];
    flows.forEach((argv, index) => {
      expect(argv[argv.indexOf("--flow") + 1]).toContain(
        "flows/pass-mobile.yml",
      );
      expect(argv[argv.indexOf("--out") + 1]).toContain(`/${passes[index]}`);
    });
  });

  // The driver survives a pass on the same device, so only the session's first pass
  // pays for the install the pinned CLI defaults to.
  it("reinstalls maestro's driver on the first pass only", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    const flows = execs(f, "maestro.py");
    expect(flows).toHaveLength(3);
    expect(flows[0]).not.toContain("--no-reinstall-driver");
    for (const argv of flows.slice(1))
      expect(argv).toContain("--no-reinstall-driver");
  });

  it("runs the TV pass as the tv parent flow on android-tv", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    // selectDevice asks for leanback on android-tv; the phone answer would reject it.
    f.routes = f.routes.filter(([needle]) => needle !== "has-feature");
    f.routes.push(["has-feature", { code: 0, stdout: "true\n", stderr: "" }]);
    await runComparison(f, { ...runCli, platform: "android-tv" }, REPO);
    const flows = execs(f, "maestro.py");
    expect(flows).toHaveLength(3);
    for (const argv of flows)
      expect(argv[argv.indexOf("--flow") + 1]).toContain("flows/pass-tv.yml");
  });

  it("never logs the fixture password", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    expect(f.logs.join("\n")).not.toContain(PASSWORD);
    // but it does reach the flows as an env arg — the actual contract.
    expect(f.execLog.flat().join(" ")).toContain(
      `MAESTRO_JELLYFIN_PASS=${PASSWORD}`,
    );
  });
});

describe("runComparison failure path", () => {
  it("restores branch and native dirs and stops only its own Metro when a flow throws", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push(["pass-mobile.yml", { code: 1, stdout: "", stderr: "boom" }]);
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(ShotError);

    // Back on the starting branch, user's android/ dir restored with its file.
    expect(execs(f, "git switch feat/dev")).toHaveLength(1);
    expect(f.files.get(`${REPO}/android/user-file.txt`)).toBe("mine");
    // Every spawned Metro killed; nothing else was terminated.
    expect(f.spawns.length).toBeGreaterThan(0);
    expect(f.spawns.every((s) => s.killed)).toBe(true);
  });

  it("writes ANR and window dumps into the failed Android pass's report dir, then rethrows the flow error", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const outDir = `${REPO}/e2e/reports/shots/test-android`;
    f.routes.push(
      ["pass-mobile.yml", { code: 1, stdout: "", stderr: "boom" }],
      [
        "dumpsys activity lastanr-traces",
        { code: 0, stdout: "traces for nexuslauncher\n", stderr: "" },
      ],
      [
        "dumpsys activity lastanr",
        { code: 0, stdout: "anr record\n", stderr: "" },
      ],
      ["dumpsys window", { code: 0, stdout: "window state\n", stderr: "" }],
    );
    const error = await runComparison(f, { ...runCli, outDir }, REPO).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ShotError);
    expect(error.message).toContain("boom");
    const report = f.files.get(`${outDir}/before/android-diagnostics.txt`);
    expect(report).toContain("dumpsys activity lastanr");
    expect(report).toContain("anr record");
    expect(report).toContain("dumpsys activity lastanr-traces");
    expect(report).toContain("traces for nexuslauncher");
    expect(report).toContain("dumpsys window");
    expect(report).toContain("window state");
  });

  it("still rethrows the flow error when the adb diagnostics themselves fail", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const outDir = `${REPO}/e2e/reports/shots/test-android`;
    f.routes.push(
      ["pass-mobile.yml", { code: 1, stdout: "", stderr: "boom" }],
      [
        "dumpsys",
        () => {
          throw new Error("adb gone");
        },
      ],
    );
    const error = await runComparison(f, { ...runCli, outDir }, REPO).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ShotError);
    expect(error.message).toContain("boom");
  });

  it("runs no adb diagnostics when an iOS pass fails", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const outDir = `${REPO}/e2e/reports/shots/test-ios`;
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
      ["status_bar", ok],
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
    const error = await runComparison(
      f,
      {
        ...runCli,
        platform: "ios",
        device: "UDID-PHONE",
        outDir,
      },
      REPO,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ShotError);
    expect(error.message).toContain("boom");
    expect(execs(f, "dumpsys")).toHaveLength(0);
    expect(f.files.has(`${outDir}/before/android-diagnostics.txt`)).toBe(false);
  });

  it("retries a pass once when maestro's driver becomes unreachable, keeping the failed attempt", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const outDir = `${REPO}/e2e/reports/shots/test-ios`;
    let captures = 0;
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
      ["status_bar", ok],
      ["simctl uninstall", ok],
      ["simctl install", ok],
      [
        "get_app_container",
        { code: 0, stdout: "/sim/container\n", stderr: "" },
      ],
      ["plutil", ok],
      ["simctl openurl", ok],
      [
        "pass-mobile.yml",
        (fake, argv) => {
          captures += 1;
          if (captures > 1) return ok;
          const out = argv[argv.indexOf("--out") + 1];
          fake.files.set(
            `${out}/maestro.log`,
            "maestro.DeviceUnreachableException: Device became unreachable during viewHierarchy",
          );
          return { code: 1, stdout: "", stderr: "driver lost" };
        },
      ],
    );
    await runComparison(
      f,
      { ...runCli, platform: "ios", device: "UDID-PHONE", outDir },
      REPO,
    );
    // Four passes: the failed before plus its retry, then noise and after. The retry
    // is already a later pass, so it skips the driver reinstall like the rest.
    const flows = execs(f, "pass-mobile.yml");
    expect(flows).toHaveLength(4);
    expect(flows[0]).not.toContain("--no-reinstall-driver");
    for (const argv of flows.slice(1))
      expect(argv).toContain("--no-reinstall-driver");
    expect(execs(f, "simctl uninstall")).toHaveLength(4);
    expect(execs(f, "simctl openurl")).toHaveLength(4);
    expect(f.logs.some((line) => line.includes("unreachable"))).toBe(true);
    expect(f.dirs.has(`${outDir}/before-failed-1`)).toBe(true);
    expect(f.files.get(`${outDir}/before-failed-1/maestro.log`)).toContain(
      "DeviceUnreachableException",
    );
  });

  it("writes report/summary.md naming the pass and the failed step, with its artifacts copied into report/failure", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const outDir = `${REPO}/e2e/reports/shots/test-android`;
    f.routes.push(
      [
        "pass-mobile.yml",
        (fake, argv) => {
          const out = argv[argv.indexOf("--out") + 1];
          const dir = `${out}/pass-mobile`;
          fake.dirs.add(dir);
          fake.dirs.add(`${dir}/screenshots`);
          fake.dirs.add(`${dir}/screen-hierarchy`);
          fake.files.set(
            `${dir}/commands.json`,
            JSON.stringify([
              {
                command: {
                  runFlowCommand: {
                    sourceDescription: "mobile.yml",
                    commands: [],
                  },
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
                  error: {
                    message:
                      "Element not found: Text matching regex: .*Settings.*",
                  },
                },
                artifacts: [
                  {
                    type: "SCREENSHOT",
                    path: "screenshots/step-098-tapOnElement-Settings.png",
                  },
                  {
                    type: "SCREEN_HIERARCHY",
                    path: "screen-hierarchy/step-098-tapOnElement-Settings.json",
                  },
                ],
              },
            ]),
          );
          fake.files.set(
            `${dir}/screenshots/step-098-tapOnElement-Settings.png`,
            "png-bytes",
          );
          fake.files.set(
            `${dir}/screen-hierarchy/step-098-tapOnElement-Settings.json`,
            "{}",
          );
          return { code: 1, stdout: "", stderr: "boom" };
        },
      ],
      ["dumpsys", { code: 0, stdout: "dump\n", stderr: "" }],
    );
    const error = await runComparison(f, { ...runCli, outDir }, REPO).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ShotError);
    expect(error.message).toContain(
      "flow pass-mobile failed at mobile.yml > _tap-more.yml: tapOnElement",
    );
    const summary = f.files.get(`${outDir}/report/summary.md`);
    expect(summary).toContain("## Screenshot run failed (android)");
    expect(summary).toContain("**Pass:** before");
    expect(summary).toContain("mobile.yml > _tap-more.yml");
    expect(summary).toContain("tapOnElement");
    expect(summary).toContain(
      "Element not found: Text matching regex: .*Settings.*",
    );
    expect(summary).toContain(
      "report/failure/step-098-tapOnElement-Settings.png",
    );
    expect(summary).toContain(
      "report/failure/step-098-tapOnElement-Settings.json",
    );
    expect(
      f.files.get(
        `${outDir}/report/failure/step-098-tapOnElement-Settings.png`,
      ),
    ).toBe("png-bytes");
    expect(
      f.files.get(
        `${outDir}/report/failure/step-098-tapOnElement-Settings.json`,
      ),
    ).toBe("{}");
  });

  it("writes report/summary.md without a pass label or step when the run dies outside a pass", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const outDir = `${REPO}/e2e/reports/shots/test-android`;
    f.routes.push([
      "git switch --detach sha-before",
      { code: 1, stdout: "", stderr: "refused" },
    ]);
    const error = await runComparison(f, { ...runCli, outDir }, REPO).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ShotError);
    const summary = f.files.get(`${outDir}/report/summary.md`)!;
    expect(summary).toContain("## Screenshot run failed (android)");
    expect(summary).not.toContain("**Pass:**");
    expect(summary).not.toContain("**Failed step:**");
  });

  it("does not retry a pass whose failure is not a lost driver", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const outDir = `${REPO}/e2e/reports/shots/test-android`;
    f.routes.push(
      [
        "pass-mobile.yml",
        (fake, argv) => {
          const out = argv[argv.indexOf("--out") + 1];
          fake.files.set(`${out}/maestro.log`, "flow failed: no such element");
          return { code: 1, stdout: "", stderr: "boom" };
        },
      ],
      ["dumpsys", { code: 0, stdout: "dump\n", stderr: "" }],
    );
    const error = await runComparison(f, { ...runCli, outDir }, REPO).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ShotError);
    expect(error.message).toContain("boom");
    expect(execs(f, "pass-mobile.yml")).toHaveLength(1);
    expect(f.dirs.has(`${outDir}/before-failed-1`)).toBe(false);
    expect(f.files.has(`${outDir}/before/android-diagnostics.txt`)).toBe(true);
  });

  it("writes no report/summary.md on success — compare.ts owns it", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const outDir = `${REPO}/e2e/reports/shots/test-android`;
    await runComparison(f, { ...runCli, outDir }, REPO);
    expect(f.files.has(`${outDir}/report/summary.md`)).toBe(false);
  });

  it("rethrows after the retry when the driver is lost again", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    const outDir = `${REPO}/e2e/reports/shots/test-android`;
    f.routes.push(
      [
        "pass-mobile.yml",
        (fake, argv) => {
          const out = argv[argv.indexOf("--out") + 1];
          fake.files.set(
            `${out}/maestro.log`,
            "maestro.DeviceUnreachableException: Device became unreachable during viewHierarchy",
          );
          return { code: 1, stdout: "", stderr: "driver lost" };
        },
      ],
      ["dumpsys", { code: 0, stdout: "dump\n", stderr: "" }],
    );
    const error = await runComparison(f, { ...runCli, outDir }, REPO).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ShotError);
    expect(error.message).toContain("driver lost");
    expect(execs(f, "pass-mobile.yml")).toHaveLength(2);
    expect(f.dirs.has(`${outDir}/before-failed-1`)).toBe(true);
    expect(f.files.has(`${outDir}/before/android-diagnostics.txt`)).toBe(true);
  });
});

describe("runComparison boundaries", () => {
  it("reads the fixture credentials before the first git switch, never after", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    let switched = false;
    const exec = f.exec.bind(f);
    f.exec = (argv: string[]) => {
      if (argv.join(" ").includes("git switch")) switched = true;
      return exec(argv);
    };
    const read = f.fs.read;
    f.fs.read = (path: string) => {
      if (path.includes("credentials.json") || path.endsWith("/.env"))
        expect(switched).toBe(false);
      return read(path);
    };
    await runComparison(f, runCli, REPO);
  });

  it("refuses an --out that is not gitignored, before any git switch", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    // Longest-needle routing: outrank the happy "git check-ignore" route.
    f.routes.push([
      "check-ignore -q shots-out",
      { code: 1, stdout: "", stderr: "" },
    ]);
    await expect(
      runComparison(f, { ...runCli, outDir: `${REPO}/shots-out` }, REPO),
    ).rejects.toThrow(/gitignored/);
    expect(execs(f, "git switch")).toHaveLength(0);
  });

  it("masks the fixture password in a thrown flow error", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "pass-mobile.yml",
      { code: 1, stdout: "", stderr: `flow failed: ${PASSWORD} rejected` },
    ]);
    const error = await runComparison(f, runCli, REPO).catch((e) => e);
    expect(error).toBeInstanceOf(ShotError);
    expect(error.message).toContain("***");
    expect(error.message).not.toContain(PASSWORD);
  });

  it("includes the masked tail of stdout when a flow fails with empty stderr", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "pass-mobile.yml",
      {
        code: 1,
        stdout: `${"prefix-".repeat(120)}\nElement not found: Done (${PASSWORD})`,
        stderr: "",
      },
    ]);
    const error = await runComparison(f, runCli, REPO).catch((e) => e);
    expect(error).toBeInstanceOf(ShotError);
    expect(error.message).toContain("Element not found: Done (***)");
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message.length).toBeLessThan(700);
  });

  it("includes both stderr and stdout tail when both are present, both masked", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "pass-mobile.yml",
      {
        code: 1,
        stdout: `${"line\n".repeat(150)}stdout tail ${PASSWORD}`,
        stderr: `stderr head ${PASSWORD}\n${"warning\n".repeat(120)}stderr tail ${PASSWORD}`,
      },
    ]);
    const error = await runComparison(f, runCli, REPO).catch((e) => e);
    expect(error).toBeInstanceOf(ShotError);
    expect(error.message).toContain("stderr tail ***");
    expect(error.message).not.toContain("stderr head");
    expect(error.message).toContain("stdout tail ***");
    expect(error.message).not.toContain(PASSWORD);
  });

  it("launches Android through an explicit -p package and warms the exact dev-client JS bundle first", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);

    const amStarts = execs(f, "am start");
    // One deep link per capture pass (before, noise, after), each on fresh state.
    expect(amStarts).toHaveLength(3);
    for (const argv of amStarts) {
      const joined = argv.join(" ");
      expect(joined).toContain("-p com.example.streamyfin.debug");
      expect(joined).not.toMatch(/VIEW -d \S+ com\.example/);
    }
    const expectedWarmUrl = metroBundleUrl("android", DEFAULT_PORT);
    expect(expectedWarmUrl).toBe(
      `http://127.0.0.1:${DEFAULT_PORT}/index.ts.bundle?platform=android&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&unstable_transformProfile=hermes-stable`,
    );
    const bundleWaits = f.waits.filter((w) => w.url === expectedWarmUrl);
    expect(bundleWaits).toHaveLength(2);
    for (const wait of bundleWaits)
      expect(wait.needle).toBe("__BUNDLE_START_TIME__");
  });

  it("warms the exact iOS dev-client bundle URL for both ios and apple-tv and leaves Apple cache keys unchanged", async () => {
    for (const [platform, device, sdk] of [
      ["ios", "UDID-PHONE", "iphonesimulator"],
      ["apple-tv", "UDID-TV", "appletvsimulator"],
    ] as const) {
      const f = new Fake();
      seed(f);
      happyRoutes(f);
      const outDir = `${REPO}/e2e/reports/shots/test-${platform}`;
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
            const derived = argv[argv.indexOf("-derivedDataPath") + 1];
            fake.dirs.add(`${derived}/Build/Products/Debug-${sdk}`);
            fake.dirs.add(
              `${derived}/Build/Products/Debug-${sdk}/Streamyfin.app`,
            );
            return ok;
          },
        ],
        [
          "PlistBuddy",
          { code: 0, stdout: "com.example.streamyfin\n", stderr: "" },
        ],
        ["status_bar", ok],
        ["simctl uninstall", ok],
        ["simctl install", ok],
        [
          "get_app_container",
          { code: 0, stdout: "/sim/container\n", stderr: "" },
        ],
        ["plutil", ok],
        ["simctl openurl", ok],
      );

      await runComparison(f, { ...runCli, platform, device, outDir }, REPO);

      // Without EXPO_TV=1, `react-native.config.js` autolinks iOS-only pods into a
      // tvOS build, and the app crashes at launch on their missing Fabric classes.
      const podInstalls = f.execLog
        .map((argv, i) => ({ argv, opts: f.execOpts[i] }))
        .filter(({ argv }) => argv.join(" ") === "pod install");
      expect(podInstalls.length).toBeGreaterThan(0);
      for (const { opts } of podInstalls)
        expect(opts?.env?.EXPO_TV).toBe(platform === "apple-tv" ? "1" : "0");

      const expectedWarmUrl = metroBundleUrl("ios", DEFAULT_PORT);
      expect(expectedWarmUrl).toBe(
        `http://127.0.0.1:${DEFAULT_PORT}/index.ts.bundle?platform=ios&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&unstable_transformProfile=hermes-stable`,
      );
      expect(f.waits.filter((w) => w.url === expectedWarmUrl)).toHaveLength(2);
      expect(execs(f, "ro.product.cpu.abilist")).toHaveLength(0);
      const manifest = JSON.parse(f.files.get(`${outDir}/build-cache.json`)!);
      expect(manifest[0].hash).toBe(`fp-1-${DEV_CLIENT_RECIPE}`);
      expect(manifest[0].path).toBe(
        `${REPO}/e2e/reports/shots/build-cache/${platform}/fp-1-${DEV_CLIENT_RECIPE}/Streamyfin.app`,
      );
    }
  });

  it("restores native dirs even when the git restore itself is refused", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    // The run completes, then switching back to the starting branch is refused
    // (user edits appeared) — native dirs must still come back, and whatever the
    // runner generated is moved aside, not deleted.
    f.routes.push([
      "git switch feat/dev",
      { code: 1, stdout: "", stderr: "local changes" },
    ]);
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(
      /could not switch back/,
    );
    expect(f.files.get(`${REPO}/android/user-file.txt`)).toBe("mine");
  });
});

describe("runComparison build-cache manifest", () => {
  const outDir = `${REPO}/e2e/reports/shots/test-session`;

  it("records built then local with <fingerprint>-<abi> when before and after share a fingerprint on Android", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes = f.routes.filter(
      ([needle]) =>
        needle !== "has-feature" && needle !== "ro.product.cpu.abilist",
    );
    f.routes.push(
      ["has-feature", { code: 0, stdout: "true\n", stderr: "" }],
      [
        "ro.product.cpu.abilist",
        { code: 0, stdout: "x86,armeabi-v7a\n", stderr: "" },
      ],
    );
    await runComparison(f, { ...runCli, platform: "android-tv", outDir }, REPO);
    expect(execs(f, "ro.product.cpu.abilist")).toHaveLength(1);
    expect(execs(f, "assembleDebug")[0]).toContain(
      "-PreactNativeArchitectures=x86",
    );
    const manifest = JSON.parse(f.files.get(`${outDir}/build-cache.json`)!);
    expect(manifest).toEqual([
      {
        ref: "before",
        platform: "android-tv",
        hash: `fp-1-${DEV_CLIENT_RECIPE}-x86`,
        source: "built",
        path: `${REPO}/e2e/reports/shots/build-cache/android-tv/fp-1-${DEV_CLIENT_RECIPE}-x86/app-debug.apk`,
      },
      {
        ref: "after",
        platform: "android-tv",
        hash: `fp-1-${DEV_CLIENT_RECIPE}-x86`,
        source: "local",
        path: `${REPO}/e2e/reports/shots/build-cache/android-tv/fp-1-${DEV_CLIENT_RECIPE}-x86/app-debug.apk`,
      },
    ]);
  });

  it("skips prebuild and records fetched with <fingerprint>-<abi> when the fetch hook populates the cache", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.env.SHOTS_BUILD_CACHE_FETCH = "/ci/fetch-dev-client.py";
    f.routes.push([
      "/ci/fetch-dev-client.py",
      (fake, argv) => {
        expect(argv[2]).toBe(`fp-1-${DEV_CLIENT_RECIPE}-arm64-v8a`);
        const cacheDir = argv[3];
        fake.dirs.add(cacheDir);
        fake.files.set(`${cacheDir}/app-debug.apk`, "apk");
        return ok;
      },
    ]);

    await runComparison(f, { ...runCli, outDir }, REPO);
    expect(execs(f, "bun run prebuild")).toHaveLength(0);
    expect(execs(f, "assembleDebug")).toHaveLength(0);
    expect(execs(f, "fetch-dev-client.py")).toHaveLength(1);
    const manifest = JSON.parse(f.files.get(`${outDir}/build-cache.json`)!);
    expect(manifest).toEqual([
      {
        ref: "before",
        platform: "android",
        hash: `fp-1-${DEV_CLIENT_RECIPE}-arm64-v8a`,
        source: "fetched",
        path: `${REPO}/e2e/reports/shots/build-cache/android/fp-1-${DEV_CLIENT_RECIPE}-arm64-v8a/app-debug.apk`,
      },
      {
        ref: "after",
        platform: "android",
        hash: `fp-1-${DEV_CLIENT_RECIPE}-arm64-v8a`,
        source: "local",
        path: `${REPO}/e2e/reports/shots/build-cache/android/fp-1-${DEV_CLIENT_RECIPE}-arm64-v8a/app-debug.apk`,
      },
    ]);
  });

  it("falls back to prebuild and build when the fetch hook fails", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.env.SHOTS_BUILD_CACHE_FETCH = "/ci/fetch-dev-client.py";
    f.routes.push([
      "/ci/fetch-dev-client.py",
      { code: 1, stdout: "", stderr: "no artifact\n" },
    ]);

    await runComparison(f, { ...runCli, outDir }, REPO);
    expect(execs(f, "bun run prebuild")).toHaveLength(1);
    expect(execs(f, "assembleDebug")).toHaveLength(1);
    const manifest = JSON.parse(f.files.get(`${outDir}/build-cache.json`)!);
    expect(manifest[0].source).toBe("built");
    expect(manifest[1].source).toBe("local");
  });
});

describe("runComparison progress", () => {
  it("logs one line at each phase boundary with short fingerprint, build source, and elapsed time", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "@expo/fingerprint fingerprint:generate",
      {
        code: 0,
        stdout: JSON.stringify({
          hash: "abcdef0123456789deadbeef",
          sources: [{ id: "expoConfig" }],
        }),
        stderr: "",
      },
    ]);

    await runComparison(f, runCli, REPO);

    expect(f.logs).toEqual([
      "building before (android, fingerprint abcdef01)",
      expect.stringMatching(
        /^building before \(android, fingerprint abcdef01\): built \(\d+(?:m\d+)?s\)$/,
      ),
      "installing",
      "starting Metro",
      expect.stringMatching(/^Metro up in \d+(?:m\d+)?s$/),
      expect.stringMatching(/^Metro bundled android JS in \d+(?:m\d+)?s$/),
      "capturing before",
      "capturing noise",
      "building after (android, fingerprint abcdef01)",
      expect.stringMatching(
        /^building after \(android, fingerprint abcdef01\): local \(\d+(?:m\d+)?s\)$/,
      ),
      "installing",
      "starting Metro",
      expect.stringMatching(/^Metro up in \d+(?:m\d+)?s$/),
      expect.stringMatching(/^Metro bundled android JS in \d+(?:m\d+)?s$/),
      "capturing after",
      "comparing",
    ]);
  });

  it("reports fetched as the build source when the remote build cache hits", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.env.SHOTS_BUILD_CACHE_FETCH = "/ci/fetch-dev-client.py";
    f.routes.push([
      "/ci/fetch-dev-client.py",
      (fake, argv) => {
        const cacheDir = argv[3];
        fake.dirs.add(cacheDir);
        fake.files.set(`${cacheDir}/app-debug.apk`, "apk");
        return ok;
      },
    ]);

    await runComparison(f, runCli, REPO);

    expect(
      f.logs.some((line) =>
        /^building before \(android, fingerprint fp-1\): fetched \(\d+(?:m\d+)?s\)$/.test(
          line,
        ),
      ),
    ).toBe(true);
  });
});
