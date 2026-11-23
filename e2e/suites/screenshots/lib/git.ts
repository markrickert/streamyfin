import { type Cli, type Deps, must, ShotError } from "./core";

export interface GitStart {
  /** Branch name when the run starts on a branch, the detached SHA otherwise. */
  ref: string;
  detached: boolean;
}

export function gitStart(d: Deps, repo: string): GitStart {
  const branch = d.exec(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: repo,
  });
  if (branch.code === 0) return { ref: branch.stdout.trim(), detached: false };
  const sha = must(
    d.exec(["git", "rev-parse", "HEAD"], { cwd: repo }),
    "git rev-parse HEAD",
  );
  return { ref: sha, detached: true };
}

export function preflight(
  d: Deps,
  repo: string,
  cli: Cli,
): { beforeSha: string; afterSha: string; start: GitStart } {
  const status = must(
    d.exec(["git", "status", "--porcelain", "--untracked-files=all"], {
      cwd: repo,
    }),
    "git status",
  );
  if (status)
    throw new ShotError(
      "working tree is not clean: commit, stash or move everything before running the comparison",
    );
  const beforeSha = must(
    d.exec(["git", "rev-parse", "--verify", `${cli.before}^{commit}`], {
      cwd: repo,
    }),
    `git rev-parse ${cli.before}`,
  );
  const afterSha = must(
    d.exec(["git", "rev-parse", "--verify", `${cli.after}^{commit}`], {
      cwd: repo,
    }),
    `git rev-parse ${cli.after}`,
  );
  if (beforeSha === afterSha)
    throw new ShotError("--before and --after resolve to the same commit");
  return { beforeSha, afterSha, start: gitStart(d, repo) };
}

export function restoreGit(d: Deps, repo: string, start: GitStart): void {
  const argv = start.detached
    ? ["git", "switch", "--detach", start.ref]
    : ["git", "switch", start.ref];
  if (d.exec(argv, { cwd: repo }).code !== 0)
    throw new ShotError(
      `could not switch back to ${start.ref}; the tree gained new edits — restore it by hand, the runner never force-switches`,
    );
}

const NATIVE_DIRS = ["ios", "android"];

export function backupNativeDirs(
  d: Deps,
  repo: string,
  sessionDir: string,
): string[] {
  const backup = `${sessionDir}/native-backup`;
  const moved: string[] = [];
  for (const dir of NATIVE_DIRS) {
    const path = `${repo}/${dir}`;
    if (d.fs.exists(path)) {
      d.fs.mkdir(backup);
      d.fs.mv(path, `${backup}/${dir}`);
      moved.push(dir);
    }
  }
  return moved;
}

export function restoreNativeDirs(
  d: Deps,
  repo: string,
  sessionDir: string,
  moved: string[],
): void {
  const backup = `${sessionDir}/native-backup`;
  for (const dir of moved) {
    // Whatever prebuild regenerated is runner-owned, but it may have picked up user
    // edits mid-run: move it aside for diagnosis, never delete it.
    const generated = `${repo}/${dir}`;
    if (d.fs.exists(generated)) {
      d.fs.mkdir(`${sessionDir}/native-generated`);
      d.fs.mv(generated, `${sessionDir}/native-generated/${dir}`);
    }
    d.fs.mv(`${backup}/${dir}`, generated);
  }
}

export function lockfileChanged(
  d: Deps,
  repo: string,
  previous: string,
): boolean {
  const marker = "bun.lock\npackage.json\n";
  const current = marker
    .split("\n")
    .filter(Boolean)
    .map((name) =>
      d.fs.exists(`${repo}/${name}`) ? d.fs.read(`${repo}/${name}`) : "",
    )
    .join("\n---\n");
  return current !== previous;
}
