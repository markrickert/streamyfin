import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOptions, RunProcess } from "./process";
import { repackVariant, SENTINEL_SENTRY_DSN } from "./repack";
import { variantById } from "./variants";

const androidDebugVariant = variantById("android-phone-debug-device-debugkey")!;
const iosDebugVariant = variantById("ios-phone-debug-simulator-unsigned")!;
const iosSignedVariant = variantById("ios-phone-release-device-signed")!;
const androidPhoneReleaseVariant = variantById(
  "android-phone-release-device-debugkey-universal",
)!;
const androidTvReleaseVariant = variantById(
  "android-tv-release-device-debugkey-universal",
)!;
const iosPhoneReleaseSimVariant = variantById(
  "ios-phone-release-simulator-unsigned",
)!;
const iosTvReleaseSimVariant = variantById(
  "ios-tv-release-simulator-unsigned",
)!;

const makeTempDir = () =>
  mkdtempSync(join(tmpdir(), "streamyfin-repack-test-"));

const setupAndroidHome = (rootDir: string, versions: string[]): string => {
  const androidHome = join(rootDir, "android-sdk");
  for (const version of versions) {
    mkdirSync(join(androidHome, "build-tools", version), { recursive: true });
  }
  return androidHome;
};

describe("repackVariant", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("refuses debug variants without spawning a process", async () => {
    const run = jest.fn<ReturnType<RunProcess>, Parameters<RunProcess>>();

    for (const variant of [androidDebugVariant, iosDebugVariant]) {
      const result = await repackVariant(
        {
          variant,
          sourcePath: join(tempDir, "source.bin"),
          outputPath: join(tempDir, "out.bin"),
          projectRoot: tempDir,
          workingDirectory: join(tempDir, "work"),
        },
        { run },
      );

      expect(result.path).toBeNull();
      expect(result.reason).toMatch(/debug/i);
    }

    expect(run).not.toHaveBeenCalled();
  });

  it("refuses signed variants without spawning a process", async () => {
    const run = jest.fn<ReturnType<RunProcess>, Parameters<RunProcess>>();

    const result = await repackVariant(
      {
        variant: iosSignedVariant,
        sourcePath: join(tempDir, "source.ipa"),
        outputPath: join(tempDir, "out.ipa"),
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work"),
      },
      { run },
    );

    expect(result.path).toBeNull();
    expect(result.reason).toMatch(/sign/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("invokes repack-android.ts with full repack args and production/TV/sentinel env", async () => {
    const androidHome = setupAndroidHome(tempDir, ["36.0.0"]);
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: RunOptions;
    }> = [];

    const makeRun = (): RunProcess => (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "bun") {
        writeFileSync(args[3], "apk-bytes");
        return { status: 0, stdout: "repack ok\n", stderr: "" };
      }
      if (command === "unzip") {
        return {
          status: 0,
          stdout: `bundle dsn=${SENTINEL_SENTRY_DSN}`,
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const phoneWorkDir = join(tempDir, "work-phone");
    const phoneOut = join(tempDir, "out-phone.apk");
    const phoneResult = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath: phoneOut,
        projectRoot: "/repo/root",
        workingDirectory: phoneWorkDir,
      },
      { env: { ANDROID_HOME: androidHome, PATH: "/usr/bin" }, run: makeRun() },
    );

    expect(phoneResult).toEqual({ path: phoneOut });
    expect(calls[0].command).toBe("bun");
    expect(calls[0].args).toEqual([
      "scripts/ci/repack-android.ts",
      join(tempDir, "source.apk"),
      join(androidHome, "build-tools", "36.0.0"),
      phoneOut,
      phoneWorkDir,
    ]);
    expect(calls[0].args).not.toContain("--js-bundle-only");
    expect(calls[0].options.cwd).toBe("/repo/root");
    expect(calls[0].options.env).toMatchObject({
      ANDROID_HOME: androidHome,
      PATH: "/usr/bin",
      NODE_ENV: "production",
      EXPO_TV: "0",
      EXPO_PUBLIC_SENTRY_DSN: SENTINEL_SENTRY_DSN,
    });

    calls.length = 0;
    const tvOut = join(tempDir, "out-tv.apk");
    const tvResult = await repackVariant(
      {
        variant: androidTvReleaseVariant,
        sourcePath: join(tempDir, "source-tv.apk"),
        outputPath: tvOut,
        projectRoot: "/repo/root",
        workingDirectory: join(tempDir, "work-tv"),
      },
      { env: { ANDROID_HOME: androidHome }, run: makeRun() },
    );

    expect(tvResult).toEqual({ path: tvOut });
    expect(calls[0].options.env.EXPO_TV).toBe("1");
    expect(calls[0].options.env.NODE_ENV).toBe("production");
    expect(calls[0].options.env.EXPO_PUBLIC_SENTRY_DSN).toBe(
      SENTINEL_SENTRY_DSN,
    );
  });

  it("omits the sentinel DSN and skips the sentinel check when sentry is true", async () => {
    const androidHome = setupAndroidHome(tempDir, ["36.0.0"]);
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: RunOptions;
    }> = [];

    const run: RunProcess = (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "bun") {
        writeFileSync(args[3], "apk-bytes");
        return { status: 0, stdout: "ok", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const outputPath = join(tempDir, "out-sentry.apk");
    const result = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath,
        projectRoot: "/repo/root",
        workingDirectory: join(tempDir, "work"),
        sentry: true,
      },
      { env: { ANDROID_HOME: androidHome }, run },
    );

    expect(result).toEqual({ path: outputPath });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.env.EXPO_PUBLIC_SENTRY_DSN).toBeUndefined();
  });

  it("invokes bunx repack-app for unsigned iOS simulator .app without --js-bundle-only", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: RunOptions;
    }> = [];

    const run: RunProcess = (command, args, options) => {
      calls.push({ command, args, options });
      const outApp = args[args.indexOf("-o") + 1];
      mkdirSync(outApp, { recursive: true });
      writeFileSync(
        join(outApp, "main.jsbundle"),
        `jsbundle ${SENTINEL_SENTRY_DSN}`,
      );
      return { status: 0, stdout: "ios ok\n", stderr: "" };
    };

    const outputPath = join(tempDir, "Streamyfin.app");
    const workDir = join(tempDir, "ios-work");
    const result = await repackVariant(
      {
        variant: iosPhoneReleaseSimVariant,
        sourcePath: join(tempDir, "source.app"),
        outputPath,
        projectRoot: "/repo/root",
        workingDirectory: workDir,
      },
      { env: {}, run },
    );

    expect(result).toEqual({ path: outputPath });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("bunx");
    expect(calls[0].args).toEqual([
      "repack-app",
      "-p",
      "ios",
      "--source-app",
      join(tempDir, "source.app"),
      "-w",
      workDir,
      "-o",
      outputPath,
      ".",
    ]);
    expect(calls[0].args).not.toContain("--js-bundle-only");
    expect(calls[0].options.cwd).toBe("/repo/root");
    expect(calls[0].options.env).toMatchObject({
      NODE_ENV: "production",
      EXPO_TV: "0",
      EXPO_PUBLIC_SENTRY_DSN: SENTINEL_SENTRY_DSN,
    });

    const tvOutputPath = join(tempDir, "StreamyfinTV.app");
    const tvResult = await repackVariant(
      {
        variant: iosTvReleaseSimVariant,
        sourcePath: join(tempDir, "source-tv.app"),
        outputPath: tvOutputPath,
        projectRoot: "/repo/root",
        workingDirectory: join(tempDir, "ios-tv-work"),
      },
      { env: {}, run },
    );
    expect(tvResult).toEqual({ path: tvOutputPath });
    expect(calls[1].options.env.EXPO_TV).toBe("1");
  });

  it("returns a miss when ANDROID_HOME or build-tools is missing", async () => {
    const run = jest.fn<ReturnType<RunProcess>, Parameters<RunProcess>>();

    const noEnv = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath: join(tempDir, "out.apk"),
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-1"),
      },
      { env: {}, run },
    );
    expect(noEnv.path).toBeNull();
    expect(noEnv.reason).toMatch(/ANDROID_HOME/);

    const emptySdk = join(tempDir, "empty-sdk");
    mkdirSync(join(emptySdk, "build-tools"), { recursive: true });
    writeFileSync(join(emptySdk, "build-tools", ".DS_Store"), "");

    const noTools = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath: join(tempDir, "out.apk"),
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-2"),
      },
      { env: { ANDROID_HOME: emptySdk }, run },
    );
    expect(noTools.path).toBeNull();
    expect(noTools.reason).toMatch(/build-tools/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("selects the newest build-tools directory by version sort (37.0.0 > 36.0.0 > 9.0.0)", async () => {
    const androidHome = setupAndroidHome(tempDir, [
      "9.0.0",
      "36.0.0",
      "37.0.0",
    ]);
    let selectedBuildTools: string | undefined;

    const run: RunProcess = (command, args) => {
      if (command === "bun") {
        selectedBuildTools = args[2];
        writeFileSync(args[3], "apk");
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: SENTINEL_SENTRY_DSN, stderr: "" };
    };

    const result = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath: join(tempDir, "out.apk"),
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work"),
      },
      { env: { ANDROID_HOME: androidHome }, run },
    );

    expect(result.path).not.toBeNull();
    expect(selectedBuildTools).toBe(join(androidHome, "build-tools", "37.0.0"));
  });

  it("captures stdout and stderr to repack.log and returns a miss naming the step and log on non-zero exit", async () => {
    const androidHome = setupAndroidHome(tempDir, ["36.0.0"]);
    const workDir = join(tempDir, "work");

    const run: RunProcess = () => ({
      status: 2,
      stdout: "starting repack\n",
      stderr: "aapt2 blew up\n",
    });

    const outputPath = join(tempDir, "out.apk");
    const result = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath,
        projectRoot: tempDir,
        workingDirectory: workDir,
      },
      { env: { ANDROID_HOME: androidHome }, run },
    );

    const logPath = `${outputPath}.repack.log`;
    expect(result.path).toBeNull();
    expect(result.reason).toContain("repack-android");
    expect(result.reason).toContain(logPath);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("starting repack");
    expect(log).toContain("aapt2 blew up");
  });

  it("writes repack.log outside workingDirectory so the log survives when repack-app deletes workingDirectory", async () => {
    const workDir = join(tempDir, "work-deleted");
    const outputPath = join(tempDir, "Streamyfin.app");

    const run: RunProcess = (_command, args) => {
      rmSync(workDir, { recursive: true, force: true });
      const outApp = args[args.indexOf("-o") + 1];
      mkdirSync(outApp, { recursive: true });
      writeFileSync(join(outApp, "main.jsbundle"), "no-sentinel-here");
      return {
        status: 0,
        stdout: "repack stdout\n",
        stderr: "repack stderr\n",
      };
    };

    const result = await repackVariant(
      {
        variant: iosPhoneReleaseSimVariant,
        sourcePath: join(tempDir, "source.app"),
        outputPath,
        projectRoot: tempDir,
        workingDirectory: workDir,
      },
      { env: {}, run },
    );

    const logPath = `${outputPath}.repack.log`;
    expect(result.path).toBeNull();
    expect(result.reason).toContain(logPath);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("repack stdout");
    expect(log).toContain("repack stderr");
  });

  it("includes spawn error message in stderr and miss reason when runner fails to spawn", async () => {
    const outputPath = join(tempDir, "Streamyfin.app");
    const run: RunProcess = () => ({
      status: null,
      stdout: "",
      stderr: "spawnSync bunx ENOENT",
    });

    const result = await repackVariant(
      {
        variant: iosPhoneReleaseSimVariant,
        sourcePath: join(tempDir, "source.app"),
        outputPath,
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-enoent"),
      },
      { env: {}, run },
    );

    const logPath = `${outputPath}.repack.log`;
    expect(result.path).toBeNull();
    expect(result.reason).toContain("spawnSync bunx ENOENT");
    expect(result.reason).toContain(logPath);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("spawnSync bunx ENOENT");
  });

  it("returns a miss without throwing when runner throws", async () => {
    const outputPath = join(tempDir, "Streamyfin.app");
    const run: RunProcess = () => {
      throw new Error("runner exploded");
    };

    const result = await repackVariant(
      {
        variant: iosPhoneReleaseSimVariant,
        sourcePath: join(tempDir, "source.app"),
        outputPath,
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-throw"),
      },
      { env: {}, run },
    );

    expect(result.path).toBeNull();
    expect(result.reason).toContain("runner exploded");
  });

  it("falls back to ANDROID_SDK_ROOT when ANDROID_HOME is unset", async () => {
    const androidSdk = setupAndroidHome(tempDir, ["36.0.0"]);
    let selectedBuildTools: string | undefined;

    const run: RunProcess = (command, args) => {
      if (command === "bun") {
        selectedBuildTools = args[2];
        writeFileSync(args[3], "apk");
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: SENTINEL_SENTRY_DSN, stderr: "" };
    };

    const outputPath = join(tempDir, "out-sdk-root.apk");
    const result = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath,
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-sdk-root"),
      },
      { env: { ANDROID_SDK_ROOT: androidSdk }, run },
    );

    expect(result).toEqual({ path: outputPath });
    expect(selectedBuildTools).toBe(join(androidSdk, "build-tools", "36.0.0"));
  });

  it("returns a miss when neither ANDROID_HOME nor ANDROID_SDK_ROOT has build-tools", async () => {
    const run = jest.fn<ReturnType<RunProcess>, Parameters<RunProcess>>();

    const emptySdk = join(tempDir, "empty-sdk-root");
    mkdirSync(join(emptySdk, "build-tools"), { recursive: true });

    const noTools = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath: join(tempDir, "out.apk"),
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-no-tools"),
      },
      { env: { ANDROID_SDK_ROOT: emptySdk }, run },
    );

    expect(noTools.path).toBeNull();
    expect(noTools.reason).toMatch(/build-tools/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns a miss when repack finishes with exit 0 without creating output", async () => {
    const outputPath = join(tempDir, "missing.app");
    const run: RunProcess = () => ({
      status: 0,
      stdout: "done\n",
      stderr: "",
    });

    const result = await repackVariant(
      {
        variant: iosPhoneReleaseSimVariant,
        sourcePath: join(tempDir, "source.app"),
        outputPath,
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-no-out"),
      },
      { env: {}, run },
    );

    expect(result.path).toBeNull();
    expect(result.reason).toMatch(/without creating/i);
    expect(result.reason).toContain(`${outputPath}.repack.log`);
  });

  it("returns a miss when unzip fails during the Android sentinel check", async () => {
    const androidHome = setupAndroidHome(tempDir, ["36.0.0"]);
    const run: RunProcess = (command, args) => {
      if (command === "bun") {
        writeFileSync(args[3], "apk");
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unzip: cannot find" };
    };

    const result = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath: join(tempDir, "out-unzip-fail.apk"),
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-unzip-fail"),
      },
      { env: { ANDROID_HOME: androidHome }, run },
    );

    expect(result.path).toBeNull();
    expect(result.reason).toMatch(/assets\/index\.android\.bundle/);
    expect(result.reason).toMatch(/exit 1/);
  });

  it("includes error message when unzip fails to spawn during the Android sentinel check", async () => {
    const androidHome = setupAndroidHome(tempDir, ["36.0.0"]);
    const run: RunProcess = (command, args) => {
      if (command === "bun") {
        writeFileSync(args[3], "apk");
        return { status: 0, stdout: "", stderr: "" };
      }
      return {
        status: null,
        stdout: "",
        stderr: "spawnSync unzip ENOENT",
      };
    };

    const result = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath: join(tempDir, "out-unzip-enoent.apk"),
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-unzip-enoent"),
      },
      { env: { ANDROID_HOME: androidHome }, run },
    );

    expect(result.path).toBeNull();
    expect(result.reason).toContain("spawnSync unzip ENOENT");
  });

  it("refuses outputPath resolving inside workingDirectory without spawning a process", async () => {
    const run = jest.fn<ReturnType<RunProcess>, Parameters<RunProcess>>();
    const workDir = join(tempDir, "work-dir");

    for (const badOutput of [
      join(workDir, "Streamyfin.app"),
      join(workDir, "nested", "..", "out.app"),
      workDir,
    ]) {
      const result = await repackVariant(
        {
          variant: iosPhoneReleaseSimVariant,
          sourcePath: join(tempDir, "source.app"),
          outputPath: badOutput,
          projectRoot: tempDir,
          workingDirectory: workDir,
        },
        { env: {}, run },
      );

      expect(result.path).toBeNull();
      expect(result.reason).toMatch(/workingDirectory/i);
    }

    expect(run).not.toHaveBeenCalled();

    const siblingRun: RunProcess = (_command, args) => {
      const outApp = args[args.indexOf("-o") + 1];
      mkdirSync(outApp, { recursive: true });
      writeFileSync(join(outApp, "main.jsbundle"), SENTINEL_SENTRY_DSN);
      return { status: 0, stdout: "", stderr: "" };
    };
    const siblingOutput = join(tempDir, "work-dir-sibling", "Streamyfin.app");
    const okResult = await repackVariant(
      {
        variant: iosPhoneReleaseSimVariant,
        sourcePath: join(tempDir, "source.app"),
        outputPath: siblingOutput,
        projectRoot: tempDir,
        workingDirectory: workDir,
      },
      { env: {}, run: siblingRun },
    );
    expect(okResult).toEqual({ path: siblingOutput });
  });

  it("falls through to ANDROID_SDK_ROOT when ANDROID_HOME is set but lacks build-tools", async () => {
    const emptyAndroidHome = join(tempDir, "empty-android-home");
    mkdirSync(emptyAndroidHome, { recursive: true });
    const androidSdkRoot = setupAndroidHome(tempDir, ["36.0.0"]);
    let selectedBuildTools: string | undefined;

    const run: RunProcess = (command, args) => {
      if (command === "bun") {
        selectedBuildTools = args[2];
        writeFileSync(args[3], "apk");
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: SENTINEL_SENTRY_DSN, stderr: "" };
    };

    const outputPath = join(tempDir, "out-fallthrough.apk");
    const result = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath,
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-fallthrough"),
      },
      {
        env: {
          ANDROID_HOME: emptyAndroidHome,
          ANDROID_SDK_ROOT: androidSdkRoot,
        },
        run,
      },
    );

    expect(result).toEqual({ path: outputPath });
    expect(selectedBuildTools).toBe(
      join(androidSdkRoot, "build-tools", "36.0.0"),
    );
  });

  it("returns a miss when the repacked bundle does not contain the sentinel DSN", async () => {
    const androidHome = setupAndroidHome(tempDir, ["36.0.0"]);
    const androidRun: RunProcess = (command, args) => {
      if (command === "bun") {
        writeFileSync(args[3], "apk");
        return { status: 0, stdout: "", stderr: "" };
      }
      return {
        status: 0,
        stdout:
          "https://5c548edf47663532bb529ba72b2ddbb1@o4509610343596032.ingest.de.sentry.io/4509610370728016",
        stderr: "",
      };
    };

    const androidMiss = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: join(tempDir, "source.apk"),
        outputPath: join(tempDir, "out.apk"),
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-android"),
      },
      { env: { ANDROID_HOME: androidHome }, run: androidRun },
    );
    expect(androidMiss.path).toBeNull();
    expect(androidMiss.reason).toMatch(/sentinel/i);

    const iosRun: RunProcess = (_command, args) => {
      const outApp = args[args.indexOf("-o") + 1];
      mkdirSync(outApp, { recursive: true });
      writeFileSync(join(outApp, "main.jsbundle"), "no-sentinel-here");
      return { status: 0, stdout: "", stderr: "" };
    };

    const iosMiss = await repackVariant(
      {
        variant: iosPhoneReleaseSimVariant,
        sourcePath: join(tempDir, "source.app"),
        outputPath: join(tempDir, "out.app"),
        projectRoot: tempDir,
        workingDirectory: join(tempDir, "work-ios"),
      },
      { env: {}, run: iosRun },
    );
    expect(iosMiss.path).toBeNull();
    expect(iosMiss.reason).toMatch(/sentinel/i);
  });

  it("resolves relative paths against projectRoot instead of the caller cwd", async () => {
    // projectRoot differs from process.cwd(): a relative source, output and
    // working directory must all resolve inside the project, not the test
    // runner's cwd.
    const projectRoot = join(tempDir, "project");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, "dist"), { recursive: true });
    setupAndroidHome(tempDir, ["36.0.0"]);

    const calls: { command: string; args: string[] }[] = [];
    const run: RunProcess = (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === "bun") {
        writeFileSync(args[3], "apk");
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: SENTINEL_SENTRY_DSN, stderr: "" };
    };

    const result = await repackVariant(
      {
        variant: androidPhoneReleaseVariant,
        sourcePath: "dist/source.apk",
        outputPath: "dist/out.apk",
        projectRoot,
        workingDirectory: "dist/work",
      },
      { env: { ANDROID_HOME: join(tempDir, "android-sdk") }, run },
    );

    expect(result).toEqual({ path: join(projectRoot, "dist", "out.apk") });
    // The child process receives the resolved absolute paths.
    const repackArgs = calls.find((c) => c.command === "bun")!.args;
    expect(repackArgs[1]).toBe(join(projectRoot, "dist", "source.apk"));
    expect(repackArgs[3]).toBe(join(projectRoot, "dist", "out.apk"));
    expect(repackArgs[4]).toBe(join(projectRoot, "dist", "work"));
  });

  it("keeps absolute paths unchanged when projectRoot differs", async () => {
    const projectRoot = join(tempDir, "project");
    mkdirSync(projectRoot, { recursive: true });
    const absoluteOutput = join(tempDir, "elsewhere", "out.app");

    const run: RunProcess = (_command, args) => {
      const outApp = args[args.indexOf("-o") + 1];
      mkdirSync(outApp, { recursive: true });
      writeFileSync(join(outApp, "main.jsbundle"), SENTINEL_SENTRY_DSN);
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = await repackVariant(
      {
        variant: iosPhoneReleaseSimVariant,
        sourcePath: join(tempDir, "source.app"),
        outputPath: absoluteOutput,
        projectRoot,
        workingDirectory: join(tempDir, "work-ios"),
      },
      { env: {}, run },
    );

    expect(result).toEqual({ path: absoluteOutput });
  });

  it("does not mutate process.env", async () => {
    const androidHome = setupAndroidHome(tempDir, ["36.0.0"]);
    const originalEnv = { ...process.env };
    const originalSentry = process.env.EXPO_PUBLIC_SENTRY_DSN;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalExpoTv = process.env.EXPO_TV;

    const run: RunProcess = (command, args) => {
      if (command === "bun") {
        writeFileSync(args[3], "apk");
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: SENTINEL_SENTRY_DSN, stderr: "" };
    };

    let result: Awaited<ReturnType<typeof repackVariant>>;
    const originalAndroidHome = process.env.ANDROID_HOME;
    process.env.ANDROID_HOME = androidHome;
    try {
      result = await repackVariant(
        {
          variant: androidTvReleaseVariant,
          sourcePath: join(tempDir, "source.apk"),
          outputPath: join(tempDir, "out.apk"),
          projectRoot: tempDir,
          workingDirectory: join(tempDir, "work"),
        },
        { run },
      );
    } finally {
      if (originalAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = originalAndroidHome;
      }
    }

    expect(result!).toEqual({ path: join(tempDir, "out.apk") });
    expect(process.env.EXPO_PUBLIC_SENTRY_DSN).toBe(originalSentry);
    expect(process.env.NODE_ENV).toBe(originalNodeEnv);
    expect(process.env.EXPO_TV).toBe(originalExpoTv);
    expect(process.env).toEqual(originalEnv);
  });
});
