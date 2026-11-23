import { type Deps, must, ShotError } from "./core";

/**
 * The pinned Maestro every platform runs through. Upstream Maestro hangs on tvOS
 * (mobile-dev-inc/Maestro#3021 is unmerged), so this is plexinc/Maestro, downloaded into
 * the ignored tools cache with its release checksum verified. The cache is keyed by tag:
 * bumping the pin makes the old binary count as missing. The user's global maestro is
 * never used or touched.
 */
export const MAESTRO_TAG = "cli-2.8.0.6";

export const MAESTRO_SHA256 =
  "fd9abfd350659585e9b317877a38dc159b0dda4bb6c4f081a3f79d3388a90ea3";

export const maestroBinary = (toolsDir: string) =>
  `${toolsDir}/${MAESTRO_TAG}/maestro/bin/maestro`;

export function ensureMaestro(d: Deps, toolsDir: string): string {
  const binary = maestroBinary(toolsDir);
  if (d.fs.exists(binary)) return binary;
  const url = `https://github.com/plexinc/Maestro/releases/download/${MAESTRO_TAG}/maestro.zip`;
  const zip = `${toolsDir}/maestro-${MAESTRO_TAG}.zip`;
  const dest = `${toolsDir}/${MAESTRO_TAG}`;
  d.fs.mkdir(toolsDir);
  must(d.exec(["curl", "-fsSL", url, "-o", zip]), "download maestro");
  const sha = must(
    d.exec(["shasum", "-a", "256", zip]),
    "checksum maestro",
  ).split(/\s+/)[0];
  if (sha !== MAESTRO_SHA256) {
    d.fs.rm(zip);
    throw new ShotError(
      `maestro ${MAESTRO_TAG} checksum mismatch: got ${sha}, want ${MAESTRO_SHA256}`,
    );
  }
  // A half-unpacked earlier attempt must not mix into this one.
  d.fs.rm(dest);
  must(d.exec(["unzip", "-q", zip, "-d", dest]), "unzip maestro");
  must(d.exec(["chmod", "+x", binary]), "chmod maestro");
  d.fs.rm(zip);
  if (!d.fs.exists(binary))
    throw new ShotError(`maestro ${MAESTRO_TAG} unpacked without ${binary}`);
  return binary;
}

/**
 * Copies what the capture passes run into the session, so a git switch cannot change it
 * mid-run. The runner's own source is not copied: it is loaded before the first switch.
 */
export function snapshotTooling(
  d: Deps,
  repo: string,
  sessionDir: string,
): string {
  const tooling = `${sessionDir}/tooling`;
  const suite = `${repo}/e2e/suites/screenshots`;
  d.fs.mkdir(`${tooling}/flows`);
  for (const file of ["compare.ts", "run.sh", "ios-disable-autofill.sh"])
    d.fs.cp(`${suite}/${file}`, `${tooling}/${file}`);
  for (const mask of d.fs
    .list(suite)
    .filter((name) => name.startsWith("masks-")))
    d.fs.cp(`${suite}/${mask}`, `${tooling}/${mask}`);
  for (const flow of d.fs.list(`${suite}/flows`))
    d.fs.cp(`${suite}/flows/${flow}`, `${tooling}/flows/${flow}`);
  d.fs.cp(`${repo}/e2e/bench/maestro.py`, `${tooling}/maestro.py`);
  return tooling;
}

export const DEFAULT_PORT = 18081;

/** Ignored root for sessions, the build cache, and the pinned maestro. */
export const REPORTS_DIR = "e2e/reports/shots";

/**
 * The whole session output must be gitignored, or a report file written under a ref
 * that does not ignore it would block the next `git switch --detach`.
 */
export function ensureOutIgnored(
  d: Deps,
  repo: string,
  sessionDir: string,
): void {
  const rel = sessionDir.startsWith(`${repo}/`)
    ? sessionDir.slice(repo.length + 1)
    : sessionDir;
  const result = d.exec(["git", "check-ignore", "-q", rel], { cwd: repo });
  if (result.code !== 0)
    throw new ShotError(
      `--out ${sessionDir} is not gitignored; screenshot output must never be able to block a ref switch`,
    );
}
