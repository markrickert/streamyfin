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
 * on `develop`, on the current branch for branch pushes and manual dispatches,
 * or on one of this same-repository pull request's commits. A pull request
 * must not use another pull request's build: anyone can open a fork PR and
 * name an artifact after any fingerprint. A fork PR cannot use its own
 * earlier builds either: one commit could upload a binary under the next
 * commit's fingerprint, leaving a binary no reviewed diff contains. A branch
 * name does not identify a pull request, so a run counts as this pull
 * request's only when its head commit is one of the pull request's commits.
 */
import { appendFileSync } from "node:fs";
import { fetchPullRequestCommits, listArtifacts } from "../build-cache/github";
import {
  type Artifact,
  currentBranchFromEnv,
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
 * Branch runs also read `GITHUB_EVENT_NAME`, `GITHUB_REF_TYPE`, and `GITHUB_REF_NAME`.
 */
const main = async () => {
  const env = process.env;
  const token = env.GITHUB_TOKEN ?? "";
  const repository = env.GITHUB_REPOSITORY ?? "";
  const ctx: RunContext = {
    repositoryId: Number(env.REPOSITORY_ID),
    currentBranch: currentBranchFromEnv(env),
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
