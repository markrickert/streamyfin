export const PLATFORMS = ["ios", "android", "android-tv", "apple-tv"] as const;

export type Platform = (typeof PLATFORMS)[number];

export interface Cli {
  command: "doctor" | "run";
  /** doctor only: bring up what the runner itself would, instead of only reporting. */
  fix?: boolean;
  platform?: Platform;
  before?: string;
  after?: string;
  device?: string;
  outDir?: string;
  port?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnHandle {
  kill(): void;
  /** False once the child exited — a live /status after that is a foreign packager. */
  isAlive(): boolean;
}

export interface FsOps {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, data: string): void;
  mkdir(path: string): void;
  cp(src: string, dst: string): void;
  mv(src: string, dst: string): void;
  rm(path: string): void;
  list(path: string): string[];
}

export interface Deps {
  exec(
    argv: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeoutMs?: number;
    },
  ): ExecResult;
  spawn(
    argv: string[],
    opts?: { cwd?: string; env?: Record<string, string | undefined> },
  ): SpawnHandle;
  waitFor(url: string, needle: string, timeoutMs: number): Promise<boolean>;
  fs: FsOps;
  env: Record<string, string | undefined>;
  log(message: string): void;
}

export class ShotError extends Error {}

/** How a device reaches this Mac: the Android emulator's alias for the host loopback, or the loopback itself. */
export const hostFor = (platform: Platform) =>
  platform === "android" || platform === "android-tv"
    ? "10.0.2.2"
    : "127.0.0.1";

export function must(result: ExecResult, what: string): string {
  if (result.code !== 0)
    throw new ShotError(
      `${what} failed (${result.code}): ${result.stderr.trim()}`,
    );
  return result.stdout.trim();
}

/** must() for flows: Maestro stderr can echo -e values, so secrets are masked first. */
export function mustSanitized(
  result: ExecResult,
  what: string,
  secrets: string[],
): string {
  if (result.code !== 0) {
    let stderr = result.stderr.trim().slice(0, 500);
    for (const secret of new Set(secrets))
      if (secret) stderr = stderr.split(secret).join("***");
    throw new ShotError(`${what} failed (${result.code}): ${stderr}`);
  }
  return result.stdout.trim();
}
