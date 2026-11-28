/**
 * Repacks a cached Release base binary with the working tree's JS bundle and
 * Expo config so local runs never install an un-repacked cached binary.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type BinaryResult, defaultRun, type RunProcess } from "./process";
import type { Variant } from "./variants";

/**
 * Sentinel Sentry DSN used during local repacks unless `sentry: true` is passed.
 * An Android emulator Release build cannot tell it is on an emulator, so a real
 * DSN would report local experiments to production.
 */
export const SENTINEL_SENTRY_DSN = "https://e2e@sentry.invalid/0";

export interface RepackOptions {
  variant: Variant;
  sourcePath: string;
  outputPath: string;
  projectRoot: string;
  workingDirectory: string;
  sentry?: boolean;
}

export interface RepackDeps {
  env?: Record<string, string | undefined>;
  run?: RunProcess;
}

const resolveLatestBuildToolsDir = (
  env: Record<string, string | undefined>,
): { ok: true; dir: string } | { ok: false; reason: string } => {
  const candidates = [
    env.ANDROID_HOME?.trim(),
    env.ANDROID_SDK_ROOT?.trim(),
  ].filter((value): value is string => Boolean(value));
  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        "Neither ANDROID_HOME nor ANDROID_SDK_ROOT is set; cannot locate Android build-tools",
    };
  }

  const errors: string[] = [];
  for (const androidHome of new Set(candidates)) {
    const buildToolsRoot = join(androidHome, "build-tools");
    if (!existsSync(buildToolsRoot)) {
      errors.push(
        `No Android build-tools directory found at ${buildToolsRoot}`,
      );
      continue;
    }

    let versions: string[];
    try {
      versions = readdirSync(buildToolsRoot).filter((entry) =>
        statSync(join(buildToolsRoot, entry)).isDirectory(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(
        `Failed to read Android build-tools at ${buildToolsRoot}: ${message}`,
      );
      continue;
    }

    if (versions.length === 0) {
      errors.push(
        `No Android build-tools versions found under ${buildToolsRoot}`,
      );
      continue;
    }

    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return {
      ok: true,
      dir: join(buildToolsRoot, versions[versions.length - 1]),
    };
  }

  return { ok: false, reason: errors.join("; ") };
};

const writeRepackLog = (logPath: string, stdout: string, stderr: string) => {
  try {
    const sections = [stdout, stderr].filter((part) => part.length > 0);
    writeFileSync(logPath, sections.join("\n"));
  } catch {
    // Best-effort: log write failure should not throw out of repackVariant.
  }
};

const verifySentinel = (
  opts: RepackOptions,
  childEnv: Record<string, string | undefined>,
  run: RunProcess,
): string | null => {
  if (opts.variant.kind === "apk") {
    let result: ReturnType<RunProcess>;
    try {
      result = run(
        "unzip",
        ["-p", opts.outputPath, "assets/index.android.bundle"],
        { cwd: opts.projectRoot, env: childEnv },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to inspect assets/index.android.bundle in ${opts.outputPath}: ${message}`;
    }

    if (result.status !== 0) {
      const detail =
        result.status === null && result.stderr.trim()
          ? `exit null: ${result.stderr.trim()}`
          : `exit ${String(result.status)}`;
      return `Failed to read assets/index.android.bundle from ${opts.outputPath} (${detail})`;
    }

    if (!result.stdout.includes(SENTINEL_SENTRY_DSN)) {
      return `Repacked APK at ${opts.outputPath} is missing sentinel Sentry DSN (${SENTINEL_SENTRY_DSN}); working-tree env was not picked up`;
    }
    return null;
  }

  const bundlePath = join(opts.outputPath, "main.jsbundle");
  let contents: string;
  try {
    contents = readFileSync(bundlePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to read ${bundlePath}: ${message}`;
  }

  if (!contents.includes(SENTINEL_SENTRY_DSN)) {
    return `Repacked app bundle at ${bundlePath} is missing sentinel Sentry DSN (${SENTINEL_SENTRY_DSN}); working-tree env was not picked up`;
  }
  return null;
};

/**
 * Repacks a cached Release binary with the working tree's JS bundle and Expo
 * config, returning `{ path: null, reason }` on any miss without throwing.
 */
export const repackVariant = async (
  opts: RepackOptions,
  deps: RepackDeps = {},
): Promise<BinaryResult> => {
  try {
    const { variant } = opts;

    if (variant.config !== "release") {
      return {
        path: null,
        reason: `Cannot repack ${variant.id}: debug builds load JS from Metro and are never repacked`,
      };
    }

    if (variant.signing === "signed") {
      return {
        path: null,
        reason: `Cannot repack ${variant.id}: local signing is out of scope`,
      };
    }

    if (variant.kind !== "apk" && variant.kind !== "app") {
      return {
        path: null,
        reason: `Cannot repack ${variant.id}: unsupported binary kind "${variant.kind}"`,
      };
    }

    // Resolve every path once against the project root so the repack does not
    // depend on the caller's cwd. Absolute paths pass through unchanged.
    const resolvedSourcePath = resolve(opts.projectRoot, opts.sourcePath);
    const resolvedOutputPath = resolve(opts.projectRoot, opts.outputPath);
    const resolvedWorkDir = resolve(opts.projectRoot, opts.workingDirectory);
    const rel = relative(resolvedWorkDir, resolvedOutputPath);
    if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return {
        path: null,
        reason: `Cannot repack ${variant.id}: outputPath (${resolvedOutputPath}) must not resolve inside workingDirectory (${resolvedWorkDir})`,
      };
    }

    const parentEnv = deps.env ?? process.env;
    const run = deps.run ?? defaultRun;

    const childEnv: Record<string, string | undefined> = {
      ...parentEnv,
      NODE_ENV: "production",
      EXPO_TV: variant.form === "tv" ? "1" : "0",
    };
    if (opts.sentry !== true) {
      childEnv.EXPO_PUBLIC_SENTRY_DSN = SENTINEL_SENTRY_DSN;
    }

    let step: string;
    let command: string;
    let args: string[];

    if (variant.kind === "apk") {
      const buildTools = resolveLatestBuildToolsDir(childEnv);
      if (!buildTools.ok) {
        return { path: null, reason: buildTools.reason };
      }
      step = "repack-android";
      command = "bun";
      args = [
        "scripts/ci/repack-android.ts",
        resolvedSourcePath,
        buildTools.dir,
        resolvedOutputPath,
        resolvedWorkDir,
      ];
    } else {
      step = "repack-app";
      command = "bunx";
      args = [
        "repack-app",
        "-p",
        "ios",
        "--source-app",
        resolvedSourcePath,
        "-w",
        resolvedWorkDir,
        "-o",
        resolvedOutputPath,
        ".",
      ];
    }

    mkdirSync(resolvedWorkDir, { recursive: true });
    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    const logPath = `${resolvedOutputPath}.repack.log`;

    let result: ReturnType<RunProcess>;
    try {
      result = run(command, args, {
        cwd: opts.projectRoot,
        env: childEnv,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeRepackLog(logPath, "", message);
      return {
        path: null,
        reason: `${step} failed: ${message}; see ${logPath}`,
      };
    }

    writeRepackLog(logPath, result.stdout, result.stderr);

    if (result.status !== 0) {
      const errorDetail =
        result.status === null && result.stderr.trim()
          ? ` (${result.stderr.trim()})`
          : "";
      return {
        path: null,
        reason: `${step} failed with exit code ${String(result.status)}${errorDetail}; see ${logPath}`,
      };
    }

    if (!existsSync(resolvedOutputPath)) {
      return {
        path: null,
        reason: `${step} finished without creating ${resolvedOutputPath}; see ${logPath}`,
      };
    }

    if (opts.sentry !== true) {
      const sentinelError = verifySentinel(
        { ...opts, outputPath: resolvedOutputPath },
        childEnv,
        run,
      );
      if (sentinelError) {
        return { path: null, reason: `${sentinelError}; see ${logPath}` };
      }
    }

    return { path: resolvedOutputPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path: null, reason: `repack failed: ${message}` };
  }
};
