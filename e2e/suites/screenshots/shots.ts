#!/usr/bin/env bun
/**
 * Dev-mode screenshot comparison on this checkout.
 *
 *   bun e2e/suites/screenshots/shots.ts doctor [--fix] [--platform <ios|android|android-tv|apple-tv>]
 *   bun e2e/suites/screenshots/shots.ts run --platform <p> [--before <ref>] [--after <ref>] [--device <id>] [--out <dir>] [--port <port>]
 *   bun e2e/suites/screenshots/shots.ts build --platform <p> [--before <ref>] [--after <ref>] [--abi <abi>] [--out <dir>]
 *   bun e2e/suites/screenshots/shots.ts maestro-path
 *
 * --before defaults to the base the Reassure baseline uses: this branch's PR target, else
 * develop, looked up on upstream before origin. --after defaults to HEAD.
 *
 * See e2e/suites/screenshots/README.md for the full contract. Requires a clean tree and
 * the local SyncPlay+Seerr fixture; restores the starting ref and native dirs on exit.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { resolveBaseRef } from "../../../scripts/reassure-baseline";
import {
  buildNative,
  type Deps,
  doctor,
  type ExecResult,
  ensureMaestro,
  interruptCleanup,
  parseArgs,
  REPORTS_DIR,
  runComparison,
  ShotError,
} from "./shots-lib";

const repo = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

const deps: Deps = {
  exec(argv, opts): ExecResult {
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: opts?.cwd ?? repo,
      env: { ...process.env, ...opts?.env },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr || result.error?.message || "",
    };
  },
  spawn(argv, opts) {
    const logFd = opts?.logFile ? fs.openSync(opts.logFile, "a") : undefined;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts?.cwd ?? repo,
      env: { ...process.env, ...opts?.env },
      stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
      detached: false,
    });
    if (logFd !== undefined) fs.closeSync(logFd);
    return {
      kill: () => child.kill("SIGTERM"),
      isAlive: () => child.exitCode === null && child.signalCode === null,
    };
  },
  async waitFor(url, needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const text = await fetch(url).then((res) => res.text());
        if (text.includes(needle)) return true;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  },
  fs: {
    exists: (path) => fs.existsSync(path),
    read: (path) => fs.readFileSync(path, "utf8"),
    write: (path, data) => fs.writeFileSync(path, data),
    mkdir: (path) => fs.mkdirSync(path, { recursive: true }),
    cp: (src, dst) => fs.cpSync(src, dst, { recursive: true }),
    mv: (src, dst) => fs.renameSync(src, dst),
    rm: (path) => fs.rmSync(path, { recursive: true, force: true }),
    list: (path) => fs.readdirSync(path),
  },
  env: process.env,
  log: (message) => console.log(message),
};

// SIGINT/SIGTERM while a comparison holds live state: restore ref and native dirs.
// `let` export — read it inside the handler, not at module load.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    try {
      interruptCleanup?.();
    } finally {
      process.exit(130);
    }
  });

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.command === "maestro-path") {
    console.log(ensureMaestro(deps, `${repo}/${REPORTS_DIR}/tools`));
    return;
  }
  if (cli.command === "doctor") {
    const report = doctor(deps, cli, repo);
    for (const check of report.checks) console.log(`• ${check}`);
    if (!report.ok) process.exit(1);
    return;
  }
  cli.before = resolveBaseRef(cli.before);
  if (cli.command === "build") {
    console.log(
      `Building ${cli.platform} dev clients at ${cli.before} and ${cli.after}.`,
    );
    const report = buildNative(deps, cli, repo);
    console.log(
      `done: ${report.sessionDir}/build-cache.json (restored ${report.restored.ref})`,
    );
    return;
  }
  console.log(`Comparing ${cli.after} against ${cli.before}.`);
  const report = await runComparison(deps, cli, repo);
  console.log(
    `done: ${report.sessionDir}/report (restored ${report.restored.ref})`,
  );
}

main().catch((error) => {
  if (error instanceof ShotError) {
    console.error(`shots: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
