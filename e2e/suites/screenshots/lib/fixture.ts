import { type Deps, hostFor, must, type Platform, ShotError } from "./core";

/** Read the persisted fixture .env, tolerating its absence (doctor runs without one). */
export function fixtureDotenv(d: Deps, repo: string): Record<string, string> {
  const path = `${repo}/e2e/suites/syncplay/.env`;
  if (!d.fs.exists(path)) return {};
  return Object.fromEntries(
    d.fs
      .read(path)
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => line.split("=", 2) as [string, string]),
  );
}

/**
 * Fixture environment for the flows — minus MAESTRO_APP_ID, which differs per built
 * ref. Call it once before the first `git switch`: after the switch the working tree
 * (and with it .state/credentials.json and .env) is the other ref's.
 */
export function fixtureEnv(
  d: Deps,
  repo: string,
  platform: Platform,
): Record<string, string> {
  const state = `${repo}/e2e/suites/syncplay/.state`;
  const credentials = JSON.parse(d.fs.read(`${state}/credentials.json`));
  const dotenv = fixtureDotenv(d, repo);
  for (const key of ["SYNCPLAY_PORT", "SYNCPLAY_SEERR_PORT"] as const)
    if (!/^\d+$/.test(dotenv[key] ?? ""))
      throw new ShotError(
        `fixture .env is missing a numeric ${key} — run e2e:setup before screenshots`,
      );
  const host = hostFor(platform);
  return {
    MAESTRO_JELLYFIN_URL: `http://${host}:${dotenv.SYNCPLAY_PORT}`,
    MAESTRO_JELLYFIN_USER: credentials.host.name,
    MAESTRO_JELLYFIN_PASS: credentials.password,
    MAESTRO_SEERR_URL: `http://${host}:${dotenv.SYNCPLAY_SEERR_PORT}`,
    MAESTRO_SEERR_PASS: credentials.password,
  };
}

/** stderr's tail, where a traceback puts its exception; the … marks the cut. */
export const stderrTail = (stderr: string): string => {
  const trimmed = stderr.trim();
  return trimmed.length > 1500 ? `…${trimmed.slice(-1500)}` : trimmed;
};

/** Whether the Jellyfin fixture answers 200 on /health, probed from the host. */
export function jellyfinHealthy(d: Deps, port: string): boolean {
  const result = d.exec([
    "curl",
    "-fsS",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    `http://127.0.0.1:${port}/health`,
  ]);
  return result.stdout.trim() === "200";
}

export function ensureFixture(d: Deps, repo: string): void {
  for (const step of ["e2e:setup", "e2e:seed", "e2e:enrich"]) {
    let result = d.exec(["bun", "run", step], { cwd: repo });
    if (result.code !== 0 && step === "e2e:enrich") {
      // e2e:enrich only queues refreshes for what is still missing, so a failed run is
      // safe to retry once: Jellyfin may just be busy ingesting catalog people.
      d.log(`${step} failed; retrying once (${stderrTail(result.stderr)})`);
      result = d.exec(["bun", "run", step], { cwd: repo });
    }
    if (result.code !== 0)
      throw new ShotError(
        `${step} failed; the local fixture is not ready (${stderrTail(result.stderr)})`,
      );
  }
  must(
    d.exec(
      [
        "env",
        "PYTHONPATH=e2e",
        "python3",
        "-c",
        "from suites.syncplay import seerr, setup; seerr.enable_catalog_libraries(setup.identity()); seerr.provision_client_access(setup.identity())",
      ],
      { cwd: repo },
    ),
    "seerr catalog + client provisioning",
  );
}

/** Re-reads .env each call: e2e:setup may have just written it. */
export function fixtureChecks(d: Deps, repo: string): string[] {
  const dotenv = fixtureDotenv(d, repo);
  const jellyfinPort = dotenv.SYNCPLAY_PORT ?? "18096";
  const seerrPort = dotenv.SYNCPLAY_SEERR_PORT ?? "15055";
  const seerr = d.exec([
    "curl",
    "-fsS",
    `http://127.0.0.1:${seerrPort}/api/v1/settings/public`,
  ]);
  return [
    jellyfinHealthy(d, jellyfinPort)
      ? "jellyfin fixture healthy"
      : `jellyfin fixture NOT reachable at :${jellyfinPort}`,
    seerr.code === 0 && seerr.stdout.includes('"initialized":true')
      ? "seerr fixture initialized"
      : "seerr fixture NOT initialized",
  ];
}
