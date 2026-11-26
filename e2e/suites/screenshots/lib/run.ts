import { resetTestAppState } from "./app-state";
import {
  appIdOnDevice,
  type BuildSource,
  capturesRelease,
  deviceAbi,
  ensureDebugBuild,
  ensureReleaseBuild,
  nativeFingerprint,
} from "./build";
import {
  devClientUrl,
  launchDevClient,
  passTimeoutSeconds,
  runCapture,
  startMetro,
} from "./capture";
import { type PlatformSpec, platformSpec } from "./cli";
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
import {
  ensureFixture,
  fixtureChecks,
  fixtureDotenv,
  fixtureEnv,
  jellyfinHealthy,
  stderrTail,
} from "./fixture";
import {
  backupNativeDirs,
  type GitStart,
  lockfileChanged,
  preflight,
  readBuildDeps,
  restoreGit,
  restoreNativeDirs,
} from "./git";
import { ensureRepackApp, repackAppVersion, repackForRef } from "./repack";
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

export interface BuildReport {
  sessionDir: string;
  builds: BuildCacheManifestEntry[];
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

/** What a ref-switching command accumulates so its cleanup can undo the run. */
interface RefSwitchState {
  /** Native dirs moved into the session backup before the first prebuild. */
  nativeMoved: string[];
  /** The last switched ref's bun.lock + package.json, for the restore install. */
  buildDeps: string;
  /** Only restore git after a `git switch --detach` actually ran. */
  switched: boolean;
}

/**
 * `git switch --detach` plus `bun install` when the ref's build deps differ, then a
 * re-read of them. The switched flag is set before the install so a refused install
 * still unwinds the switch.
 */
function switchRef(
  d: Deps,
  repo: string,
  state: RefSwitchState,
  label: string,
  sha: string,
): void {
  must(
    d.exec(["git", "switch", "--detach", sha], { cwd: repo }),
    `git switch ${label}`,
  );
  state.switched = true;
  if (lockfileChanged(d, repo, state.buildDeps))
    must(
      d.exec(["bun", "install", "--frozen-lockfile"], { cwd: repo }),
      "bun install --frozen-lockfile",
    );
  state.buildDeps = readBuildDeps(d, repo);
}

/**
 * The per-ref native build shared by `run` and `build`: fingerprint, then the cached
 * or freshly built debug client. A real build runs prebuild (and pod install on Apple)
 * after the user's native dirs are moved into the session backup.
 */
function buildForRef(
  d: Deps,
  repo: string,
  sessionDir: string,
  spec: PlatformSpec,
  platform: Platform,
  state: RefSwitchState,
  label: string,
  abi: string | undefined,
): { artifact: string; source: BuildSource; hash: string } {
  const fingerprint = nativeFingerprint(d, repo, spec);
  const shortHash = fingerprint.slice(0, 8);
  const buildStarted = Date.now();
  d.log(`building ${label} (${platform}, fingerprint ${shortHash})`);
  // The release platform builds the repack's native base; everything else still
  // builds the debug dev client Metro serves.
  const ensure = capturesRelease(platform)
    ? ensureReleaseBuild
    : ensureDebugBuild;
  const { artifact, source, hash } = ensure(
    d,
    repo,
    platform,
    spec,
    fingerprint,
    sessionDir,
    () => {
      if (!state.nativeMoved.length)
        state.nativeMoved = backupNativeDirs(d, repo, sessionDir);
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
    `building ${label} (${platform}, fingerprint ${shortHash}): ${source} (${formatElapsed(Date.now() - buildStarted)})`,
  );
  return { artifact, source, hash };
}

function recordBuild(
  d: Deps,
  sessionDir: string,
  manifest: BuildCacheManifestEntry[],
  entry: BuildCacheManifestEntry,
): void {
  manifest.push(entry);
  d.fs.write(
    `${sessionDir}/build-cache.json`,
    JSON.stringify(manifest, null, 2),
  );
}

/**
 * Ref and dependency restore shared by `run` and `build`. Nested: a refused git
 * restore (new user edits mid-run) must not strand the native dirs in the backup.
 */
function restoreAfterSwitches(
  d: Deps,
  repo: string,
  sessionDir: string,
  start: GitStart,
  state: RefSwitchState,
): void {
  try {
    // A failure before the first `git switch --detach` leaves the tree on the
    // starting ref already: switching back would be a switch the run never made.
    if (state.switched) {
      restoreGit(d, repo, start);
      // node_modules still holds the last switched ref's lockfile. Logged, not
      // thrown: a throw here would hide the error this cleanup runs after.
      if (state.buildDeps && lockfileChanged(d, repo, state.buildDeps)) {
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
    if (state.nativeMoved.length)
      restoreNativeDirs(d, repo, sessionDir, state.nativeMoved);
  }
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
  const release = capturesRelease(cli.platform!);
  const { beforeSha, afterSha, start } = preflight(d, repo, cli);
  const device = selectDevice(d, cli.platform!, cli.device);
  const port = cli.port ?? DEFAULT_PORT;
  // A release run never binds a Metro port, so a busy one must not refuse it.
  if (!release) ensurePortFree(d, port);
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
  const refState: RefSwitchState = {
    nativeMoved: [],
    buildDeps: "",
    switched: false,
  };
  const deviceState = newDeviceState();
  const cleanup = (): void => {
    metro?.kill();
    metro = undefined;
    restoreDevice(d, cli.platform!, device, deviceState);
    restoreAfterSwitches(d, repo, sessionDir, start, refState);
  };
  ensureOutIgnored(d, repo, sessionDir);
  setInterruptCleanup(cleanup);
  try {
    d.fs.mkdir(sessionDir);
    outReady = true;
    const tooling = snapshotTooling(d, repo, sessionDir, release);
    const maestro = ensureMaestro(d, `${repo}/${REPORTS_DIR}/tools`);
    ensureFixture(d, repo);
    // Capture the fixture contract while the checkout that produced it is still on
    // disk: .state/ and .env are gitignored, so they survive the switch — but an
    // absent or changed file on the other ref must never be re-read mid-run.
    const baseEnv = fixtureEnv(d, repo, cli.platform!);
    secrets = [baseEnv.MAESTRO_JELLYFIN_PASS, baseEnv.MAESTRO_SEERR_PASS];
    // The pass-retry probe reads the Jellyfin port from the same pre-switch .env;
    // the host always reaches the fixture over loopback.
    const { SYNCPLAY_PORT: jellyfinPort } = fixtureDotenv(d, repo);
    // The repack tooling reads the starting checkout's package.json, so it must be
    // pinned before the first ref switch replaces node_modules.
    if (release) ensureRepackApp(d, tooling, repackAppVersion(d, repo));

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
      switchRef(d, repo, refState, ref.label, ref.sha);
      const { artifact, source, hash } = buildForRef(
        d,
        repo,
        sessionDir,
        spec,
        cli.platform!,
        refState,
        ref.label,
        abi,
      );
      recordBuild(d, sessionDir, buildCacheManifest, {
        ref: ref.label,
        platform: cli.platform!,
        hash,
        source,
        // The manifest records the native base — it is what the run-scoped cache
        // shares; the repacked APK below is session-local and never uploaded.
        path: artifact,
      });
      // A release run installs the base with the ref's JS repacked in, never the
      // base itself. The noise pass simply reuses before's repack: same ref.
      let installed = artifact;
      if (release) {
        d.log(`repacking ${ref.label}`);
        installed = repackForRef(
          d,
          repo,
          spec,
          artifact,
          sessionDir,
          tooling,
          ref.label,
        );
      }
      d.log("installing");
      const appId = appIdOnDevice(d, cli.platform!, device, installed);
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
        // A release app has no dev client to point at Metro; the flows' dev-overlay
        // branches are `when: visible` and simply never fire.
        ...(release
          ? {}
          : { MAESTRO_DEV_CLIENT_URL: devClientUrl(cli.platform!, port) }),
      };
      if (!release) {
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
      }
      try {
        if (!release) {
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
        }
        for (const capture of ref.captures) {
          passLabel = capture;
          d.log(`capturing ${capture}`);
          const outDir = `${sessionDir}/${capture}`;
          for (let attempt = 0; attempt < 2; attempt++) {
            d.fs.mkdir(outDir);
            // Every pass is a first run: fresh state, then on the debug path the deep
            // link that points the dev client at this ref's Metro — the flows
            // themselves carry no clearState, because wiping state would also wipe
            // the URL the link just set.
            resetTestAppState(d, cli.platform!, device, appId, installed);
            if (!release)
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
              if (attempt === 0 && driverLost) {
                d.log(
                  `maestro driver unreachable during ${capture}; the pass is retried once`,
                );
                d.fs.mv(outDir, `${sessionDir}/${capture}-failed-1`);
                continue;
              }
              // Jellyfin 10.11.x and 12.0 can terminate on a client's WebSocket
              // close (jellyfin/jellyfin#18053): the app then dies on "Server
              // unreachable" — fixture state, not app state — so a restart earns
              // one retry, inside the same per-pass budget as the driver retry.
              const fixtureDown = !jellyfinHealthy(d, jellyfinPort);
              if (attempt > 0 || !fixtureDown) {
                // A pass dying under a system ANR dialog leaves no trace of which
                // process hung; dump the device state before the error aborts the run.
                if (cli.platform === "android" || cli.platform === "android-tv")
                  writeAndroidDiagnostics(d, device, outDir);
                if (fixtureDown)
                  throw new ShotError(
                    `${error instanceof Error ? error.message : String(error)} (Jellyfin fixture unreachable after the pass)`,
                  );
                throw error;
              }
              d.log(
                `Jellyfin fixture died during ${capture}; restarting it and retrying the pass once`,
              );
              const setup = d.exec(["bun", "run", "e2e:setup"], { cwd: repo });
              const passError =
                error instanceof Error ? error.message : String(error);
              if (setup.code !== 0)
                throw new ShotError(
                  `pass ${capture} failed (${passError}) and the Jellyfin fixture restart failed too (${stderrTail(setup.stderr)})`,
                );
              if (!jellyfinHealthy(d, jellyfinPort))
                throw new ShotError(
                  `pass ${capture} failed (${passError}) and the Jellyfin fixture is still unreachable after e2e:setup`,
                );
              d.fs.mv(outDir, `${sessionDir}/${capture}-failed-1`);
            }
          }
        }
        // A build or Metro failure between refs is not a pass failure.
        passLabel = undefined;
      } finally {
        metro?.kill();
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
 * `build`: produce both refs' debug clients without a device, fixture or Maestro —
 * the native half of a comparison run. CI runs it once per platform so `repeat`
 * capture jobs all reuse the same builds through the run-scoped cache artifact.
 * Same ref-switching and restoration as runComparison.
 */
export function buildNative(d: Deps, cli: Cli, repo: string): BuildReport {
  const spec = platformSpec(cli.platform!);
  const { beforeSha, afterSha, start } = preflight(d, repo, cli);
  const sessionDir = cli.outDir ?? `${repo}/${REPORTS_DIR}/${Date.now()}`;
  const refState: RefSwitchState = {
    nativeMoved: [],
    buildDeps: "",
    switched: false,
  };
  const cleanup = (): void =>
    restoreAfterSwitches(d, repo, sessionDir, start, refState);
  ensureOutIgnored(d, repo, sessionDir);
  setInterruptCleanup(cleanup);
  try {
    d.fs.mkdir(sessionDir);
    const buildCacheManifest: BuildCacheManifestEntry[] = [];
    for (const ref of [
      { label: "before", sha: beforeSha },
      { label: "after", sha: afterSha },
    ]) {
      switchRef(d, repo, refState, ref.label, ref.sha);
      const { artifact, source, hash } = buildForRef(
        d,
        repo,
        sessionDir,
        spec,
        cli.platform!,
        refState,
        ref.label,
        cli.abi,
      );
      recordBuild(d, sessionDir, buildCacheManifest, {
        ref: ref.label,
        platform: cli.platform!,
        hash,
        source,
        path: artifact,
      });
    }
    return { sessionDir, builds: buildCacheManifest, restored: start };
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
