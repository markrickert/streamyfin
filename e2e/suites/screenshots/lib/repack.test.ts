import { repackOptions } from "../repack-runner";
import { platformSpec } from "./cli";
import { type ExecResult, ShotError } from "./core";
import {
  ensureRepackApp,
  REPACK_SENTINEL_DSN,
  repackAppVersion,
  repackForRef,
} from "./repack";
import { Fake, ok, REPO, seed } from "./testing";

const spec = platformSpec("android");
const SESSION = `${REPO}/e2e/reports/shots/test-repack`;
const TOOLING = `${SESSION}/tooling`;
const BASE = `${REPO}/e2e/reports/shots/build-cache/android/fp-1-r3-release-arm64-v8a/app-release.apk`;

/** Routes answering the repack driver and the bundle-extraction unzip. */
function repackRoutes(
  f: Fake,
  repack: ExecResult | ((fake: Fake, argv: string[]) => ExecResult) = (
    fake,
    argv,
  ) => {
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    fake.files.set(flag("--output"), "repacked apk");
    fake.files.set(
      `${flag("--work")}/assets/index.android.bundle`,
      `js __BUNDLE_START_TIME__ ${REPACK_SENTINEL_DSN}`,
    );
    return ok;
  },
) {
  f.routes.push(["repack-runner.ts", repack], ["index.android.bundle", ok]);
}

describe("repackAppVersion", () => {
  it("reads @expo/repack-app from the starting checkout's package.json", () => {
    const f = new Fake();
    f.files.set(
      `${REPO}/package.json`,
      JSON.stringify({ devDependencies: { "@expo/repack-app": "0.10.4" } }),
    );
    expect(repackAppVersion(f, REPO)).toBe("0.10.4");
  });

  it("refuses a checkout that does not declare @expo/repack-app", () => {
    const f = new Fake();
    f.files.set(`${REPO}/package.json`, JSON.stringify({ dependencies: {} }));
    expect(() => repackAppVersion(f, REPO)).toThrow(ShotError);
  });
});

describe("ensureRepackApp", () => {
  it("pins @expo/repack-app into the session tooling and installs it there", () => {
    const f = new Fake();
    f.routes.push(["bun install", ok]);
    const root = ensureRepackApp(f, TOOLING, "0.10.4");
    expect(root).toBe(`${TOOLING}/repack`);
    expect(JSON.parse(f.files.get(`${root}/package.json`)!)).toEqual({
      private: true,
      dependencies: { "@expo/repack-app": "0.10.4" },
    });
    const installs = f.execLog.filter((argv) => argv[0] === "bun");
    expect(installs).toEqual([["bun", "install"]]);
    expect(f.execOpts[f.execLog.indexOf(installs[0])]?.cwd).toBe(root);
  });
});

describe("repackOptions", () => {
  it("repacks android with only the JS bundle swapped, always embedding", () => {
    const options = repackOptions({
      projectRoot: "/repo",
      sourceAppPath: "/cache/app-release.apk",
      outputPath: "/out/app-before.apk",
      workingDirectory: "/out/repack-work-before",
      androidBuildToolsDir: "/sdk/build-tools/36.0.0",
    });
    expect(options).toEqual({
      platform: "android",
      projectRoot: "/repo",
      sourceAppPath: "/cache/app-release.apk",
      outputPath: "/out/app-before.apk",
      workingDirectory: "/out/repack-work-before",
      androidBuildToolsDir: "/sdk/build-tools/36.0.0",
      jsBundleOnly: true,
      exportEmbedOptions: {},
    });
  });
});

describe("repackForRef", () => {
  it("drives the tooling copy of the repack runner in the checkout and returns the repacked APK", () => {
    const f = new Fake();
    seed(f);
    repackRoutes(f);

    const output = repackForRef(
      f,
      REPO,
      spec,
      BASE,
      SESSION,
      TOOLING,
      "before",
    );
    expect(output).toBe(`${SESSION}/app-before.apk`);

    const call = f.execLog.findIndex((argv) =>
      argv.join(" ").includes("repack-runner.ts"),
    );
    expect(call).toBeGreaterThanOrEqual(0);
    expect(f.execLog[call]).toEqual([
      "bun",
      `${TOOLING}/repack/e2e/suites/screenshots/repack-runner.ts`,
      "--project",
      REPO,
      "--source",
      BASE,
      "--output",
      `${SESSION}/app-before.apk`,
      "--work",
      `${SESSION}/repack-work-before`,
      "--build-tools",
      `${REPO}/sdk/build-tools/36.0.0`,
    ]);
    const opts = f.execOpts[call];
    // cwd is the checkout so export:embed runs with the switched ref's own expo.
    expect(opts?.cwd).toBe(REPO);
    expect(opts?.env?.EXPO_TV).toBe("0");
    expect(opts?.env?.NODE_ENV).toBe("production");
    expect(opts?.env?.EXPO_PUBLIC_SENTRY_DSN).toBe(REPACK_SENTINEL_DSN);

    // The bundle is verified by extraction, not trusted from the driver's exit.
    const unzip = execsFor(f, "index.android.bundle");
    expect(unzip).toHaveLength(1);
    expect(unzip[0].join(" ")).toContain("unzip -o -q");
    // stdout+stderr land in the session log on success and failure alike.
    expect(f.files.has(`${SESSION}/repack-before.log`)).toBe(true);
  });

  it("throws with the log path when the driver fails, leaving the log behind", () => {
    const f = new Fake();
    seed(f);
    repackRoutes(f, {
      code: 1,
      stdout: "export done",
      stderr: "apktool: link failed",
    });
    expect(() =>
      repackForRef(f, REPO, spec, BASE, SESSION, TOOLING, "after"),
    ).toThrow(/repack after failed \(1\).*repack-after\.log/);
    expect(f.files.get(`${SESSION}/repack-after.log`)).toContain(
      "apktool: link failed",
    );
  });

  it("refuses to install a repacked APK that carries no JS bundle", () => {
    const f = new Fake();
    seed(f);
    repackRoutes(f, (fake, argv) => {
      fake.files.set(argv[argv.indexOf("--output") + 1], "apk");
      return ok;
    });
    expect(() =>
      repackForRef(f, REPO, spec, BASE, SESSION, TOOLING, "before"),
    ).toThrow(/no assets\/index\.android\.bundle.*refusing to install/);
  });

  it("refuses to install a repacked APK whose bundle lacks the sentinel DSN", () => {
    const f = new Fake();
    seed(f);
    repackRoutes(f, (fake, argv) => {
      const flag = (name: string) => argv[argv.indexOf(name) + 1];
      fake.files.set(flag("--output"), "apk");
      fake.files.set(
        `${flag("--work")}/assets/index.android.bundle`,
        "js bundle reporting to the production DSN",
      );
      return ok;
    });
    expect(() =>
      repackForRef(f, REPO, spec, BASE, SESSION, TOOLING, "before"),
    ).toThrow(/sentry\.invalid.*refusing to install/);
  });
});

const execsFor = (f: Fake, needle: string) =>
  f.execLog.filter((argv) => argv.join(" ").includes(needle));
