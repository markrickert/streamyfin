import { androidBuildToolsDir } from "./build";
import { type PlatformSpec } from "./cli";
import { type Deps, must, ShotError } from "./core";

/**
 * The DSN repacked bundles must inline. PROJECT_SENTRY_DSN in utils/sentry.ts stays
 * a literal in every bundle, so a correct repack can only be told by the sentinel's
 * presence — and one is needed because an Android emulator release build would
 * otherwise report to production: unlike the iOS simulator, `isDevice` never
 * silences Sentry there.
 */
export const REPACK_SENTINEL_DSN = "https://e2e@sentry.invalid/0";

/** export:embed dominates a repack; the whole driver run is bounded at 30 minutes. */
const REPACK_TIMEOUT_MS = 1_800_000;

/**
 * The @expo/repack-app version the session's repack tooling pins to, read from the
 * starting checkout's package.json before the first ref switch — the checkout the
 * run moves away from may differ. An absent declaration refuses the run rather
 * than float the tooling to whatever the registry then serves.
 */
export function repackAppVersion(d: Deps, repo: string): string {
  const pkg = JSON.parse(d.fs.read(`${repo}/package.json`)) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const version =
    pkg.dependencies?.["@expo/repack-app"] ??
    pkg.devDependencies?.["@expo/repack-app"];
  if (!version)
    throw new ShotError(
      "the starting checkout's package.json declares no @expo/repack-app version to pin the repack tooling to",
    );
  return version;
}

/**
 * Installs the pinned @expo/repack-app into the session tooling, next to the
 * repack-runner copy snapshotTooling made. The tooling package owns no lockfile:
 * the pinned version is the only dependency, so `bun install` resolves exactly it.
 */
export function ensureRepackApp(
  d: Deps,
  tooling: string,
  version: string,
): string {
  const root = `${tooling}/repack`;
  d.fs.mkdir(root);
  d.fs.write(
    `${root}/package.json`,
    `${JSON.stringify(
      { private: true, dependencies: { "@expo/repack-app": version } },
      null,
      2,
    )}\n`,
  );
  must(
    d.exec(["bun", "install"], { cwd: root }),
    "install @expo/repack-app into the session tooling",
  );
  return root;
}

/**
 * Repacks the cached release base with the checked-out ref's JS and returns
 * <session>/app-<ref>.apk. The driver's stdout+stderr lands in repack-<ref>.log on
 * success and failure. Before returning, the bundle is extracted by name — piping
 * a 20+ MB bundle through exec's maxBuffer is not an option — and read for the
 * sentinel DSN; either check failing refuses the APK for install.
 */
export function repackForRef(
  d: Deps,
  repo: string,
  spec: PlatformSpec,
  base: string,
  sessionDir: string,
  tooling: string,
  refLabel: string,
): string {
  const output = `${sessionDir}/app-${refLabel}.apk`;
  const workDir = `${sessionDir}/repack-work-${refLabel}`;
  const logFile = `${sessionDir}/repack-${refLabel}.log`;
  d.fs.mkdir(workDir);
  const result = d.exec(
    [
      "bun",
      `${tooling}/repack/e2e/suites/screenshots/repack-runner.ts`,
      "--project",
      repo,
      "--source",
      base,
      "--output",
      output,
      "--work",
      workDir,
      "--build-tools",
      androidBuildToolsDir(d),
    ],
    {
      // cwd is the checkout so export:embed runs with the switched ref's own expo.
      cwd: repo,
      env: {
        EXPO_TV: spec.tv ? "1" : "0",
        NODE_ENV: "production",
        EXPO_PUBLIC_SENTRY_DSN: REPACK_SENTINEL_DSN,
      },
      timeoutMs: REPACK_TIMEOUT_MS,
    },
  );
  d.fs.write(logFile, `${result.stdout}${result.stderr}`);
  if (result.code !== 0)
    throw new ShotError(
      `repack ${refLabel} failed (${result.code}): ${result.stderr
        .trim()
        .split("\n")
        .slice(-5)
        .join("\n")} — full log at ${logFile}`,
    );
  const bundle = "assets/index.android.bundle";
  const extracted = d.exec([
    "unzip",
    "-o",
    "-q",
    output,
    bundle,
    "-d",
    workDir,
  ]);
  const bundlePath = `${workDir}/${bundle}`;
  if (extracted.code !== 0 || !d.fs.exists(bundlePath))
    throw new ShotError(
      `repacked ${refLabel} APK has no ${bundle} — refusing to install it (log: ${logFile})`,
    );
  if (!d.fs.read(bundlePath).includes("sentry.invalid"))
    throw new ShotError(
      `repacked ${refLabel} bundle lacks the ${REPACK_SENTINEL_DSN} sentinel — refusing to install it (log: ${logFile})`,
    );
  return output;
}
