import { type PlatformSpec } from "./cli";
import {
  type Deps,
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

function flowArgv(
  tooling: string,
  flow: string,
  device: string,
  outDir: string,
  env: Record<string, string>,
  maestro: string,
  timeoutSeconds: number,
  maestroPlatform?: "tvos",
): string[] {
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
    String(timeoutSeconds),
  ];
  argv.push("--maestro", maestro);
  if (maestroPlatform) argv.push("--platform", maestroPlatform);
  argv.push("--env", `MAESTRO_TVOS=${maestroPlatform === "tvos" ? "1" : "0"}`);
  for (const [key, value] of Object.entries(env))
    argv.push("--env", `${key}=${value}`);
  return argv;
}

function runFlow(
  d: Deps,
  tooling: string,
  flow: string,
  device: string,
  outDir: string,
  env: Record<string, string>,
  maestro: string,
  timeoutSeconds: number,
  maestroPlatform?: "tvos",
): void {
  // The env map reaches maestro.py through argv; it is never printed by this runner,
  // and a failing flow's stderr is stripped of credentials before it is thrown.
  mustSanitized(
    d.exec(
      flowArgv(
        tooling,
        flow,
        device,
        outDir,
        env,
        maestro,
        timeoutSeconds,
        maestroPlatform,
      ),
    ),
    `flow ${flow}`,
    [env.MAESTRO_JELLYFIN_PASS, env.MAESTRO_SEERR_PASS],
  );
}

export async function startMetro(
  d: Deps,
  repo: string,
  spec: PlatformSpec,
  port: number,
): Promise<SpawnHandle> {
  // TOCTOU: the preflight check ran minutes ago; re-verify immediately before bind so
  // a foreign Metro that grabbed the port meanwhile aborts the run instead of being
  // adopted as ours. EXPO_NO_INTERACTIVE keeps Expo from auto-hopping to a free port.
  ensurePortFree(d, port);
  const metro = d.spawn(
    [
      "bunx",
      "expo",
      "start",
      "--dev-client",
      "--port",
      String(port),
      "--clear",
    ],
    {
      cwd: repo,
      env: { EXPO_TV: spec.tv ? "1" : "0", EXPO_NO_INTERACTIVE: "1" },
    },
  );
  const up = await d.waitFor(
    `http://127.0.0.1:${port}/status`,
    "packager-status:running",
    120_000,
  );
  // /status answering while OUR child is dead means a foreign packager satisfied the
  // probe — never treat it as ours.
  if (!up || !metro.isAlive()) {
    metro.kill();
    throw new ShotError(
      `Metro did not report packager-status:running on port ${port}`,
    );
  }
  return metro;
}

export function runCapture(
  d: Deps,
  tooling: string,
  spec: PlatformSpec,
  device: string,
  outDir: string,
  env: Record<string, string>,
  maestro: string,
): void {
  // One parent flow per pass: a failing nested flow then aborts the whole pass, and the
  // capture order lives in the YAML next to the flows it sequences, not in two places.
  runFlow(
    d,
    tooling,
    spec.tv ? "pass-tv" : "pass-mobile",
    device,
    outDir,
    env,
    maestro,
    passTimeoutSeconds(d),
    spec.maestroPlatform,
  );
}
