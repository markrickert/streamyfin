/**
 * Dev-mode screenshot comparison: switch this checkout between two refs, run the same
 * Metro-backed capture on each plus a fresh "noise" pass on the before ref, and compare
 * with compare.ts. Everything that runs a subprocess or touches the filesystem goes
 * through Deps, so the orchestration is testable without a device, git, or Metro.
 * The code lives in lib/, one module per concern; this file re-exports its public API.
 *
 * Invariants the lib/ modules protect:
 * - It never force-switches, stashes, resets, or deletes user files. A dirty tree refuses
 *   before the first `git switch`; restoration on failure/interrupt is `--detach`-safe.
 * - Metro and the build cache are owned by the runner: it only kills a Metro it spawned,
 *   on a port it proved free first, and never touches a preexisting process.
 * - ios/ and android/ are user state: they are moved into the session backup before a
 *   clean prebuild and restored afterwards, never deleted.
 * - Secrets ride process env into run.sh/maestro.py; they are never logged or echoed.
 */

export type { BuildResult, BuildSource } from "./lib/build";
export {
  BUILD_CACHE_FETCH_ENV,
  BUILD_CACHE_FETCH_TIMEOUT_MS,
  ensureDebugBuild,
  nativeFingerprint,
} from "./lib/build";
export {
  parseArgs,
  platformSpec,
} from "./lib/cli";
export type {
  Cli,
  Deps,
  ExecResult,
  FsOps,
  Platform,
  SpawnHandle,
} from "./lib/core";
export {
  PLATFORMS,
  ShotError,
} from "./lib/core";
export {
  ensurePortFree,
  prepareDevice,
  selectDevice,
} from "./lib/device";
export {
  ensureFixture,
  fixtureDotenv,
  fixtureEnv,
} from "./lib/fixture";
export type { GitStart } from "./lib/git";
export {
  gitStart,
  preflight,
} from "./lib/git";
export type { BuildCacheManifestEntry, RunReport } from "./lib/run";
export {
  doctor,
  interruptCleanup,
  runComparison,
  setInterruptCleanup,
} from "./lib/run";
export {
  ensureMaestro,
  ensureOutIgnored,
  MAESTRO_SHA256,
  MAESTRO_TAG,
  snapshotTooling,
} from "./lib/tooling";
