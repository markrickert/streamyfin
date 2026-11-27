/** Shared process execution, result types, and repo-root resolution. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const MAX_PROCESS_BUFFER_BYTES = 128 * 1024 * 1024;
const ROOT = resolve(__dirname, "../..");

interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env: Record<string, string | undefined>;
}

export type RunProcess = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => ProcessResult;

export type BinaryResult =
  | { path: string; reason?: undefined }
  | { path: null; reason: string };

/** Returns the repository root directory. */
export const repoRoot = (): string => ROOT;

/** Spawns a command synchronously and folds any spawn error into stderr. */
export const defaultRun: RunProcess = (command, args, options) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    encoding: "utf8",
    maxBuffer: MAX_PROCESS_BUFFER_BYTES,
  });
  const rawStderr = result.stderr ?? "";
  const errorMessage = result.error?.message;
  const stderr =
    errorMessage && !rawStderr.includes(errorMessage)
      ? [rawStderr, errorMessage].filter((part) => part.length > 0).join("\n")
      : rawStderr;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr,
  };
};
