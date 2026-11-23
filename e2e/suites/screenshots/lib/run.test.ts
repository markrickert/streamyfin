import { type Cli, ShotError } from "./core";
import { doctor, runComparison } from "./run";
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
  seed,
} from "./testing";
import { MAESTRO_SHA256, MAESTRO_TAG } from "./tooling";

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

    // One owned Metro per ref, both stopped.
    expect(f.spawns).toHaveLength(2);
    expect(f.spawns.every((s) => s.killed)).toBe(true);

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

  it("launches Android through an explicit -p package and warms the JS bundle first", async () => {
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
    const bundleWaits = f.waits.filter((w) =>
      w.url.includes("index.bundle?platform=android"),
    );
    expect(bundleWaits.length).toBeGreaterThanOrEqual(2);
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
