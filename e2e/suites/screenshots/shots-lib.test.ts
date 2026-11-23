/**
 * shots-lib orchestration tests. The child-process / fs boundary is a stateful fake:
 * routes answer exec calls and mutate a virtual filesystem, so the assertions read like
 * a trace of what the runner would have done to the machine.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Cli,
  type Deps,
  doctor,
  type ExecResult,
  ensureDebugBuild,
  ensurePortFree,
  MAESTRO_SHA256,
  MAESTRO_TAG,
  parseArgs,
  platformSpec,
  prepareDevice,
  runComparison,
  ShotError,
  type SpawnHandle,
  selectDevice,
} from "./shots-lib";

// js-yaml ships no types; keep the require (typed) rather than adding @types/js-yaml
// for one test block.
const { loadAll: loadAllYaml } = require("js-yaml") as {
  loadAll: (src: string) => unknown[];
};

const REPO = "/repo";
const MAESTRO_TOOLS = `${REPO}/e2e/reports/shots/tools`;
const MAESTRO_BIN = `${MAESTRO_TOOLS}/${MAESTRO_TAG}/maestro/bin/maestro`;
const PASSWORD = "topsecret-fixture";

class FakeSpawn implements SpawnHandle {
  killed = false;
  alive = true;
  constructor(public argv: string[]) {}
  kill() {
    this.killed = true;
    this.alive = false;
  }
  isAlive() {
    return this.alive;
  }
}

class Fake implements Deps {
  execLog: string[][] = [];
  spawns: FakeSpawn[] = [];
  logs: string[] = [];
  env: Deps["env"] = {};
  files = new Map<string, string>();
  dirs = new Set<string>();
  /** Routes: matcher substring in argv.join(" ") → result or handler. */
  routes: [string, ExecResult | ((f: Fake, argv: string[]) => ExecResult)][] =
    [];

  private result(argv: string[]): ExecResult {
    const joined = argv.join(" ");
    // The longest matching needle wins, so a specific flow name outranks a broad
    // "maestro.py" route.
    const route = [...this.routes]
      .filter(([match]) => joined.includes(match))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (!route) throw new Error(`unstubbed exec: ${joined}`);
    const outcome = route[1];
    return typeof outcome === "function" ? outcome(this, argv) : outcome;
  }

  exec(argv: string[]): ExecResult {
    this.execLog.push(argv);
    return this.result(argv);
  }

  spawn(argv: string[]): SpawnHandle {
    const handle = new FakeSpawn(argv);
    this.spawns.push(handle);
    return handle;
  }

  waits: { url: string; needle: string }[] = [];
  async waitFor(url: string, needle: string) {
    this.waits.push({ url, needle });
    return true;
  }

  fs = {
    exists: (p: string) => this.dirs.has(p) || this.files.has(p),
    read: (p: string) => {
      const data = this.files.get(p);
      if (data === undefined) throw new Error(`read of missing ${p}`);
      return data;
    },
    write: (p: string, data: string) => void this.files.set(p, data),
    mkdir: (p: string) => void this.dirs.add(p),
    cp: (src: string, dst: string) =>
      void this.files.set(dst, this.files.get(src) ?? "x"),
    mv: (src: string, dst: string) => {
      this.files.delete(src);
      this.dirs.delete(src);
      for (const [p, v] of [...this.files]) {
        if (p.startsWith(`${src}/`)) {
          this.files.set(p.replace(src, dst), v);
          this.files.delete(p);
        }
      }
      this.files.set(dst, "dir");
      this.dirs.add(dst);
    },
    rm: (p: string) => {
      this.files.delete(p);
      this.dirs.delete(p);
      for (const key of [...this.files.keys()])
        if (key.startsWith(`${p}/`)) this.files.delete(key);
      for (const key of [...this.dirs])
        if (key.startsWith(`${p}/`)) this.dirs.delete(key);
    },
    list: (p: string) => {
      const names: string[] = [];
      const prefix = `${p}/`;
      for (const key of [...this.files.keys(), ...this.dirs]) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          names.push(key.slice(prefix.length));
      }
      return names;
    },
  };

  log = (message: string) => void this.logs.push(message);
}

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

function seed(f: Fake) {
  const suite = `${REPO}/e2e/suites/screenshots`;
  f.dirs.add(suite);
  f.dirs.add(`${suite}/flows`);
  f.dirs.add(`${REPO}/e2e/bench`);
  f.dirs.add(`${REPO}/e2e/suites/syncplay`);
  for (const name of [
    "shots.ts",
    "shots-lib.ts",
    "compare.ts",
    "run.sh",
    "ios-disable-autofill.sh",
    "masks-android-phone.json",
  ])
    f.files.set(`${suite}/${name}`, "x");
  for (const flow of [
    "bootstrap-login-mobile.yml",
    "mobile.yml",
    "ensure-seerr-mobile.yml",
    "bootstrap-seerr-mobile.yml",
    "seerr-mobile.yml",
  ])
    f.files.set(`${suite}/flows/${flow}`, "x");
  f.files.set(`${REPO}/e2e/bench/maestro.py`, "x");
  f.files.set(MAESTRO_BIN, "bin");
  f.files.set(`${REPO}/bun.lock`, "lock-v1");
  f.files.set(`${REPO}/package.json`, "pkg-v1");
  f.files.set(
    `${REPO}/e2e/suites/syncplay/.env`,
    "SYNCPLAY_PORT=18096\nSYNCPLAY_SEERR_PORT=15055\n",
  );
  f.files.set(
    `${REPO}/e2e/suites/syncplay/.state/credentials.json`,
    JSON.stringify({
      password: PASSWORD,
      host: { name: "syncplay-host", token: "tok" },
    }),
  );
  // The user's preexisting native dir: the runner must preserve it.
  f.dirs.add(`${REPO}/android`);
  f.files.set(`${REPO}/android/user-file.txt`, "mine");
  // An Android SDK with one build-tools aapt, used to read the APK's applicationId.
  f.env.ANDROID_HOME = `${REPO}/sdk`;
  f.dirs.add(`${REPO}/sdk/build-tools`);
  f.dirs.add(`${REPO}/sdk/build-tools/36.0.0`);
  f.files.set(`${REPO}/sdk/build-tools/36.0.0/aapt`, "x");
}

function happyRoutes(f: Fake, { dirty = "" }: { dirty?: string } = {}) {
  f.routes.push(
    ["status --porcelain", { code: 0, stdout: dirty, stderr: "" }],
    [
      "rev-parse --verify main^{commit}",
      { code: 0, stdout: "sha-before\n", stderr: "" },
    ],
    [
      "rev-parse --verify feat/x^{commit}",
      { code: 0, stdout: "sha-after\n", stderr: "" },
    ],
    ["symbolic-ref", { code: 0, stdout: "feat/dev\n", stderr: "" }],
    [
      "adb devices",
      {
        code: 0,
        stdout: "List of devices attached\nemulator-5554\tdevice\n",
        stderr: "",
      },
    ],
    ["lsof", { code: 1, stdout: "", stderr: "" }],
    ["git check-ignore", { code: 0, stdout: "", stderr: "" }],
    ["bun run e2e:setup", ok],
    ["bun run e2e:seed", ok],
    ["bun run e2e:enrich", ok],
    ["suites.syncplay import seerr", ok],
    ["git switch", ok],
    [
      "fingerprint:generate",
      {
        code: 0,
        stdout: JSON.stringify({
          hash: "fp-1",
          sources: [{ id: "expoConfig" }],
        }),
        stderr: "",
      },
    ],
    [
      "assembleDebug",
      (fake) => {
        fake.files.set(
          `${REPO}/android/app/build/outputs/apk/debug/app-debug.apk`,
          "apk",
        );
        return ok;
      },
    ],
    // aapt answers the exact applicationId even when a production install shares the
    // "streamyfin" substring — pm list is deliberately not stubbed, so a regression to
    // substring matching fails as an unstubbed exec.
    [
      "aapt",
      {
        code: 0,
        stdout:
          "package: name='com.example.streamyfin.debug' versionCode='1' versionName='1'\n",
        stderr: "",
      },
    ],
    ["node --version", { code: 0, stdout: "v22.14.0\n", stderr: "" }],
    ["install -r", ok],
    ["pm clear", ok],
    ["push /tmp/streamyfin-shots-fast-refresh-off.xml", ok],
    ["push /tmp/streamyfin-shots-dev-menu-fab-off.xml", ok],
    ["settings put", ok],
    ["com.android.systemui.demo", ok],
    ["run-as", ok],
    // The phone emulator reports no leanback — pm exits 1 for "absent", which is the
    // real answer, not a failure.
    ["has-feature", { code: 1, stdout: "false\n", stderr: "" }],
    ["reverse --list", { code: 0, stdout: "", stderr: "" }],
    ["reverse tcp:", ok],
    ["am start", ok],
    ["maestro.py", ok],
    ["compare.ts", ok],
    ["bun install --frozen-lockfile", ok],
    ["bun run prebuild", ok],
  );
}

const runCli: Cli = {
  command: "run",
  platform: "android",
  before: "main",
  after: "feat/x",
  device: "emulator-5554",
};

const execs = (f: Fake, needle: string) =>
  f.execLog.filter((argv) => argv.join(" ").includes(needle));

describe("parseArgs", () => {
  it("rejects a run without a platform", () => {
    expect(() => parseArgs(["run", "--before", "a"])).toThrow(ShotError);
  });
  it("leaves --before to resolveBaseRef and defaults --after to HEAD", () => {
    expect(parseArgs(["run", "--platform", "android"])).toMatchObject({
      before: undefined,
      after: "HEAD",
    });
  });
  it("accepts --fix as a valueless doctor flag", () => {
    expect(
      parseArgs(["doctor", "--fix", "--platform", "apple-tv"]),
    ).toMatchObject({ command: "doctor", fix: true, platform: "apple-tv" });
  });
  it("rejects --fix on run", () => {
    expect(() => parseArgs(["run", "--platform", "android", "--fix"])).toThrow(
      ShotError,
    );
  });
  it("accepts the documented run shape", () => {
    const cli = parseArgs([
      "run",
      "--platform",
      "apple-tv",
      "--before",
      "a",
      "--after",
      "b",
    ]);
    expect(cli).toMatchObject({
      command: "run",
      platform: "apple-tv",
      before: "a",
      after: "b",
    });
  });
});

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

describe("platformSpec", () => {
  it("maps apple-tv to the tvOS driver and ios fingerprint", () => {
    expect(platformSpec("apple-tv")).toMatchObject({
      tv: true,
      fingerprintPlatform: "ios",
      maestroPlatform: "tvos",
      masks: "masks-ios-tv.json",
    });
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
    f.routes.push([
      "seerr-mobile.yml",
      { code: 1, stdout: "", stderr: "boom" },
    ]);
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

describe("runComparison failure path", () => {
  it("restores branch and native dirs and stops only its own Metro when a flow throws", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "seerr-mobile.yml",
      { code: 1, stdout: "", stderr: "boom" },
    ]);
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(ShotError);

    // Back on the starting branch, user's android/ dir restored with its file.
    expect(execs(f, "git switch feat/dev")).toHaveLength(1);
    expect(f.files.get(`${REPO}/android/user-file.txt`)).toBe("mine");
    // Every spawned Metro killed; nothing else was terminated.
    expect(f.spawns.length).toBeGreaterThan(0);
    expect(f.spawns.every((s) => s.killed)).toBe(true);
  });
});

describe("ensureDebugBuild cache", () => {
  const spec = platformSpec("android");
  it("rebuilds on a new fingerprint, reuses the cache on the same one", () => {
    const f = new Fake();
    f.routes.push([
      "node --version",
      { code: 0, stdout: "v22.14.0\n", stderr: "" },
    ]);
    let builds = 0;
    f.routes.push([
      "assembleDebug",
      (fake) => {
        builds++;
        fake.files.set(
          `${REPO}/android/app/build/outputs/apk/debug/app-debug.apk`,
          "apk",
        );
        return ok;
      },
    ]);
    const first = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-a",
      `${REPO}/session`,
    );
    expect(first.built).toBe(true);
    const again = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-a",
      `${REPO}/session`,
    );
    expect(again.built).toBe(false);
    expect(again.artifact).toBe(first.artifact);
    const other = ensureDebugBuild(
      f,
      REPO,
      "android",
      spec,
      "fp-b",
      `${REPO}/session`,
    );
    expect(other.built).toBe(true);
    expect(builds).toBe(2);
  });
});

const SIMCTL_JSON = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
      { udid: "UDID-PHONE", name: "iPhone 17 Pro" },
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-26-4": [
      { udid: "UDID-TV", name: "Apple TV 4K" },
    ],
  },
};

function simctlFake(devices: unknown = SIMCTL_JSON.devices) {
  const f = new Fake();
  f.routes.push([
    "simctl",
    { code: 0, stdout: JSON.stringify({ devices }), stderr: "" },
  ]);
  return f;
}

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
      "seerr-mobile.yml",
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

describe("fixtureEnv port contract", () => {
  it("refuses a missing SYNCPLAY_SEERR_PORT instead of producing :undefined", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.files.set(`${REPO}/e2e/suites/syncplay/.env`, "SYNCPLAY_PORT=18096\n");
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(
      /SYNCPLAY_SEERR_PORT/,
    );
    expect(execs(f, "git switch")).toHaveLength(0);
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

describe("existing Android install", () => {
  // A run that fails after installing leaves the app behind, and the next run used to
  // refuse to start until it was uninstalled by hand.
  it("installs over whatever is on the emulator, without checking for it", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    await runComparison(f, runCli, REPO);
    expect(execs(f, "pm path")).toHaveLength(0);
    expect(execs(f, "install -r")).toHaveLength(2);
    expect(execs(f, "pm clear")).toHaveLength(3);
  });

  it("uninstalls and installs again when the existing install has another signature", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "emulator-5554 install -r",
      (fake) =>
        fake.execLog.some((argv) => argv.join(" ").includes(" uninstall "))
          ? ok
          : {
              code: 1,
              stdout: "",
              stderr:
                "adb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]",
            },
    ]);
    f.routes.push(["uninstall com.example.streamyfin.debug", ok]);
    await runComparison(f, runCli, REPO);
    expect(execs(f, "uninstall com.example.streamyfin.debug")).toHaveLength(1);
    const trace = f.execLog.map((argv) => argv.join(" "));
    const removed = trace.findIndex((a) => a.includes(" uninstall "));
    expect(
      trace.findIndex((a, i) => i > removed && a.includes("install -r")),
    ).toBeGreaterThan(removed);
  });

  it("fails the run when the install fails for another reason", async () => {
    const f = new Fake();
    seed(f);
    happyRoutes(f);
    f.routes.push([
      "emulator-5554 install -r",
      {
        code: 1,
        stdout: "",
        stderr: "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]",
      },
    ]);
    await expect(runComparison(f, runCli, REPO)).rejects.toThrow(/adb install/);
    expect(execs(f, " uninstall ")).toHaveLength(0);
    expect(execs(f, "pm clear")).toHaveLength(0);
  });
});

describe("iOS install", () => {
  const iosCli: Cli = {
    command: "run",
    platform: "ios",
    before: "main",
    after: "feat/x",
    device: "UDID-PHONE",
  };

  function iosHappyRoutes(f: Fake) {
    happyRoutes(f);
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
          expect(argv[argv.indexOf("-workspace") + 1]).toBe(
            `${REPO}/ios/Streamyfin.xcworkspace`,
          );
          expect(argv[argv.indexOf("-scheme") + 1]).toBe("Streamyfin");
          const derived = argv[argv.indexOf("-derivedDataPath") + 1];
          fake.dirs.add(`${derived}/Build/Products/Debug-iphonesimulator`);
          fake.files.set(
            `${derived}/Build/Products/Debug-iphonesimulator/Streamyfin.app`,
            "app",
          );
          return ok;
        },
      ],
      [
        "PlistBuddy",
        { code: 0, stdout: "com.example.streamyfin\n", stderr: "" },
      ],
      ["status_bar", ok],
    );
  }

  it("installs over an app it finds on the simulator, without checking for one", async () => {
    const f = new Fake();
    seed(f);
    iosHappyRoutes(f);
    f.routes.push(
      ["simctl uninstall", ok],
      ["simctl install", ok],
      [
        "get_app_container",
        { code: 0, stdout: "/sim/container\n", stderr: "" },
      ],
      ["plutil", ok],
      ["simctl openurl", ok],
    );
    await runComparison(f, iosCli, REPO);
    expect(execs(f, "listapps")).toHaveLength(0);
    expect(execs(f, "simctl install").length).toBeGreaterThan(0);
  });

  it("overrides the status bar before the first install and clears it at the end", async () => {
    const f = new Fake();
    seed(f);
    iosHappyRoutes(f);
    f.routes.push(
      ["simctl uninstall", ok],
      ["simctl install", ok],
      [
        "get_app_container",
        { code: 0, stdout: "/sim/container\n", stderr: "" },
      ],
      ["plutil", ok],
      ["simctl openurl", ok],
    );
    await runComparison(f, iosCli, REPO);
    const trace = f.execLog.map((argv) => argv.join(" "));
    const override = trace.findIndex((a) =>
      a.startsWith("xcrun simctl status_bar UDID-PHONE override"),
    );
    expect(override).toBeGreaterThanOrEqual(0);
    expect(override).toBeLessThan(
      trace.findIndex((a) => a.includes("simctl install")),
    );
    const clear = trace.lastIndexOf("xcrun simctl status_bar UDID-PHONE clear");
    const lastFlow = trace.findLastIndex((a) => a.includes("maestro.py"));
    expect(lastFlow).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(lastFlow);
  });

  it("clears the status bar when a flow fails", async () => {
    const f = new Fake();
    seed(f);
    iosHappyRoutes(f);
    f.routes.push(
      ["simctl uninstall", ok],
      ["simctl install", ok],
      [
        "get_app_container",
        { code: 0, stdout: "/sim/container\n", stderr: "" },
      ],
      ["plutil", ok],
      ["simctl openurl", ok],
      ["seerr-mobile.yml", { code: 1, stdout: "", stderr: "boom" }],
    );
    await expect(runComparison(f, iosCli, REPO)).rejects.toThrow(ShotError);
    expect(execs(f, "status_bar UDID-PHONE clear")).toHaveLength(1);
  });

  it("turns Fast Refresh off in each fresh install before the deep link", async () => {
    const f = new Fake();
    seed(f);
    iosHappyRoutes(f);
    f.routes.push(
      ["simctl uninstall", ok],
      ["simctl install", ok],
      [
        "get_app_container",
        { code: 0, stdout: "/sim/container\n", stderr: "" },
      ],
      ["plutil -create", ok],
      ["plutil -insert", ok],
      ["simctl openurl", ok],
    );
    await runComparison(f, iosCli, REPO);

    const plist =
      "/sim/container/Library/Preferences/com.example.streamyfin.plist";
    const hot = execs(f, "RCTDevMenu.hotLoadingEnabled");
    expect(hot).toHaveLength(3);
    for (const argv of hot)
      expect(argv).toEqual([
        "plutil",
        "-insert",
        "RCTDevMenu.hotLoadingEnabled",
        "-bool",
        "NO",
        plist,
      ]);
    // The dev menu's floating button stays off across the flows' launchApp restarts,
    // which drop the deep link's one-process __expo_disable_fab.
    const fab = execs(f, "EXDevMenuShowFloatingActionButton");
    expect(fab).toHaveLength(3);
    for (const argv of fab)
      expect(argv).toEqual([
        "plutil",
        "-insert",
        "EXDevMenuShowFloatingActionButton",
        "-bool",
        "NO",
        plist,
      ]);
    // The default is written after the reinstall and before the app is first opened.
    const trace = f.execLog.map((argv) => argv.join(" "));
    const install = trace.findIndex((a) => a.includes("simctl install"));
    const write = trace.findIndex((a) => a.includes("hotLoadingEnabled"));
    const open = trace.findIndex((a) => a.includes("simctl openurl"));
    expect(install).toBeLessThan(write);
    expect(write).toBeLessThan(open);
  });
});

// The flows are data, not code: parse the real YAML so a future flow edit that drops
// the permission grant or reorders the overlay dismissal fails here, not on device.
describe("Seerr detail tap on refs with and without the poster testID", () => {
  type Command = Record<string, any>;
  const commandsOf = (file: string): Command[] =>
    loadAllYaml(
      readFileSync(join(__dirname, "flows", file), "utf8"),
    )[1] as Command[];
  const poster = { id: "seerr-poster-194310" };

  // The two branches are separate checks, run one after the other. With the testID
  // branch first, its tap opens the detail page, where the poster is gone, so the
  // fallback ran there too and failed to find the movies row.
  it.each(["seerr-mobile.yml", "seerr-tv.yml"])(
    "%s runs the title fallback before the testID branch, so only one of them taps",
    (file) => {
      const cmds = commandsOf(file);
      const fallback = cmds.findIndex(
        (cmd) => cmd.runFlow?.when?.notVisible?.id === poster.id,
      );
      const byTestId = cmds.findIndex(
        (cmd) => cmd.runFlow?.when?.visible?.id === poster.id,
      );
      expect(fallback).toBeGreaterThanOrEqual(0);
      expect(byTestId).toBeGreaterThanOrEqual(0);
      expect(fallback).toBeLessThan(byTestId);
    },
  );
});

describe("bootstrap-login first-run overlays", () => {
  type Command = Record<string, any>;
  const commandsOf = (file: string): Command[] =>
    loadAllYaml(
      readFileSync(join(__dirname, "flows", file), "utf8"),
    )[1] as Command[];

  // The picker step comes first: the link it opens raises the iOS "Open in" prompt,
  // which the next step accepts.
  it("reconnects from the server picker, accepts the open-in prompt, then dismisses the onboarding sheet and dev menu in order", () => {
    const cmds = commandsOf("_dismiss-dev-overlays.yml");
    expect(cmds).toHaveLength(4);
    expect(cmds[0].runFlow.when.visible).toBe("Fetch development servers");
    expect(cmds[0].runFlow.commands).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own placeholder, read verbatim from the YAML
      { openLink: "${MAESTRO_DEV_CLIENT_URL}" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[1].runFlow.when.visible).toBe("Open in .*");
    expect(cmds[1].runFlow.commands).toEqual([
      { tapOn: "Open" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[2].runFlow.when.visible).toBe("Continue");
    expect(cmds[2].runFlow.commands).toEqual([
      { tapOn: "Continue" },
      "waitForAnimationToEnd",
    ]);
    expect(cmds[3].runFlow.when.visible).toBe("Go home");
    expect(cmds[3].runFlow.commands).toEqual([
      { tapOn: "Close" },
      "waitForAnimationToEnd",
    ]);
  });

  it("bootstrap-login-mobile grants notifications and keeps dismissing overlays until the login field is reachable", () => {
    const cmds = commandsOf("bootstrap-login-mobile.yml");
    expect(cmds[0].launchApp).toEqual({
      stopApp: false,
      permissions: { notifications: "allow" },
    });
    expect(cmds[1].repeat.while).toEqual({
      notVisible: { id: "login-server-url" },
    });
    expect(cmds[1].repeat.commands[0].runFlow).toBe(
      "_dismiss-dev-overlays.yml",
    );
    expect(cmds[2].assertVisible).toEqual({ id: "login-server-url" });
  });

  it("bootstrap-login-tv grants notifications except on tvOS, then dismisses overlays", () => {
    const cmds = commandsOf("bootstrap-login-tv.yml");
    expect(cmds[0].runFlow.commands).toEqual([
      {
        launchApp: {
          stopApp: false,
          permissions: { notifications: "allow" },
        },
      },
    ]);
    expect(cmds[1].runFlow.commands).toEqual(["launchApp"]);
    expect(cmds[2].runFlow).toBe("_dismiss-dev-overlays.yml");
  });
});
