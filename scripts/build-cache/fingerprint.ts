/**
 * Generates `@expo/fingerprint` hashes matching the CI `fingerprint` job.
 *
 * This file is the single owner of the Android ignore paths passed to
 * `@expo/fingerprint` so CI and local tooling never compute different hashes.
 */
import { defaultRun, type RunProcess, repoRoot } from "./process";
import type { Form, Os } from "./variants";

const ANDROID_IGNORE_PATHS: readonly string[] = [
  "scripts/ios/**/*",
  "targets/**/*",
];

export interface FingerprintDeps {
  run?: RunProcess;
  env?: Record<string, string | undefined>;
}

interface FingerprintOutput {
  hash?: unknown;
  sources?: Array<{ id?: unknown }>;
}

/** Computes the native fingerprint hash for an OS and form factor. */
export const hashFor = (
  { os, form }: { os: Os; form: Form },
  deps: FingerprintDeps = {},
): string => {
  const run = deps.run ?? defaultRun;
  const baseEnv = deps.env ?? process.env;
  const args = ["@expo/fingerprint", "fingerprint:generate", "--platform", os];
  if (os === "android") {
    for (const pattern of ANDROID_IGNORE_PATHS) {
      args.push("--ignore-path", pattern);
    }
  }

  const result = run("bunx", args, {
    cwd: repoRoot(),
    env: { ...baseEnv, EXPO_TV: form === "tv" ? "1" : "0" },
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${String(result.status)}`;
    throw new Error(
      `Failed to generate ${os} (${form}) fingerprint: ${detail}`,
    );
  }

  const parsed = JSON.parse(result.stdout) as FingerprintOutput;
  const hasExpoConfig =
    Array.isArray(parsed.sources) &&
    parsed.sources.some((source) => source?.id === "expoConfig");
  if (!hasExpoConfig) {
    throw new Error(
      `The ${os} fingerprint has no Expo config, so no earlier build is reused.`,
    );
  }
  if (typeof parsed.hash !== "string" || parsed.hash.length === 0) {
    throw new Error(`The ${os} fingerprint output is missing a valid hash.`);
  }
  return parsed.hash;
};
