/**
 * Downloads, verifies, caches, and prunes native build artifacts from GitHub
 * Actions for local developer and e2e runs.
 */
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir as osHomedir, platform as osPlatform } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type FetchLike,
  githubHeaders,
  githubJson,
  listArtifacts,
} from "./github";
import { MS_PER_DAY, pickSource } from "./pick";
import { type BinaryResult, defaultRun, type RunProcess } from "./process";
import { artifactName, type BinaryKind, type Variant } from "./variants";

export type { FetchLike } from "./github";

const DEFAULT_REPO = "streamyfin/streamyfin";
const CACHE_ENTRY_MARKER = ".streamyfin-cache-entry";
const DEFAULT_MAX_CACHE_GB = 10;
const MS_PER_HOUR = 60 * 60 * 1000;
const CACHE_TTL_MS = 7 * MS_PER_DAY;
// Wait 1 hour before reaping .tmp-*/.trash-* so active fetches are not disturbed.
const LEAKED_TEMP_TTL_MS = 1 * MS_PER_HOUR;
const BYTES_PER_GB = 1024 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchDeps {
  cacheDir?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  homedir?: () => string;
  now?: () => number;
  platform?: () => NodeJS.Platform;
  repositoryId?: number;
  run?: RunProcess;
  stderr?: (message: string) => void;
}

export interface PruneSkippedEntry {
  name: string;
  code: string;
}

export interface PruneResult {
  removed: string[];
  remainingBytes: number;
  freedBytes: number;
  skipped: PruneSkippedEntry[];
}

const errorCode = (error: unknown): string | undefined => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
};

const firstStackFrame = (error: unknown): string | null => {
  if (!(error instanceof Error) || !error.stack) return null;
  for (const rawLine of error.stack.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("at ") || /^[^@\s]+@.+:\d+/.test(line)) {
      return line;
    }
  }
  return null;
};

const formatFailure = (step: string, error: unknown): string => {
  const code = errorCode(error);
  const message =
    error instanceof Error
      ? error.name && error.name !== "Error"
        ? `${error.name}: ${error.message}`
        : error.message
      : String(error);
  if (code) {
    return `${step} failed (${code}): ${message}`;
  }
  const frame = firstStackFrame(error);
  return frame
    ? `${step} failed: ${message} (${frame})`
    : `${step} failed: ${message}`;
};

const safeRm = (target: string) => {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; prune() reaps leaked .tmp-*/.trash-* entries later.
  }
};

/** Resolves the native build cache directory for the current platform. */
export const resolveCacheDir = (deps: FetchDeps = {}): string => {
  if (deps.cacheDir) return deps.cacheDir;
  const env = deps.env ?? process.env;
  const override = env.STREAMYFIN_BUILD_CACHE_DIR?.trim();
  if (override) return override;

  const home = (deps.homedir ?? osHomedir)();
  const platform = (deps.platform ?? osPlatform)();
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "streamyfin-native");
  }
  const xdg = env.XDG_CACHE_HOME?.trim() || join(home, ".cache");
  return join(xdg, "streamyfin-native");
};

const resolveToken = (
  env: Record<string, string | undefined>,
  run: RunProcess,
): string | null => {
  const envToken = env.GITHUB_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    const gh = run("gh", ["auth", "token"], { env });
    if (gh.status === 0 && gh.stdout.trim().length > 0) {
      return gh.stdout.trim();
    }
  } catch {
    return null;
  }
  return null;
};

const downloadArtifact = async (
  fetchFn: FetchLike,
  url: string,
  token: string,
  name: string,
): Promise<{ ok: true; data: Response } | { ok: false; reason: string }> => {
  let response = await fetchFn(url, {
    headers: githubHeaders(token),
    redirect: "manual",
  });

  if (REDIRECT_STATUSES.has(response.status)) {
    const location = response.headers.get("location");
    void response.body?.cancel().catch(() => {});
    if (!location) {
      return {
        ok: false,
        reason: `GitHub returned ${response.status} without Location downloading ${name}`,
      };
    }
    const targetUrl = new URL(location, url).toString();
    // Omit Authorization on the redirect target so GitHub tokens never leak to blob storage.
    response = await fetchFn(targetUrl, { redirect: "follow" });
  }

  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    return {
      ok: false,
      reason: `GitHub returned ${response.status} downloading ${name}`,
    };
  }

  if (!response.body) {
    return {
      ok: false,
      reason: `Download failed for ${name}: empty response body`,
    };
  }

  return { ok: true, data: response };
};

const isUnsafeArchivePath = (entry: string): boolean => {
  if (
    entry.startsWith("/") ||
    entry.startsWith("\\") ||
    /^[A-Za-z]:/.test(entry)
  ) {
    return true;
  }
  return entry.split(/[/\\]+/).some((segment) => segment === "..");
};

const validateArchiveEntries = (stdout: string): string | null => {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const entry = rawLine.trim();
    if (!entry) continue;
    if (isUnsafeArchivePath(entry)) {
      return entry;
    }
  }
  return null;
};

const isOutsideRoot = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

const validateExtractedTree = (rootDir: string): string | null => {
  const resolvedRoot = resolve(rootDir);
  let realRoot: string | null = null;

  const walk = (current: string): string | null => {
    for (const entryName of readdirSync(current)) {
      const fullPath = join(current, entryName);
      const stat = lstatSync(fullPath);

      if (stat.isSymbolicLink()) {
        const target = readlinkSync(fullPath);
        if (
          isAbsolute(target) ||
          target.startsWith("\\") ||
          /^[A-Za-z]:/.test(target)
        ) {
          return `Rejected unsafe symlink: ${fullPath} -> ${target}`;
        }
        const resolvedTarget = resolve(dirname(fullPath), target);
        if (isOutsideRoot(resolvedRoot, resolvedTarget)) {
          return `Rejected unsafe symlink: ${fullPath} -> ${target}`;
        }
        if (existsSync(fullPath)) {
          realRoot ??= realpathSync(resolvedRoot);
          try {
            const realTarget = realpathSync(fullPath);
            if (isOutsideRoot(realRoot, realTarget)) {
              return `Rejected unsafe symlink: ${fullPath} -> ${target}`;
            }
          } catch {
            return `Rejected unresolvable symlink: ${fullPath} -> ${target}`;
          }
        }
        continue;
      }

      if (stat.isDirectory()) {
        const nested = walk(fullPath);
        if (nested) return nested;
        continue;
      }

      if (stat.nlink > 1) {
        return `Rejected hard-link entry: ${fullPath}`;
      }
    }
    return null;
  };

  return walk(resolvedRoot);
};

const findMatchingBinaries = (dir: string, kind: BinaryKind): string[] => {
  const matches: string[] = [];
  const suffix = `.${kind}`;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (kind === "app") {
        if (entry.isDirectory() && entry.name.endsWith(suffix)) {
          matches.push(fullPath);
          continue;
        }
        if (entry.isDirectory()) walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        matches.push(fullPath);
      } else if (entry.isDirectory()) {
        walk(fullPath);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return matches;
};

const findTarArchives = (dir: string): string[] => {
  const matches: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (
        entry.isFile() &&
        (entry.name.endsWith(".tar") ||
          entry.name.endsWith(".tar.gz") ||
          entry.name.endsWith(".tgz"))
      ) {
        matches.push(fullPath);
      } else if (entry.isDirectory()) {
        walk(fullPath);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return matches;
};

const touchEntry = (entryDir: string, nowMs: number) => {
  try {
    const seconds = nowMs / 1000;
    utimesSync(entryDir, seconds, seconds);
  } catch {
    // Best-effort: updating atime/mtime must not turn a cache hit into a miss.
  }
};

const directorySize = (dir: string): number => {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }

  let total = 0;
  for (const entry of dirents) {
    const fullPath = join(dir, entry.name);
    try {
      const stat = lstatSync(fullPath);
      total += stat.isDirectory() ? directorySize(fullPath) : stat.size;
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
  }
  return total;
};

const extractZip = (
  run: RunProcess,
  env: Record<string, string | undefined>,
  zipPath: string,
  tempDir: string,
  name: string,
): { ok: true; dir: string } | { ok: false; reason: string } => {
  const zipList = run("unzip", ["-Z1", zipPath], { env });
  if (zipList.status !== 0) {
    return {
      ok: false,
      reason: `Failed to inspect zip archive for ${name}`,
    };
  }
  const unsafeZipEntry = validateArchiveEntries(zipList.stdout);
  if (unsafeZipEntry) {
    return {
      ok: false,
      reason: `Rejected unsafe zip entry: ${unsafeZipEntry}`,
    };
  }

  const extractDir = join(tempDir, "unzipped");
  mkdirSync(extractDir, { recursive: true });
  const unzipResult = run("unzip", ["-q", zipPath, "-d", extractDir], { env });
  if (unzipResult.status !== 0) {
    return {
      ok: false,
      reason: `Failed to extract zip archive for ${name}`,
    };
  }
  const unsafeExtracted = validateExtractedTree(extractDir);
  if (unsafeExtracted) {
    return { ok: false, reason: unsafeExtracted };
  }
  return { ok: true, dir: extractDir };
};

const extractTar = (
  run: RunProcess,
  env: Record<string, string | undefined>,
  extractDir: string,
  tempDir: string,
  name: string,
): { ok: true; dir: string } | { ok: false; reason: string } => {
  const tars = findTarArchives(extractDir);
  if (tars.length !== 1) {
    return {
      ok: false,
      reason: `Expected 1 tar archive for ${name}, found ${tars.length}`,
    };
  }
  const tarPath = tars[0];
  const tarList = run("tar", ["-tf", tarPath], { env });
  if (tarList.status !== 0) {
    return {
      ok: false,
      reason: `Failed to inspect tar archive for ${name}`,
    };
  }
  const unsafeTarEntry = validateArchiveEntries(tarList.stdout);
  if (unsafeTarEntry) {
    return {
      ok: false,
      reason: `Rejected unsafe tar entry: ${unsafeTarEntry}`,
    };
  }

  const untarDir = join(tempDir, "untarred");
  mkdirSync(untarDir, { recursive: true });
  const untarResult = run("tar", ["-xf", tarPath, "-C", untarDir], { env });
  if (untarResult.status !== 0) {
    return {
      ok: false,
      reason: `Failed to extract tar archive for ${name}`,
    };
  }
  const unsafeUntarred = validateExtractedTree(untarDir);
  if (unsafeUntarred) {
    return { ok: false, reason: unsafeUntarred };
  }
  return { ok: true, dir: untarDir };
};

const installCacheEntry = (
  stagingDir: string,
  entryDir: string,
  cacheDir: string,
  name: string,
  binaryName: string,
  kind: BinaryKind,
  nowMs: number,
): BinaryResult => {
  try {
    renameSync(stagingDir, entryDir);
    touchEntry(entryDir, nowMs);
    return { path: join(entryDir, binaryName) };
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }

  // Another fetch won the race (or left an invalid dir). Never rmSync a live entry.
  const existing = findMatchingBinaries(entryDir, kind);
  if (existing.length === 1) {
    touchEntry(entryDir, nowMs);
    return { path: existing[0] };
  }

  const trashDir = join(cacheDir, `.trash-${name}-${randomUUID()}`);
  try {
    renameSync(entryDir, trashDir);
    renameSync(stagingDir, entryDir);
    touchEntry(entryDir, nowMs);
    return { path: join(entryDir, binaryName) };
  } finally {
    safeRm(trashDir);
  }
};

/**
 * Returns the local path to a cached or freshly downloaded native binary, or
 * `{ path: null, reason }` on any miss without throwing.
 */
export const fetchVariant = async (
  variant: Variant,
  hash: string,
  deps: FetchDeps = {},
): Promise<BinaryResult> => {
  const env = deps.env ?? process.env;
  const stderr =
    deps.stderr ??
    ((message: string) => {
      process.stderr.write(message);
    });
  let step = "fetch variant";

  try {
    const run = deps.run ?? defaultRun;
    const fetchFn = deps.fetch ?? fetch;
    const now = deps.now ?? Date.now;
    const cacheDir = resolveCacheDir(deps);
    const name = artifactName(variant, hash);
    // Namespace by repository so the same variant and fingerprint fetched
    // from a fork never collides with the upstream binary.
    const repo = env.STREAMYFIN_BUILD_CACHE_REPO?.trim() || DEFAULT_REPO;
    const repoSlug = repo.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
    const entryName = `${repoSlug}--${name}`;
    const entryDir = join(cacheDir, entryName);

    step = "read cache entry";
    try {
      if (existsSync(entryDir)) {
        const cached = findMatchingBinaries(entryDir, variant.kind);
        if (cached.length === 1) {
          touchEntry(entryDir, now());
          return { path: cached[0] };
        }
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }

    step = "fetch variant";
    const token = resolveToken(env, run);
    if (!token) {
      return {
        path: null,
        reason: "No GitHub token (set GITHUB_TOKEN or run gh auth login)",
      };
    }

    let repositoryId = deps.repositoryId;
    if (repositoryId === undefined) {
      const repoData = await githubJson<{ id: number }>(
        `https://api.github.com/repos/${repo}`,
        token,
        fetchFn,
      );
      repositoryId = repoData.id;
    }

    const listed = await listArtifacts(repo, name, token, fetchFn);
    const picked = pickSource(listed, { repositoryId }, "local");
    if (!picked) {
      return {
        path: null,
        reason: `No cached ${variant.id} artifact for fingerprint ${hash}`,
      };
    }

    step = "download artifact";
    const downloadUrl =
      picked.archive_download_url ??
      `https://api.github.com/repos/${repo}/actions/artifacts/${picked.id}/zip`;
    const downloaded = await downloadArtifact(
      fetchFn,
      downloadUrl,
      token,
      name,
    );
    if (!downloaded.ok) {
      return { path: null, reason: downloaded.reason };
    }

    step = "create temp directory";
    let tempDir: string;
    try {
      mkdirSync(cacheDir, { recursive: true });
      tempDir = join(cacheDir, `.tmp-${name}-${randomUUID()}`);
      mkdirSync(tempDir, { recursive: true });
    } catch (error) {
      void downloaded.data.body?.cancel().catch(() => {});
      throw error;
    }

    try {
      step = "stream download";
      const zipPath = join(tempDir, "artifact.zip");
      await pipeline(
        Readable.fromWeb(
          downloaded.data.body as unknown as Parameters<
            typeof Readable.fromWeb
          >[0],
        ),
        createWriteStream(zipPath),
      );

      step = "extract zip";
      const extracted = extractZip(run, env, zipPath, tempDir, name);
      if (!extracted.ok) {
        return { path: null, reason: extracted.reason };
      }

      let sourceDir = extracted.dir;
      if (variant.kind === "app") {
        step = "extract tar";
        const untarred = extractTar(run, env, extracted.dir, tempDir, name);
        if (!untarred.ok) {
          return { path: null, reason: untarred.reason };
        }
        sourceDir = untarred.dir;
      }

      step = "stage binary";
      const matches = findMatchingBinaries(sourceDir, variant.kind);
      if (matches.length !== 1) {
        return {
          path: null,
          reason: `Expected 1 .${variant.kind} in ${name}, found ${matches.length}`,
        };
      }
      if (variant.kind === "app") {
        // A symlink escaping the .app bundle would break once the temp
        // siblings it points at are cleaned up.
        step = "validate app bundle";
        const unsafeAppEntry = validateExtractedTree(matches[0]);
        if (unsafeAppEntry) {
          return { path: null, reason: unsafeAppEntry };
        }
      }

      const stagingDir = join(tempDir, "staged");
      mkdirSync(stagingDir, { recursive: true });
      const binaryName = basename(matches[0]);
      renameSync(matches[0], join(stagingDir, binaryName));
      touchEntry(stagingDir, now());

      writeFileSync(join(stagingDir, CACHE_ENTRY_MARKER), "");

      step = "install cache entry";
      return installCacheEntry(
        stagingDir,
        entryDir,
        cacheDir,
        name,
        binaryName,
        variant.kind,
        now(),
      );
    } finally {
      safeRm(tempDir);
    }
  } catch (error) {
    if (env.STREAMYFIN_BUILD_CACHE_DEBUG === "1") {
      const stack =
        error instanceof Error ? (error.stack ?? String(error)) : String(error);
      stderr(`${stack}\n`);
    }
    return { path: null, reason: formatFailure(step, error) };
  }
};

const removePruneEntry = (
  entryPath: string,
  entryName: string,
  removed: string[],
  skipped: PruneSkippedEntry[],
): "removed" | "missing" | "failed" => {
  try {
    rmSync(entryPath, { recursive: true, force: true });
    removed.push(entryName);
    return "removed";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return "missing";
    skipped.push({ name: entryName, code: code ?? "UNKNOWN" });
    return "failed";
  }
};

/**
 * Removes leaked `.tmp-*` / `.trash-*` directories older than 1 hour, removes
 * cache entries not accessed for 7 days, and evicts the least-recently-accessed
 * entries until total size fits `STREAMYFIN_BUILD_CACHE_MAX_GB`.
 */
export const prune = (deps: FetchDeps = {}): PruneResult => {
  const cacheDir = resolveCacheDir(deps);
  if (!existsSync(cacheDir)) {
    return { removed: [], remainingBytes: 0, freedBytes: 0, skipped: [] };
  }

  let topLevelDirents: Dirent[];
  try {
    topLevelDirents = readdirSync(cacheDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { removed: [], remainingBytes: 0, freedBytes: 0, skipped: [] };
    }
    throw error;
  }

  const env = deps.env ?? process.env;
  const nowMs = (deps.now ?? Date.now)();
  const rawMaxGb = env.STREAMYFIN_BUILD_CACHE_MAX_GB?.trim();
  const maxGbRaw = rawMaxGb ? Number(rawMaxGb) : Number.NaN;
  const maxGb =
    Number.isFinite(maxGbRaw) && maxGbRaw >= 0
      ? maxGbRaw
      : DEFAULT_MAX_CACHE_GB;
  const maxBytes = maxGb * BYTES_PER_GB;

  const removed: string[] = [];
  const skipped: PruneSkippedEntry[] = [];
  let freedBytes = 0;
  const entries: Array<{
    name: string;
    path: string;
    atimeMs: number;
    size: number;
  }> = [];

  for (const dirent of topLevelDirents) {
    if (!dirent.isDirectory()) continue;
    const entryName = dirent.name;
    const entryPath = join(cacheDir, entryName);

    let stat: Stats;
    let size = 0;
    try {
      stat = statSync(entryPath);
      if (entryName.startsWith(".tmp-") || entryName.startsWith(".trash-")) {
        if (nowMs - stat.mtimeMs > LEAKED_TEMP_TTL_MS) {
          size = directorySize(entryPath);
          if (
            removePruneEntry(entryPath, entryName, removed, skipped) ===
            "removed"
          ) {
            freedBytes += size;
          }
        }
        continue;
      }
      // A shared cache dir may hold directories this cache never wrote;
      // only entries carrying the marker (or a build-cache name from before
      // the marker existed) are ours to prune.
      const owned =
        existsSync(join(entryPath, CACHE_ENTRY_MARKER)) ||
        /^(?:[a-z0-9._-]+--)?streamyfin-/.test(entryName);
      if (!owned) continue;
      size = directorySize(entryPath);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") continue;
      skipped.push({ name: entryName, code: code ?? "UNKNOWN" });
      continue;
    }

    entries.push({
      name: entryName,
      path: entryPath,
      atimeMs: stat.atimeMs,
      size,
    });
  }

  const live: typeof entries = [];
  let unremovableBytes = 0;

  for (const entry of entries) {
    if (nowMs - entry.atimeMs > CACHE_TTL_MS) {
      const outcome = removePruneEntry(
        entry.path,
        entry.name,
        removed,
        skipped,
      );
      if (outcome === "removed") {
        freedBytes += entry.size;
      } else if (outcome === "failed") {
        unremovableBytes += entry.size;
      }
    } else {
      live.push(entry);
    }
  }

  live.sort((a, b) => a.atimeMs - b.atimeMs);
  let remainingBytes =
    unremovableBytes + live.reduce((sum, entry) => sum + entry.size, 0);

  for (const entry of live) {
    if (remainingBytes <= maxBytes) break;
    const outcome = removePruneEntry(entry.path, entry.name, removed, skipped);
    if (outcome !== "failed") {
      remainingBytes -= entry.size;
    }
    if (outcome === "removed") {
      freedBytes += entry.size;
    }
  }

  return { removed, remainingBytes, freedBytes, skipped };
};
