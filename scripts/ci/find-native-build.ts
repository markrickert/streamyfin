/**
 * Finds an earlier CI build whose native binary this run can repack instead of
 * rebuilding on macOS.
 *
 * `build-apps.yml` names each iOS artifact after the `@expo/fingerprint` hash of
 * the native project, so an artifact with the same name holds a binary built
 * from the same native code. This script looks those names up and prints, for
 * each one, the run to download it from, or nothing when no build is usable.
 *
 * A repacked binary keeps the native code of the build it came from, so only a
 * build this run would trust with its own native code may be a source: a run
 * on `develop` in this repository, or an earlier run of the same pull request
 * when that pull request comes from this repository. A binary from another
 * pull request must never be used, because anyone can open one from a fork and
 * name an artifact after any fingerprint. A fork pull request's own builds are
 * left out too: its runs follow its own copy of the workflow, so one commit
 * could upload any binary under the next commit's fingerprint and the next
 * revert that, leaving a binary no reviewed diff contains. A branch name does
 * not identify a pull request — a closed one's branch can be reused — so a run
 * counts as this pull request's only when its head commit is one of the pull
 * request's commits.
 */
import { appendFileSync } from "node:fs";
import { fetchPullRequestCommits, listArtifacts } from "../build-cache/github";
import {
  type Artifact,
  pickSource,
  type RunContext,
  TRUSTED_BRANCH,
} from "../build-cache/pick";

export { type Artifact, pickSource, type RunContext, TRUSTED_BRANCH };

/**
 * Usage: `bun scripts/ci/find-native-build.ts <output>=<artifact name> ...`
 *
 * Writes `<output>=<run id>` to `$GITHUB_OUTPUT` for each pair, with an empty
 * run id when no build is usable. Reads `GITHUB_TOKEN`, `GITHUB_REPOSITORY`,
 * `REPOSITORY_ID`, and on a pull request `PR_NUMBER`, `PR_HEAD_REF` and
 * `PR_HEAD_REPO_ID`.
 */
const main = async () => {
  const env = process.env;
  const token = env.GITHUB_TOKEN ?? "";
  const repository = env.GITHUB_REPOSITORY ?? "";
  const ctx: RunContext = {
    repositoryId: Number(env.REPOSITORY_ID),
    pullRequest: env.PR_HEAD_REF
      ? {
          headRef: env.PR_HEAD_REF,
          headRepositoryId: Number(env.PR_HEAD_REPO_ID),
          commits: await fetchPullRequestCommits(
            repository,
            Number(env.PR_NUMBER),
            token,
          ),
        }
      : undefined,
  };
  for (const pair of process.argv.slice(2)) {
    const [output, name] = pair.split("=");
    const source = pickSource(
      await listArtifacts(repository, name, token),
      ctx,
    );
    const runId = source ? String(source.workflow_run.id) : "";
    console.log(
      `${name}: ${source ? `run ${runId} (${source.workflow_run.head_branch})` : "none, full build"}`,
    );
    if (env.GITHUB_OUTPUT)
      appendFileSync(env.GITHUB_OUTPUT, `${output}=${runId}\n`);
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
