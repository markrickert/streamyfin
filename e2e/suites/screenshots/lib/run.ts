import { resetTestAppState } from "./app-state";
import {
  appIdOnDevice,
  type BuildSource,
  deviceAbi,
  ensureDebugBuild,
  nativeFingerprint,
} from "./build";
import {
  devClientUrl,
  launchDevClient,
  passTimeoutSeconds,
  runCapture,
  startMetro,
} from "./capture";
import { platformSpec } from "./cli";
import {
  type Cli,
  type Deps,
  formatElapsed,
  mask,
  must,
  type Platform,
  ShotError,
  type SpawnHandle,
} from "./core";
import {
  ensurePortFree,
  newDeviceState,
  prepareDevice,
  restoreDevice,
  selectDevice,
  writeAndroidDiagnostics,
} from "./device";
import { describeFailedStep, failedStep } from "./failure";
import { ensureFixture, fixtureChecks, fixtureEnv } from "./fixture";
import {
  backupNativeDirs,
  type GitStart,
  lockfileChanged,
  preflight,
  readBuildDeps,
  restoreGit,
  restoreNativeDirs,
} from "./git";
import {
  DEFAULT_PORT,
  ensureMaestro,
  ensureOutIgnored,
  MAESTRO_TAG,
  maestroBinary,
  REPORTS_DIR,
  snapshotTooling,
} from "./tooling";

export interface BuildCacheManifestEntry {
  ref: string;
  platform: Platform;
  hash: string;
  source: BuildSource;
  path: string;
}

export interface RunReport {
  sessionDir: string;
  beforeSha: string;
  afterSha: string;
  restored: GitStart;
}

/** Set by runComparison while it holds live state; shots.ts calls it on SIGINT/SIGTERM. */
export let interruptCleanup: (() => void) | undefined;

export function setInterruptCleanup(fn: (() => void) | undefined): void {
  interruptCleanup = fn;
}

// A cold Metro cache on the 3-core macOS runner has taken over 300 s for the first iOS bundle.
const METRO_BUNDLE_TIMEOUT_MS = 600_000;

/**
 * Exact bundle URL that expo-dev-launcher requests from Metro's manifest
 * (`ManifestMiddleware._getBundleUrl` / `createBundleUrlPath` in `@expo/cli`). Warming
 * any shorter query populates a different Metro cache entry and leaves the client with
 * a cold Hermes compile.
 */
export function metroBundleUrl(
  platform: "ios" | "android",
  port: number,
): string {
  return `http://127.0.0.1:${port}/index.ts.bundle?platform=${platform}&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&unstable_transformProfile=hermes-stable`;
}

/**
 * before → noise → after, on one checkout. The before and noise passes share the before
 * ref's switch (noise is a fresh capture of the same build — never cached, never
 * carried). Restoration runs on success, failure and interrupt.
 */
export async function runComparison(
  d: Deps,
  cli: Cli,
  repo: string,
): Promise<RunReport> {
  const spec = platformSpec(cli.platform!);
  const { beforeSha, afterSha, start } = preflight(d, repo, cli);
  const device = selectDevice(d, cli.platform!, cli.device);
  const port = cli.port ?? DEFAULT_PORT;
  ensurePortFree(d, port);
  passTimeoutSeconds(d);
  const sessionDir = cli.outDir ?? `${repo}/${REPORTS_DIR}/${Date.now()}`;
  let outReady = false;
  let passLabel: string | undefined;
  let secrets: string[] = [];
  // A failure is reported in <session>/report/summary.md even when compare.ts never
  // runs (CI cats it into the job summary). The report itself is best-effort: it must
  // never mask the error it describes, and it stays unwritten until sessionDir is
  // proven gitignored — an --out outside it must not gain files either.
  const reportFailure = (error: unknown): void => {
    if (!outReady) return;
    try {
      writeFailureSummary(
        d,
        sessionDir,
        cli.platform!,
        passLabel,
        error,
        secrets,
      );
    } catch (summaryError) {
      d.log(
        `could not write ${sessionDir}/report/summary.md: ${
          summaryError instanceof Error ? summaryError.message : summaryError
        }`,
      );
    }
  };

  let metro: SpawnHandle | undefined;
  let nativeMoved: string[] = [];
  let buildDeps = "";
  let switched = false;
  const deviceState = newDeviceState();
  // Nested: a refused git restore (new user edits mid-run) must not strand the
  // native dirs in the backup.
  const cleanup = (): void => {
    metro?.kill();
    metro = undefined;
    restoreDevice(d, cli.platform!, device, deviceState);
    try {
      // A failure before the first `git switch --detach` leaves the tree on the
      // starting ref already: switching back would be a switch the run never made.
      if (switched) {
        restoreGit(d, repo, start);
        // node_modules still holds the last switched ref's lockfile. Logged, not
        // thrown: a throw here would hide the error this cleanup runs after.
        if (buildDeps && lockfileChanged(d, repo, buildDeps)) {
          const install = d.exec(["bun", "install", "--frozen-lockfile"], {
            cwd: repo,
          });
          if (install.code !== 0)
            d.log(
              `bun install failed while restoring ${start.ref}; run it by hand before anything else: ${install.stderr.trim().slice(0, 200)}`,
            );
        }
      }
    } finally {
      if (nativeMoved.length)
        restoreNativeDirs(d, repo, sessionDir, nativeMoved);
    }
  };
  ensureOutIgnored(d, repo, sessionDir);
  setInterruptCleanup(cleanup);
  try {
    d.fs.mkdir(sessionDir);
    outReady = true;
    const tooling = snapshotTooling(d, repo, sessionDir);
    const maestro = ensureMaestro(d, `${repo}/${REPORTS_DIR}/tools`);
    ensureFixture(d, repo);
    // Capture the fixture contract while the checkout that produced it is still on
    // disk: .state/ and .env are gitignored, so they survive the switch — but an
    // absent or changed file on the other ref must never be re-read mid-run.
    const baseEnv = fixtureEnv(d, repo, cli.platform!);
    secrets = [baseEnv.MAESTRO_JELLYFIN_PASS, baseEnv.MAESTRO_SEERR_PASS];

    prepareDevice(d, cli.platform!, device, deviceState);
    const abi =
      cli.platform === "android" || cli.platform === "android-tv"
        ? deviceAbi(d, device)
        : undefined;
    const refs: { label: string; sha: string; captures: string[] }[] = [
      { label: "before", sha: beforeSha, captures: ["before", "noise"] },
      { label: "after", sha: afterSha, captures: ["after"] },
    ];
    const buildCacheManifest: BuildCacheManifestEntry[] = [];
    // Only the session's first pass reinstalls Maestro's driver; a failed first pass's
    // retry is already a later pass, so the flag flips before the call, not after it.
    let firstPass = true;
    for (const [refIndex, ref] of refs.entries()) {
      must(
        d.exec(["git", "switch", "--detach", ref.sha], { cwd: repo }),
        `git switch ${ref.label}`,
      );
      switched = true;
      if (lockfileChanged(d, repo, buildDeps))
        must(
          d.exec(["bun", "install", "--frozen-lockfile"], { cwd: repo }),
          "bun install --frozen-lockfile",
        );
      buildDeps = readBuildDeps(d, repo);
      const fingerprint = nativeFingerprint(d, repo, spec);
      const shortHash = fingerprint.slice(0, 8);
      const buildStarted = Date.now();
      d.log(
        `building ${ref.label} (${cli.platform!}, fingerprint ${shortHash})`,
      );
      const { artifact, source, hash } = ensureDebugBuild(
        d,
        repo,
        cli.platform!,
        spec,
        fingerprint,
        sessionDir,
        () => {
          if (!nativeMoved.length)
            nativeMoved = backupNativeDirs(d, repo, sessionDir);
          must(
            d.exec(["bun", "run", spec.tv ? "prebuild:tv" : "prebuild"], {
              cwd: repo,
            }),
            "expo prebuild",
          );
          // `expo prebuild` writes the ios project but does not run pod install.
          if (spec.fingerprintPlatform === "ios")
            must(
              // `react-native.config.js` drops iOS-only pods only under EXPO_TV=1;
              // without it a tvOS app crashes at launch on their missing classes.
              d.exec(["pod", "install"], {
                cwd: `${repo}/ios`,
                env: { EXPO_TV: spec.tv ? "1" : "0" },
              }),
              "pod install",
            );
        },
        abi,
      );
      d.log(
        `building ${ref.label} (${cli.platform!}, fingerprint ${shortHash}): ${source} (${formatElapsed(Date.now() - buildStarted)})`,
      );
      buildCacheManifest.push({
        ref: ref.label,
        platform: cli.platform!,
        hash,
        source,
        path: artifact,
      });
      d.fs.write(
        `${sessionDir}/build-cache.json`,
        JSON.stringify(buildCacheManifest, null, 2),
      );
      d.log("installing");
      const appId = appIdOnDevice(d, cli.platform!, device, artifact);
      // The plugin pushes Seerr as 127.0.0.1:<seerrPort>, which on ANY Android emulator
      // means the emulator's own loopback — both phone and TV need the reverse mapping
      // to reach the host fixture. Reuse an identical mapping, abort on a conflicting
      // one, and never remove a mapping that predates this run.
      if (cli.platform === "android" || cli.platform === "android-tv") {
        const reverses = must(
          d.exec(["adb", "-s", device, "reverse", "--list"]),
          "adb reverse --list",
        );
        const seerrPort = baseEnv.MAESTRO_SEERR_URL.split(":").pop()!;
        let mapped = false;
        for (const line of reverses.split("\n")) {
          const ports = line.match(/\btcp:(\d+)\s+tcp:(\d+)\b/);
          if (!ports || ports[1] !== seerrPort) continue;
          if (ports[2] !== seerrPort)
            throw new ShotError(
              `adb reverse tcp:${seerrPort} is held by a mapping to tcp:${ports[2]} — refusing to shadow it`,
            );
          mapped = true;
        }
        if (!mapped)
          must(
            d.exec([
              "adb",
              "-s",
              device,
              "reverse",
              `tcp:${seerrPort}`,
              `tcp:${seerrPort}`,
            ]),
            "adb reverse seerr",
          );
      }
      const env = {
        ...baseEnv,
        MAESTRO_APP_ID: appId,
        MAESTRO_DEV_CLIENT_URL: devClientUrl(cli.platform!, port),
      };
      d.log("starting Metro");
      // Metro's cache keys on file content and transformer config, but Expo needs
      // --clear after a babel config change; later refs clear only when those inputs
      // differ (diff exit 1), a nonzero exit for any other reason clears too.
      let clear = true;
      if (refIndex > 0)
        clear =
          d.exec(
            [
              "git",
              "diff",
              "--quiet",
              refs[refIndex - 1].sha,
              ref.sha,
              "--",
              "babel.config.js",
              "metro.config.js",
              "bun.lock",
            ],
            { cwd: repo },
          ).code !== 0;
      metro = await startMetro(
        d,
        repo,
        spec,
        port,
        `${sessionDir}/metro-${ref.label}.log`,
        clear,
      );
      try {
        // Prove this Metro serves the checked-out ref's JS — /status alone says only
        // that a packager answers. A compile error in the switched ref fails here,
        // before any screenshot is taken.
        const bundleStart = Date.now();
        const bundled = await d.waitFor(
          metroBundleUrl(spec.fingerprintPlatform, port),
          "__BUNDLE_START_TIME__",
          METRO_BUNDLE_TIMEOUT_MS,
        );
        const bundleElapsed = Date.now() - bundleStart;
        if (!bundled)
          throw new ShotError(
            `Metro on ${port} is up but did not bundle ${spec.fingerprintPlatform} JS for the switched ref in ${formatElapsed(bundleElapsed)}`,
          );
        d.log(
          `Metro bundled ${spec.fingerprintPlatform} JS in ${formatElapsed(bundleElapsed)}`,
        );
        for (const capture of ref.captures) {
          passLabel = capture;
          d.log(`capturing ${capture}`);
          const outDir = `${sessionDir}/${capture}`;
          for (let attempt = 0; attempt < 2; attempt++) {
            d.fs.mkdir(outDir);
            // Every pass is a first run: fresh state, then the deep link that points
            // the dev client at this ref's Metro — the flows themselves carry no
            // clearState, because wiping state would also wipe the URL the link just
            // set.
            resetTestAppState(d, cli.platform!, device, appId, artifact);
            launchDevClient(d, cli.platform!, device, appId, port);
            try {
              const reinstallDriver = firstPass;
              firstPass = false;
              runCapture(
                d,
                tooling,
                spec,
                device,
                outDir,
                env,
                maestro,
                reinstallDriver,
              );
              break;
            } catch (error) {
              // Maestro's iOS XCTest driver can die mid-pass while the app and the
              // flow are still fine; the pass is stateless, so retry it once. The
              // failed dir moves out as a sibling: compare.ts walks outDir
              // recursively, so it must never nest inside it.
              const log = `${outDir}/maestro.log`;
              const driverLost =
                d.fs.exists(log) &&
                d.fs.read(log).includes("DeviceUnreachableException");
              if (attempt > 0 || !driverLost) {
                // A pass dying under a system ANR dialog leaves no trace of which
                // process hung; dump the device state before the error aborts the run.
                if (cli.platform === "android" || cli.platform === "android-tv")
                  writeAndroidDiagnostics(d, device, outDir);
                throw error;
              }
              d.log(
                `maestro driver unreachable during ${capture}; the pass is retried once`,
              );
              d.fs.mv(outDir, `${sessionDir}/${capture}-failed-1`);
            }
          }
        }
        // A build or Metro failure between refs is not a pass failure.
        passLabel = undefined;
      } finally {
        metro.kill();
        metro = undefined;
      }
    }
    const spec_masks = `${tooling}/${spec.masks}`;
    d.log("comparing");
    must(
      d.exec(
        [
          "bun",
          `${tooling}/compare.ts`,
          "--before",
          `${sessionDir}/before`,
          "--noise",
          `${sessionDir}/noise`,
          "--after",
          `${sessionDir}/after`,
          "--masks",
          spec_masks,
          "--evidence",
          `${sessionDir}/evidence`,
          "--out",
          `${sessionDir}/report`,
        ],
        { cwd: repo },
      ),
      "compare",
    );
    return { sessionDir, beforeSha, afterSha, restored: start };
  } catch (error) {
    reportFailure(error);
    throw error;
  } finally {
    setInterruptCleanup(undefined);
    cleanup();
  }
}

/**
 * A failed run's report: the thrown error, the pass it died in when one was running,
 * and the failing Maestro step from that pass's debug output — its screenshot and
 * screen hierarchy copied into report/failure and referenced from there. On success
 * nothing is written: compare.ts owns report/summary.md.
 */
function writeFailureSummary(
  d: Deps,
  sessionDir: string,
  platform: Platform,
  pass: string | undefined,
  error: unknown,
  secrets: string[],
): void {
  const message = mask(
    error instanceof Error ? error.message : String(error),
    secrets,
  );
  const lines = [
    `## Screenshot run failed (${platform})`,
    "",
    ...(pass ? [`**Pass:** ${pass}`, ""] : []),
    "```",
    message,
    "```",
  ];
  const step = pass ? failedStep(d, `${sessionDir}/${pass}`) : undefined;
  if (step) {
    const failureDir = `${sessionDir}/report/failure`;
    d.fs.mkdir(failureDir);
    const shown = { ...step, message: mask(step.message, secrets) };
    for (const key of ["screenshot", "hierarchy"] as const) {
      const src = step[key];
      if (!src || !d.fs.exists(src)) continue;
      const dest = `${failureDir}/${src.split("/").pop()}`;
      d.fs.cp(src, dest);
      shown[key] = dest;
    }
    lines.push("", `**Failed step:** ${describeFailedStep(shown, sessionDir)}`);
  }
  d.fs.mkdir(`${sessionDir}/report`);
  d.fs.write(`${sessionDir}/report/summary.md`, `${lines.join("\n")}\n`);
}

export function doctor(
  d: Deps,
  cli: Cli,
  repo: string,
): { ok: boolean; checks: string[] } {
  const checks: string[] = [];
  const status = must(
    d.exec(["git", "status", "--porcelain", "--untracked-files=all"], {
      cwd: repo,
    }),
    "git status",
  );
  checks.push(
    status
      ? `tree dirty (${status.split("\n").length} entries) — run refuses until clean`
      : "tree clean",
  );
  let fixture = fixtureChecks(d, repo);
  if (cli.fix && fixture.some((check) => check.includes("NOT"))) {
    d.log("fix: bringing up the local fixture");
    ensureFixture(d, repo);
    fixture = fixtureChecks(d, repo);
  }
  checks.push(...fixture);
  const tools = `${repo}/${REPORTS_DIR}/tools`;
  if (cli.fix && !d.fs.exists(maestroBinary(tools))) {
    d.log(`fix: installing maestro ${MAESTRO_TAG}`);
    ensureMaestro(d, tools);
  }
  checks.push(
    d.fs.exists(maestroBinary(tools))
      ? `maestro ${MAESTRO_TAG} installed`
      : `maestro ${MAESTRO_TAG} NOT installed`,
  );
  const ok = checks.every((check) => !check.includes("NOT"));
  return { ok, checks };
}
