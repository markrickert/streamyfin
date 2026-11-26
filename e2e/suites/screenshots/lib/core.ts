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
    opts?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      logFile?: string;
    },
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

/** must() for flows: Maestro prints errors to stdout and may echo -e values, so secrets are masked first. */
export function mustSanitized(
  result: ExecResult,
  what: string,
  secrets: string[],
): string {
  if (result.code !== 0) {
    const mask = (text: string) => {
      let out = text;
      for (const secret of new Set(secrets))
        if (secret) out = out.split(secret).join("***");
      return out;
    };
    const stderr = mask(result.stderr.trim()).slice(-500);
    const stdout = mask(result.stdout.trim()).slice(-500);
    const detail = [stderr, stdout].filter(Boolean).join("\n");
    throw new ShotError(`${what} failed (${result.code}): ${detail}`);
  }
  return result.stdout.trim();
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
}
