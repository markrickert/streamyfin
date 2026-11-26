import { type PlatformSpec } from "./cli";
import {
  type Deps,
  formatElapsed,
  hostFor,
  must,
  mustSanitized,
  type Platform,
  ShotError,
  type SpawnHandle,
} from "./core";
import { ensurePortFree } from "./device";

// SDK 58 dev-client deep link: __expo_url pins Metro, the disable flags skip the
// one-time onboarding sheet and hide the dev client's floating menu button
// (expo.dev/changelog/sdk-58). The app's scheme is `streamyfin`.
export const devClientUrl = (platform: Platform, port: number) =>
  `streamyfin://?__expo_url=${encodeURIComponent(`http://${hostFor(platform)}:${port}`)}&__expo_disable_onboarding=1&__expo_disable_fab=1`;

/** Env var overriding Maestro's per-pass timeout in seconds. */
export const PASS_TIMEOUT_ENV = "SHOTS_PASS_TIMEOUT_SECONDS";

/** Default per-pass timeout in seconds, matching maestro.py's bound for local runs. */
export const DEFAULT_PASS_TIMEOUT_SECONDS = 900;

export function passTimeoutSeconds(d: Deps): number {
  const raw = d.env[PASS_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_PASS_TIMEOUT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new ShotError(
      `${PASS_TIMEOUT_ENV} must be a positive number of seconds (got '${raw}')`,
    );
  return seconds;
}

export function launchDevClient(
  d: Deps,
  platform: Platform,
  device: string,
  appId: string,
  port: number,
): void {
  const url = devClientUrl(platform, port);
  // adb joins argv into one remote shell command — the & in the URL would split it
  // and turn -p into a second command, so the -d value must be remote-quoted.
  const quotedUrl = `'${url.replaceAll("'", "'\\''")}'`;
  if (platform === "android" || platform === "android-tv")
    must(
      d.exec([
        "adb",
        "-s",
        device,
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        quotedUrl,
        "-p",
        appId,
      ]),
      "launch dev client",
    );
  else
    must(
      d.exec(["xcrun", "simctl", "openurl", device, url]),
      "openurl dev client",
    );
}

/** Expo CLI's startup network calls have stalled past 120 s on the macOS CI runner. */
const METRO_STATUS_TIMEOUT_MS = 300_000;

export async function startMetro(
  d: Deps,
  repo: string,
  spec: PlatformSpec,
  port: number,
  logFile: string,
  clear: boolean,
): Promise<SpawnHandle> {
  // TOCTOU: the preflight check ran minutes ago; re-verify immediately before bind so
  // a foreign Metro that grabbed the port meanwhile aborts the run instead of being
  // adopted as ours. EXPO_NO_INTERACTIVE keeps Expo from auto-hopping to a free port.
  // The runner needs no Expo network calls, and they have stalled Metro's start on CI.
  ensurePortFree(d, port);
  const metro = d.spawn(
    [
      "bunx",
      "expo",
      "start",
      "--dev-client",
      "--port",
      String(port),
      ...(clear ? ["--clear"] : []),
    ],
    {
      cwd: repo,
      env: {
        EXPO_TV: spec.tv ? "1" : "0",
        EXPO_NO_INTERACTIVE: "1",
        EXPO_OFFLINE: "1",
        EXPO_NO_TELEMETRY: "1",
      },
      logFile,
    },
  );
  const statusStart = Date.now();
  const up = await d.waitFor(
    `http://127.0.0.1:${port}/status`,
    "packager-status:running",
    METRO_STATUS_TIMEOUT_MS,
  );
  const statusElapsed = Date.now() - statusStart;
  // /status answering while OUR child is dead means a foreign packager satisfied the
  // probe — never treat it as ours.
  if (!up || !metro.isAlive()) {
    metro.kill();
    throw new ShotError(
      `Metro did not report packager-status:running on port ${port} in ${formatElapsed(statusElapsed)}`,
    );
  }
  d.log(`Metro up in ${formatElapsed(statusElapsed)}`);
  return metro;
}

// The pinned plexinc/Maestro fork reads MAESTRO_OPTIONAL_LOOKUP_TIMEOUT_MS in
// Orchestra.kt: the ceiling for each absent `when: visible` or `optional` lookup.
const OPTIONAL_LOOKUP_TIMEOUT_MS = "3000";

export function runCapture(
  d: Deps,
  tooling: string,
  spec: PlatformSpec,
  device: string,
  outDir: string,
  env: Record<string, string>,
  maestro: string,
  reinstallDriver: boolean,
): void {
  // One parent flow per pass: a failing nested flow then aborts the whole pass, and the
  // capture order lives in the YAML next to the flows it sequences, not in two places.
  const flow = spec.tv ? "pass-tv" : "pass-mobile";
  const argv = [
    "python3",
    `${tooling}/maestro.py`,
    "--flow",
    `${tooling}/flows/${flow}.yml`,
    "--out",
    outDir,
    "--device",
    device,
    "--timeout",
    String(passTimeoutSeconds(d)),
    "--maestro",
    maestro,
  ];
  if (!reinstallDriver) argv.push("--no-reinstall-driver");
  if (spec.maestroPlatform) argv.push("--platform", spec.maestroPlatform);
  argv.push(
    "--env",
    `MAESTRO_TVOS=${spec.maestroPlatform === "tvos" ? "1" : "0"}`,
  );
  for (const [key, value] of Object.entries(env))
    argv.push("--env", `${key}=${value}`);
  // The env map reaches maestro.py through argv; it is never printed by this runner,
  // and a failing flow's stderr is stripped of credentials before it is thrown.
  mustSanitized(
    d.exec(argv, {
      env: { MAESTRO_OPTIONAL_LOOKUP_TIMEOUT_MS: OPTIONAL_LOOKUP_TIMEOUT_MS },
    }),
    `flow ${flow}`,
    [env.MAESTRO_JELLYFIN_PASS, env.MAESTRO_SEERR_PASS],
  );
}
