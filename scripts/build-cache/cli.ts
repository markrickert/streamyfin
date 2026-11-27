/**
 * CLI entrypoint for the native build cache.
 *
 * Subcommands:
 *   bun scripts/build-cache/cli.ts hash <os> <form>
 *   bun scripts/build-cache/cli.ts name <variantId> [hash]
 *   bun scripts/build-cache/cli.ts fallback-name <variantId> <runId> <attempt>
 *   bun scripts/build-cache/cli.ts outputs ios=<hash> tv=<hash> android=<hash> android_tv=<hash>
 *   bun scripts/build-cache/cli.ts fetch <variantId>
 *   bun scripts/build-cache/cli.ts repack <variantId> <source> <output> [--sentry]
 *   bun scripts/build-cache/cli.ts needs-build <variantId> [hash]
 *   bun scripts/build-cache/cli.ts prune
 *
 * Exit codes:
 *   0   Success (or `prune` removed entries with nothing skipped)
 *   1   `prune` skipped one or more entries, or unexpected runtime error
 *   2   Cache miss (`fetch`, `repack`, `name`, or `needs-build` lookup/hash failure)
 *   64  Usage error (unknown command, missing/invalid args, unknown variantId)
 *
 * Exit 2 means a cache miss; callers must build normally on any non-zero exit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchVariant, prune } from "./fetch";
import { hashFor } from "./fingerprint";
import {
  type FetchLike,
  fetchPullRequestCommits,
  listArtifacts,
} from "./github";
import { needsBuild, type RunContext } from "./pick";
import { repoRoot } from "./process";
import { repackVariant } from "./repack";
import {
  artifactName,
  type Form,
  type Os,
  VARIANTS,
  type Variant,
  variantById,
} from "./variants";

export interface CliDeps {
  fetchVariant?: typeof fetchVariant;
  repackVariant?: typeof repackVariant;
  prune?: typeof prune;
  hashFor?: typeof hashFor;
  fetch?: FetchLike;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  env?: Record<string, string | undefined>;
}

class UsageError extends Error {}
class MissError extends Error {}

const validVariantIds = (): string => VARIANTS.map((v) => v.id).join(", ");

const parseOs = (value: string | undefined): Os => {
  if (value === "ios" || value === "android") return value;
  throw new UsageError(`Unknown os "${value ?? ""}" (expected ios or android)`);
};

const parseForm = (value: string | undefined): Form => {
  if (value === "phone" || value === "tv") return value;
  throw new UsageError(`Unknown form "${value ?? ""}" (expected phone or tv)`);
};

const requireVariant = (id: string | undefined): Variant => {
  if (!id) {
    throw new UsageError(
      `Missing <variantId> (valid variants: ${validVariantIds()})`,
    );
  }
  const variant = variantById(id);
  if (!variant) {
    throw new UsageError(
      `Unknown variant "${id}" (valid variants: ${validVariantIds()})`,
    );
  }
  return variant;
};

const parseCount = (value: string | undefined, label: string): string => {
  if (value && /^[1-9]\d*$/.test(value)) return value;
  throw new UsageError(
    `Invalid ${label} "${value ?? ""}" (expected a positive integer)`,
  );
};

/**
 * Names a binary built without a fingerprint. It must never contain `-fp-`:
 * every lookup asks for an exact `artifactName`, which always does, so no
 * later run can reuse this binary.
 */
export const fallbackArtifactName = (
  variant: Variant,
  runId: string,
  attempt: string,
): string => `streamyfin-${variant.id}-unhashed-${runId}-${attempt}`;

const computeHash = (
  hashFn: typeof hashFor,
  variant: Variant,
  env: Record<string, string | undefined>,
): string => {
  try {
    return hashFn({ os: variant.os, form: variant.form }, { env });
  } catch (error) {
    throw new MissError(error instanceof Error ? error.message : String(error));
  }
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const parseRepackArgs = (
  args: readonly string[],
): {
  variant: Variant;
  sourcePath: string;
  outputPath: string;
  sentry: boolean;
} => {
  let sentry = false;
  const positionals: string[] = [];

  for (const arg of args) {
    if (arg === "--sentry") {
      sentry = true;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option "${arg}"`);
    } else {
      positionals.push(arg);
    }
  }

  const variant = requireVariant(positionals[0]);
  if (positionals.length !== 3) {
    throw new UsageError(
      "Usage: repack <variantId> <source> <output> [--sentry]",
    );
  }

  return {
    variant,
    sourcePath: positionals[1],
    outputPath: positionals[2],
    sentry,
  };
};

const parseOutputsArgs = (
  args: readonly string[],
): Record<`${Os}-${Form}`, string> => {
  const keyToTarget: Record<string, `${Os}-${Form}`> = {
    ios: "ios-phone",
    tv: "ios-tv",
    android: "android-phone",
    android_tv: "android-tv",
  };
  const parsed: Partial<Record<`${Os}-${Form}`, string>> = {};

  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      throw new UsageError(
        "Usage: outputs ios=<hash> tv=<hash> android=<hash> android_tv=<hash>",
      );
    }
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    const target = keyToTarget[key];
    if (!target || !value || parsed[target] !== undefined) {
      throw new UsageError(
        "Usage: outputs ios=<hash> tv=<hash> android=<hash> android_tv=<hash>",
      );
    }
    parsed[target] = value;
  }

  for (const target of Object.values(keyToTarget)) {
    if (!parsed[target]) {
      throw new UsageError(
        "Usage: outputs ios=<hash> tv=<hash> android=<hash> android_tv=<hash>",
      );
    }
  }

  return parsed as Record<`${Os}-${Form}`, string>;
};

/** Executes the build-cache CLI and returns the process exit code. */
export const runCli = async (
  argv: readonly string[],
  deps: CliDeps = {},
): Promise<number> => {
  const fetchFn = deps.fetchVariant ?? fetchVariant;
  const repackFn = deps.repackVariant ?? repackVariant;
  const pruneFn = deps.prune ?? prune;
  const hashFn = deps.hashFor ?? hashFor;
  const httpFetch = deps.fetch ?? fetch;
  const stdout =
    deps.stdout ??
    ((message: string) => {
      process.stdout.write(message);
    });
  const stderr =
    deps.stderr ??
    ((message: string) => {
      process.stderr.write(message);
    });
  const env = deps.env ?? process.env;

  const [command, ...rest] = argv;

  try {
    switch (command) {
      case "hash": {
        if (rest.length !== 2) {
          throw new UsageError("Usage: hash <os> <form>");
        }
        const os = parseOs(rest[0]);
        const form = parseForm(rest[1]);
        stdout(`${hashFn({ os, form }, { env })}\n`);
        return 0;
      }
      case "name": {
        if (rest.length < 1 || rest.length > 2) {
          throw new UsageError("Usage: name <variantId> [hash]");
        }
        const variant = requireVariant(rest[0]);
        const hash = rest[1] ?? computeHash(hashFn, variant, env);
        stdout(`${artifactName(variant, hash)}\n`);
        return 0;
      }
      case "fallback-name": {
        if (rest.length !== 3) {
          throw new UsageError(
            "Usage: fallback-name <variantId> <runId> <attempt>",
          );
        }
        const variant = requireVariant(rest[0]);
        const runId = parseCount(rest[1], "runId");
        const attempt = parseCount(rest[2], "attempt");
        stdout(`${fallbackArtifactName(variant, runId, attempt)}\n`);
        return 0;
      }
      case "outputs": {
        const hashes = parseOutputsArgs(rest);
        for (const variant of VARIANTS) {
          const hash = hashes[`${variant.os}-${variant.form}`];
          stdout(`${variant.id}_name=${artifactName(variant, hash)}\n`);
        }
        return 0;
      }
      case "fetch": {
        if (rest.length !== 1) {
          throw new UsageError("Usage: fetch <variantId>");
        }
        const variant = requireVariant(rest[0]);
        const hash = computeHash(hashFn, variant, env);
        const result = await fetchFn(variant, hash, { env });
        if (result.path === null) {
          stderr(`${result.reason}\n`);
          return 2;
        }
        stdout(`${result.path}\n`);
        return 0;
      }
      case "repack": {
        const { variant, sourcePath, outputPath, sentry } =
          parseRepackArgs(rest);
        const workingDirectory = mkdtempSync(
          join(tmpdir(), "streamyfin-repack-"),
        );
        try {
          const result = await repackFn(
            {
              variant,
              sourcePath,
              outputPath,
              projectRoot: repoRoot(),
              workingDirectory,
              sentry,
            },
            { env },
          );
          if (result.path === null) {
            stderr(`${result.reason}\n`);
            return 2;
          }
          stdout(`${result.path}\n`);
          return 0;
        } finally {
          try {
            rmSync(workingDirectory, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup of temporary repack working directory.
          }
        }
      }
      case "needs-build": {
        if (rest.length < 1 || rest.length > 2) {
          throw new UsageError("Usage: needs-build <variantId> [hash]");
        }
        const variant = requireVariant(rest[0]);
        const hash = rest[1] ?? computeHash(hashFn, variant, env);
        const name = artifactName(variant, hash);
        const token = env.GITHUB_TOKEN?.trim() ?? "";
        const repository = env.GITHUB_REPOSITORY?.trim() ?? "";
        const repositoryId = Number(env.REPOSITORY_ID);
        if (
          !repository ||
          !token ||
          !env.REPOSITORY_ID?.trim() ||
          !Number.isFinite(repositoryId)
        ) {
          throw new MissError(
            "Missing GITHUB_REPOSITORY, REPOSITORY_ID, or GITHUB_TOKEN",
          );
        }
        try {
          const ctx: RunContext = {
            repositoryId,
            pullRequest: env.PR_HEAD_REF
              ? {
                  headRef: env.PR_HEAD_REF,
                  headRepositoryId: Number(env.PR_HEAD_REPO_ID),
                  commits: await fetchPullRequestCommits(
                    repository,
                    Number(env.PR_NUMBER),
                    token,
                    httpFetch,
                  ),
                }
              : undefined,
          };
          const artifacts = await listArtifacts(
            repository,
            name,
            token,
            httpFetch,
          );
          stdout(needsBuild(artifacts, ctx) ? "build\n" : "skip\n");
          return 0;
        } catch (error) {
          throw new MissError(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      case "prune": {
        if (rest.length !== 0) {
          throw new UsageError("Usage: prune");
        }
        const result = pruneFn({ env });
        stdout(
          `removed ${result.removed.length} entries, freed ${formatBytes(result.freedBytes)}\n`,
        );
        for (const entry of result.skipped) {
          stderr(`${entry.name}: ${entry.code}\n`);
        }
        return result.skipped.length > 0 ? 1 : 0;
      }
      default: {
        throw new UsageError(
          `Unknown command "${command ?? ""}" (expected hash, name, fallback-name, outputs, fetch, repack, needs-build, or prune)`,
        );
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n`);
      return 64;
    }
    if (error instanceof MissError) {
      stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
};

if (require.main === module) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
