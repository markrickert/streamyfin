/**
 * Selects trusted GitHub Actions artifacts for CI repacks, local fetches, and
 * CI ensure-variant freshness checks.
 */

/** The branch whose builds every pull request and merge queue entry may reuse. */
export const TRUSTED_BRANCH = "develop";

/**
 * Minimum remaining lifetime required for an ensure variant. A binary is never
 * re-uploaded, so one near expiry must be rebuilt before it disappears.
 */
const ENSURE_MIN_REMAINING_DAYS = 14;

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ENSURE_MIN_REMAINING_MS = ENSURE_MIN_REMAINING_DAYS * MS_PER_DAY;

export interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  expires_at?: string;
  archive_download_url?: string;
  workflow_run: {
    id: number;
    head_branch: string;
    head_repository_id: number;
    head_sha: string;
    repository_id: number;
  };
}

export interface RunContext {
  repositoryId: number;
  /**
   * Set on a `pull_request` run: the branch and repository it comes from, and
   * the commit SHAs `/pulls/{number}/commits` reports for it.
   */
  pullRequest?: {
    headRef: string;
    headRepositoryId: number;
    commits: ReadonlySet<string>;
  };
}

type PickPolicy = "ci" | "local";

const isFromThisPullRequest = (artifact: Artifact, ctx: RunContext) =>
  ctx.pullRequest !== undefined &&
  ctx.pullRequest.headRepositoryId === ctx.repositoryId &&
  artifact.workflow_run.head_branch === ctx.pullRequest.headRef &&
  artifact.workflow_run.head_repository_id ===
    ctx.pullRequest.headRepositoryId &&
  ctx.pullRequest.commits.has(artifact.workflow_run.head_sha);

const isFromTrustedBranch = (artifact: Artifact, ctx: RunContext) =>
  artifact.workflow_run.head_branch === TRUSTED_BRANCH &&
  artifact.workflow_run.head_repository_id === ctx.repositoryId;

const isSameRepo = (artifact: Artifact, ctx: RunContext) =>
  artifact.workflow_run.repository_id === ctx.repositoryId &&
  artifact.workflow_run.head_repository_id === ctx.repositoryId;

/**
 * Picks a usable artifact under the given policy.
 * - `ci`: the newest from this pull request, else the newest from `develop`.
 * - `local`: the newest non-expired artifact from any branch in this repo.
 * Fork artifacts are rejected under both policies.
 */
export const pickSource = (
  artifacts: Artifact[],
  ctx: RunContext,
  policy: PickPolicy = "ci",
): Artifact | undefined => {
  const usable = artifacts
    .filter((a) => !a.expired && isSameRepo(a, ctx))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (policy === "local") {
    return usable[0];
  }
  return (
    usable.find((a) => isFromThisPullRequest(a, ctx)) ??
    usable.find((a) => isFromTrustedBranch(a, ctx))
  );
};

/**
 * Returns true when CI must build an ensure variant because no trusted
 * non-expired artifact exists or the newest one expires within 14 days.
 */
export const needsBuild = (
  artifacts: Artifact[],
  ctx: RunContext,
  now: Date | number = Date.now(),
): boolean => {
  const source = pickSource(artifacts, ctx, "ci");
  if (!source?.expires_at) {
    return true;
  }
  const expiresAtMs = Date.parse(source.expires_at);
  if (Number.isNaN(expiresAtMs)) {
    return true;
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  return expiresAtMs - nowMs < ENSURE_MIN_REMAINING_MS;
};
