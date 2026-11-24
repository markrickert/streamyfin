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
  must,
  type Platform,
  ShotError,
  type SpawnHandle,
} from "./core";
import {
  ensurePortFree,
  prepareDevice,
  restoreDevice,
  selectDevice,
} from "./device";
import { ensureFixture, fixtureChecks, fixtureEnv } from "./fixture";
import {
  backupNativeDirs,
  type GitStart,
  lockfileChanged,
  preflight,
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

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
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
  ensureOutIgnored(d, repo, sessionDir);
  d.fs.mkdir(sessionDir);
  const tooling = snapshotTooling(d, repo, sessionDir);
  const maestro = ensureMaestro(d, `${repo}/${REPORTS_DIR}/tools`);
  ensureFixture(d, repo);
  // Capture the fixture contract while the checkout that produced it is still on disk:
  // .state/ and .env are gitignored, so they survive the switch — but an absent or
  // changed file on the other ref must never be re-read mid-run.
  const baseEnv = fixtureEnv(d, repo, cli.platform!);

  let metro: SpawnHandle | undefined;
  let nativeMoved: string[] = [];
  let buildDeps = "";
  // Nested: a refused git restore (new user edits mid-run) must not strand the
  // native dirs in the backup.
  const cleanup = (): void => {
    metro?.kill();
    metro = undefined;
    restoreDevice(d, cli.platform!, device);
    try {
      restoreGit(d, repo, start);
      // node_modules still holds the last switched ref's lockfile. Logged, not thrown:
      // a throw here would hide the error this cleanup runs after.
      if (buildDeps && lockfileChanged(d, repo, buildDeps)) {
        const install = d.exec(["bun", "install", "--frozen-lockfile"], {
          cwd: repo,
        });
        if (install.code !== 0)
          d.log(
            `bun install failed while restoring ${start.ref}; run it by hand before anything else: ${install.stderr.trim().slice(0, 200)}`,
          );
      }
    } finally {
      if (nativeMoved.length)
        restoreNativeDirs(d, repo, sessionDir, nativeMoved);
    }
  };
  setInterruptCleanup(cleanup);
  try {
    prepareDevice(d, cli.platform!, device);
    const abi =
      cli.platform === "android" || cli.platform === "android-tv"
        ? deviceAbi(d, device)
        : undefined;
    const refs: { label: string; sha: string; captures: string[] }[] = [
      { label: "before", sha: beforeSha, captures: ["before", "noise"] },
      { label: "after", sha: afterSha, captures: ["after"] },
    ];
    const buildCacheManifest: BuildCacheManifestEntry[] = [];
    for (const ref of refs) {
      must(
        d.exec(["git", "switch", "--detach", ref.sha], { cwd: repo }),
        `git switch ${ref.label}`,
      );
      if (lockfileChanged(d, repo, buildDeps))
        must(
          d.exec(["bun", "install", "--frozen-lockfile"], { cwd: repo }),
          "bun install --frozen-lockfile",
        );
      buildDeps = ["bun.lock", "package.json"]
        .map((n) =>
          d.fs.exists(`${repo}/${n}`) ? d.fs.read(`${repo}/${n}`) : "",
        )
        .join("\n---\n");
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
              d.exec(["pod", "install"], { cwd: `${repo}/ios` }),
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
      metro = await startMetro(d, repo, spec, port);
      try {
        // Prove this Metro serves the checked-out ref's JS — /status alone says only
        // that a packager answers. A compile error in the switched ref fails here,
        // before any screenshot is taken.
        const bundled = await d.waitFor(
          metroBundleUrl(spec.fingerprintPlatform, port),
          "__BUNDLE_START_TIME__",
          300_000,
        );
        if (!bundled)
          throw new ShotError(
            `Metro on ${port} is up but did not bundle ${spec.fingerprintPlatform} JS for the switched ref`,
          );
        for (const capture of ref.captures) {
          d.log(`capturing ${capture}`);
          const outDir = `${sessionDir}/${capture}`;
          d.fs.mkdir(outDir);
          // Every pass is a first run: fresh state, then the deep link that points the
          // dev client at this ref's Metro — the flows themselves carry no clearState,
          // because wiping state would also wipe the URL the link just set.
          resetTestAppState(d, cli.platform!, device, appId, artifact);
          launchDevClient(d, cli.platform!, device, appId, port);
          runCapture(d, tooling, spec, device, outDir, env, maestro);
        }
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
  } finally {
    setInterruptCleanup(undefined);
    cleanup();
  }
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
