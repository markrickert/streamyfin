/**
 * Shared doubles for the lib/ specs. The child-process / fs boundary is a stateful
 * fake: routes answer exec calls and mutate a virtual filesystem, so the assertions read
 * like a trace of what the runner would have done to the machine.
 */
import { type Cli, type Deps, type ExecResult, type SpawnHandle } from "./core";
import { MAESTRO_TAG } from "./tooling";

export const REPO = "/repo";
export const MAESTRO_TOOLS = `${REPO}/e2e/reports/shots/tools`;
export const MAESTRO_BIN = `${MAESTRO_TOOLS}/${MAESTRO_TAG}/maestro/bin/maestro`;
export const PASSWORD = "topsecret-fixture";

export class FakeSpawn implements SpawnHandle {
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

export class Fake implements Deps {
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

  execOpts: (Parameters<Deps["exec"]>[1] | undefined)[] = [];

  exec(argv: string[], opts?: Parameters<Deps["exec"]>[1]): ExecResult {
    this.execLog.push(argv);
    this.execOpts.push(opts);
    return this.result(argv);
  }

  spawnOpts: (Parameters<Deps["spawn"]>[1] | undefined)[] = [];

  spawn(argv: string[], opts?: Parameters<Deps["spawn"]>[1]): SpawnHandle {
    const handle = new FakeSpawn(argv);
    this.spawns.push(handle);
    this.spawnOpts.push(opts);
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

export const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

export function seed(f: Fake) {
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
    // The parents the runner invokes; the nested names stay listed so the snapshot's
    // flow dir mirrors the real one. A route needle of a nested name must never shadow
    // a parent: "mobile.yml" alone would also match ".../pass-mobile.yml".
    "pass-mobile.yml",
    "pass-tv.yml",
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

export function happyRoutes(f: Fake, { dirty = "" }: { dirty?: string } = {}) {
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
    ["settings get", { code: 0, stdout: "null\n", stderr: "" }],
    ["settings delete", ok],
    [
      "defaults read com.apple.Accessibility ReduceMotionEnabled",
      { code: 1, stdout: "", stderr: "not found" },
    ],
    ["defaults write com.apple.Accessibility ReduceMotionEnabled", ok],
    ["defaults delete com.apple.Accessibility ReduceMotionEnabled", ok],
    ["com.android.systemui.demo", ok],
    ["run-as", ok],
    // The phone emulator reports no leanback — pm exits 1 for "absent", which is the
    // real answer, not a failure.
    ["has-feature", { code: 1, stdout: "false\n", stderr: "" }],
    [
      "ro.product.cpu.abilist",
      { code: 0, stdout: "arm64-v8a,armeabi-v7a,armeabi\n", stderr: "" },
    ],
    ["reverse --list", { code: 0, stdout: "", stderr: "" }],
    ["reverse tcp:", ok],
    ["am start", ok],
    ["maestro.py", ok],
    ["compare.ts", ok],
    ["bun install --frozen-lockfile", ok],
    ["bun run prebuild", ok],
  );
}

export const runCli: Cli = {
  command: "run",
  platform: "android",
  before: "main",
  after: "feat/x",
  device: "emulator-5554",
};

export const execs = (f: Fake, needle: string) =>
  f.execLog.filter((argv) => argv.join(" ").includes(needle));

export const SIMCTL_JSON = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
      { udid: "UDID-PHONE", name: "iPhone 17 Pro" },
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-26-4": [
      { udid: "UDID-TV", name: "Apple TV 4K" },
    ],
  },
};

export function simctlFake(devices: unknown = SIMCTL_JSON.devices) {
  const f = new Fake();
  f.routes.push([
    "simctl",
    { code: 0, stdout: JSON.stringify({ devices }), stderr: "" },
  ]);
  return f;
}
